/**
 * 七牛云 Kodo：数据统计接口族（`/v6/space`、`/v6/count` 等）。
 *
 * 管理 API 的签名是 HMAC-SHA1，待签串包含方法、路径、原始 query、Host、Content-Type、
 * 全部 X-Qiniu-* 头，末尾恒定两个换行；签名结果用 URL-safe base64（保留 `=`）。
 * query 必须与实际 URL 字节一致，不能重排或二次编码。
 */
import {mapLimit} from "../async";
import {hmac, toBase64, utf8} from "../sign/util";
import {asNumber, jsonPath} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import {MONITOR_WINDOW_MS, sumDefined, withMetrics} from "./monitoring";
import type {ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

const DEFAULT_ENDPOINT = "https://api.qiniuapi.com";
const CONTENT_TYPE = "application/x-www-form-urlencoded";

interface StatSpec {
    path: string;
    key: string;
    name: string;
    kind: "storage" | "count";
}

const SPECS: StatSpec[] = [
    {path: "/v6/space", key: "standard", name: "STANDARD", kind: "storage"},
    {path: "/v6/count", key: "standard", name: "STANDARD", kind: "count"},
    {path: "/v6/space_line", key: "line", name: "LINE", kind: "storage"},
    {path: "/v6/count_line", key: "line", name: "LINE", kind: "count"},
    {path: "/v6/space_archive", key: "archive", name: "ARCHIVE", kind: "storage"},
    {path: "/v6/count_archive", key: "archive", name: "ARCHIVE", kind: "count"},
    {path: "/v6/space_deep_archive", key: "deepArchive", name: "DEEP_ARCHIVE", kind: "storage"},
    {path: "/v6/count_deep_archive", key: "deepArchive", name: "DEEP_ARCHIVE", kind: "count"},
    // 官方统计接口里还有归档直读与智能分层两套存储类（数据统计接口文档）
    {path: "/v6/space_archive_ir", key: "archiveIr", name: "ARCHIVE_IR", kind: "storage"},
    {path: "/v6/count_archive_ir", key: "archiveIr", name: "ARCHIVE_IR", kind: "count"},
    {path: "/v6/space_intelligent_tiering", key: "intelligent", name: "INTELLIGENT_TIERING", kind: "storage"},
    {path: "/v6/count_intelligent_tiering", key: "intelligent", name: "INTELLIGENT_TIERING", kind: "count"},
];

/** 七牛的 begin/end 是东八区的 14 位时间串，不能直接拿本机时区格式化。 */
export function qiniuTime(date: Date): string {
    const beijing = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${beijing.getUTCFullYear()}${pad(beijing.getUTCMonth() + 1)}${pad(beijing.getUTCDate())}` +
        `${pad(beijing.getUTCHours())}${pad(beijing.getUTCMinutes())}${pad(beijing.getUTCSeconds())}`;
}

/** 管理 API 的签名串；query 必须与 URL 中的原始字符串完全一致。 */
export function qiniuSigningString(
    method: string,
    path: string,
    query: string,
    host: string,
    contentType: string,
    date: string,
): string {
    const queryPart = query === "" ? "" : `?${query}`;
    return `${method.toUpperCase()} ${path}${queryPart}\n` +
        `Host: ${host}\n` +
        `Content-Type: ${contentType}\n` +
        `X-Qiniu-Date: ${date}\n\n`;
}

export async function qiniuAuthorization(
    accessKey: string,
    secretKey: string,
    signingString: string,
): Promise<string> {
    const signature = toBase64(await hmac("SHA-1", utf8(secretKey), signingString));
    const encoded = signature.replaceAll("+", "-").replaceAll("/", "_");
    return `Qiniu ${accessKey}:${encoded}`;
}

interface StatValue {
    value?: number;
    timestamp?: number;
}

function latestValue(body: string): StatValue {
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new ProviderError(`Unexpected Qiniu response: not JSON\nResponse body:\n${body}`);
    }
    const times = jsonPath(payload, "times");
    const datas = jsonPath(payload, "datas");
    if (!Array.isArray(times) || !Array.isArray(datas)) {
        throw new ProviderError(`Unexpected Qiniu response: missing times/datas\nResponse body:\n${body}`);
    }
    let latest: StatValue = {};
    for (let index = 0; index < Math.min(times.length, datas.length); index++) {
        const timestamp = asNumber(times[index]);
        const value = asNumber(datas[index]);
        if (timestamp === undefined || value === undefined) {
            continue;
        }
        if (latest.timestamp === undefined || timestamp > latest.timestamp) {
            latest = {timestamp, value};
        }
    }
    return latest;
}

function endpointFor(source: Parameters<ProviderDefinition["query"]>[0]["source"]): string {
    if (source.endpoint.trim() !== "") {
        // 自定义 Endpoint 走与其他服务商一致的归一化：表单允许只填裸 host，
        // 原样拼进 URL 会让 new URL() 直接抛 TypeError
        return requireEndpoint(source);
    }
    if (source.region === "ap-southeast-2") {
        return "https://api-ap-southeast-2.qiniuapi.com";
    }
    if (source.region === "ap-southeast-3") {
        return "https://api-ap-southeast-3.qiniuapi.com";
    }
    return DEFAULT_ENDPOINT;
}

/** 发一次数据统计请求并返回原始响应体；签名覆盖最终 URL 的原始 query。 */
async function requestQiniu(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    path: string,
    params: URLSearchParams,
    endpoint: string,
): Promise<string> {
    const url = `${endpoint}${path}?${params.toString()}`;
    const parsed = new URL(url);
    const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const authorization = await qiniuAuthorization(
        requireAccessKey(ctx.source),
        requireSecretKey(ctx.source),
        qiniuSigningString("GET", parsed.pathname, parsed.search.replace(/^\?/, ""), parsed.host, CONTENT_TYPE, date),
    );
    const response = await ctx.request({
        url,
        method: "GET",
        headers: {
            "X-Qiniu-Date": date,
            Authorization: authorization,
        },
        contentType: CONTENT_TYPE,
    });
    if (response.status !== 200) {
        throw providerError(response);
    }
    return response.body;
}

async function queryStat(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    spec: StatSpec,
    endpoint: string,
): Promise<StatValue> {
    const begin = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
        bucket: ctx.bucket,
        begin: qiniuTime(begin),
        end: qiniuTime(end),
        g: "day",
    });
    if (ctx.source.region.trim() !== "") {
        params.set("region", ctx.source.region.trim());
    }
    return latestValue(await requestQiniu(ctx, spec.path, params, endpoint));
}

/**
 * 流量/请求数接口（blob_io、rs_put）返回的是数组：`[{time, values:{flow|hits}}]`。
 * 这里把窗口内所有点求和；同时兼容旧版 `{times, datas}` 形态，避免版本差异导致解析失败。
 */
export function sumQiniuSeries(body: string, field: string): number | undefined {
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new ProviderError(`Unexpected Qiniu response: not JSON\nResponse body:\n${body}`);
    }
    if (Array.isArray(payload)) {
        return sumDefined(payload.map((row) => asNumber(jsonPath(row, "values", field))));
    }
    const datas = jsonPath(payload, "datas");
    if (Array.isArray(datas)) {
        return sumDefined(datas.map((value) => asNumber(value)));
    }
    return undefined;
}

/** 流量与请求数：外网流出流量 + GET/PUT 请求次数，均为最近 24 小时合计。 */
async function queryTraffic(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    endpoint: string,
): Promise<{trafficOutBytes?: number; requestCount?: number}> {
    const begin = qiniuTime(new Date(Date.now() - MONITOR_WINDOW_MS));
    const end = qiniuTime(new Date());
    const region = ctx.source.region.trim();
    const call = async (path: string, select: string, metric: string | undefined, field: string) => {
        const params = new URLSearchParams({begin, end, g: "hour", select});
        if (metric !== undefined) {
            params.set("$metric", metric);
        }
        params.set("$bucket", ctx.bucket);
        if (region !== "") {
            params.set("$region", region);
        }
        return sumQiniuSeries(await requestQiniu(ctx, path, params, endpoint), field);
    };
    const [outflow, getHits, putHits] = await mapLimit(
        [
            {path: "/v6/blob_io", select: "flow", metric: "flow_out", field: "flow"},
            {path: "/v6/blob_io", select: "hits", metric: "hits", field: "hits"},
            {path: "/v6/rs_put", select: "hits", metric: undefined, field: "hits"},
        ],
        3,
        (spec) => call(spec.path, spec.select, spec.metric, spec.field),
    );
    return {trafficOutBytes: outflow, requestCount: sumDefined([getHits, putHits])};
}

export const qiniuKodo: ProviderDefinition = {
    id: "qiniuKodo",
    async query(ctx) {
        const endpoint = endpointFor(ctx.source);
        const notes = ["noteQiniuDelay"];
        const errors: string[] = [];
        const [values, metrics] = await Promise.all([
            mapLimit(SPECS, 4, (spec) => queryStat(ctx, spec, endpoint)),
            withMetrics(() => queryTraffic(ctx, endpoint), errors),
        ]);
        const classes = new Map<string, StorageClassUsage>();
        let storageBytes = 0;
        let objectCount = 0;
        let hasStorage = false;
        let hasObjects = false;
        let dataTime = 0;
        SPECS.forEach((spec, index) => {
            const point = values[index];
            if (point.value === undefined) {
                return;
            }
            dataTime = Math.max(dataTime, (point.timestamp ?? 0) * 1000);
            const entry = classes.get(spec.key) ?? {key: spec.key, name: spec.name};
            if (spec.kind === "storage") {
                storageBytes += point.value;
                hasStorage = true;
                entry.storageBytes = point.value;
            } else {
                objectCount += point.value;
                hasObjects = true;
                entry.objectCount = point.value;
            }
            classes.set(spec.key, entry);
        });
        if (metrics.trafficOutBytes !== undefined || metrics.requestCount !== undefined) {
            notes.push("noteMetricsWindow");
        }
        if (metrics.requestCount !== undefined) {
            notes.push("noteQiniuRequests");
        }
        return {
            storageBytes: hasStorage ? storageBytes : undefined,
            objectCount: hasObjects ? objectCount : undefined,
            trafficOutBytes: metrics.trafficOutBytes,
            requestCount: metrics.requestCount,
            storageClasses: [...classes.values()].filter((item) =>
                (item.storageBytes ?? 0) > 0 || (item.objectCount ?? 0) > 0
            ),
            dataTime: dataTime > 0 ? dataTime : undefined,
            notes,
            errors,
        };
    },
};

export {latestValue as latestQiniuValue};
