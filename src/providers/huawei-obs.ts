/**
 * 华为云 OBS：GetBucketStorageInfo（`GET /?storageinfo`）+ 云监控 CES。
 *
 * 用量接口只给容量与对象数，流量与请求数在 CES 的 `SYS.OBS` 命名空间里：
 * - 流量类（`download_traffic` / `upload_traffic`）是「统计周期内总和」，单位 Byte；
 * - 请求类只有每秒速率（`request_count_per_second`），要乘以周期秒数换算成次数。
 *
 * CES 走 API 网关，签名是 `SDK-HMAC-SHA256`（见 sign/huawei-sdk.ts），且 URL 里必须带
 * 项目 ID：华为没有「仅用 AK/SK 换取项目 ID」的接口，只能由用户在控制台复制。
 */
import {regionFromEndpoint} from "../config";
import {requestSection} from "../diagnostics";
import {signHuaweiSdk, huaweiUrl} from "../sign/huawei-sdk";
import {signObsV2, virtualHostBucketUrl} from "../sign/oss-v1";
import {asNumber, jsonPath, numberAt, parseXml, recordAt} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import {MONITOR_WINDOW_MS, sumDefined, withMetrics} from "./monitoring";
import type {BucketUsage, ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

const CES_PERIOD_SECONDS = 3600;

function parseStorageInfo(body: string): BucketUsage {
    const root = recordAt(parseXml(body), "GetBucketStorageInfoResult");
    if (!root) {
        throw new ProviderError(`Unexpected OBS response: missing GetBucketStorageInfoResult\nResponse body:\n${body}`);
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, storageKey: string, objectKey: string) => {
        const storageBytes = numberAt(root, storageKey);
        const objectCount = numberAt(root, objectKey);
        if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
            classes.push({key, name, storageBytes, objectCount});
        }
    };
    addClass("standard", "STANDARD", "StandardSize", "StandardObjectNumber");
    addClass("ia", "WARM", "WarmSize", "WarmObjectNumber");
    addClass("archive", "COLD", "ColdSize", "ColdObjectNumber");
    addClass("deepArchive", "DEEP_ARCHIVE", "DeepArchiveSize", "DeepArchiveObjectNumber");

    return {
        storageBytes: numberAt(root, "Size"),
        objectCount: numberAt(root, "ObjectNumber"),
        storageClasses: classes,
        notes: ["noteObsDelay"],
    };
}

/** CES 数据点里 average / max / min / sum 同时存在，按需要的统计字段取。 */
export function parseCesDatapoints(payload: unknown, field: "average" | "sum"): number[] {
    const datapoints = jsonPath(payload, "datapoints");
    if (!Array.isArray(datapoints)) {
        return [];
    }
    const values: number[] = [];
    for (const point of datapoints) {
        // 只认请求的统计字段：拿 average 冒充 sum 会把总量缩小一个数量级
        const value = asNumber(jsonPath(point, field));
        if (value !== undefined) {
            values.push(value);
        }
    }
    return values;
}

async function cesSeries(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    projectId: string,
    region: string,
    metric: string,
    filter: "sum" | "average",
): Promise<number[]> {
    const end = Date.now();
    const start = end - MONITOR_WINDOW_MS;
    const url = huaweiUrl(`https://ces.${region}.myhuaweicloud.com/V1.0/${projectId}/metric-data`, {
        namespace: "SYS.OBS",
        metric_name: metric,
        "dim.0": `bucket_name,${ctx.bucket}`,
        from: String(start),
        to: String(end),
        period: String(CES_PERIOD_SECONDS),
        filter,
    });
    const headers = await signHuaweiSdk({
        method: "GET",
        url,
        // 转发层一定会写 Content-Type，按官方示例把它一起签进去
        headers: {"content-type": "application/json"},
        payload: "",
        accessKey: requireAccessKey(ctx.source),
        secretKey: requireSecretKey(ctx.source),
    });
    const response = await ctx.request({url, method: "GET", headers, contentType: "application/json"});
    if (response.status !== 200) {
        throw providerError(response);
    }
    let payload: unknown;
    try {
        payload = JSON.parse(response.body);
    } catch {
        throw new ProviderError(`Unexpected CES response: not JSON\nResponse body:\n${response.body}` +
            requestSection(response));
    }
    return parseCesDatapoints(payload, filter);
}

export const huaweiObs: ProviderDefinition = {
    id: "huaweiObs",
    async query(ctx) {
        const {source, bucket, request} = ctx;
        const endpoint = requireEndpoint(source);
        const url = virtualHostBucketUrl(endpoint, bucket, "storageinfo");
        const headers = await signObsV2({
            method: "GET",
            url,
            bucket,
            subresource: "storageinfo",
            accessKey: requireAccessKey(source),
            secretKey: requireSecretKey(source),
            contentType: "application/json",
        });
        const response = await request({
            url,
            method: "GET",
            headers,
            contentType: "application/json",
        });
        if (response.status !== 200) {
            throw providerError(response);
        }
        const usage = parseStorageInfo(response.body);
        const notes = ["noteObsDelay"];
        const errors: string[] = [];
        const projectId = source.accountId.trim();
        const region = source.region.trim() || regionFromEndpoint(endpoint, "huaweiObs");
        if (projectId === "" || region === "") {
            notes.push("noteObsProjectId");
            return {...usage, notes, errors};
        }
        const metrics = await withMetrics(async () => {
            const [outgoing, incoming, rates] = await Promise.all([
                cesSeries(ctx, projectId, region, "download_traffic", "sum"),
                cesSeries(ctx, projectId, region, "upload_traffic", "sum"),
                cesSeries(ctx, projectId, region, "request_count_per_second", "average"),
            ]);
            // 速率类指标按周期积分成次数：每秒平均请求数 × 3600 秒
            const requestCount = rates.length === 0
                ? undefined
                : sumDefined(rates.map((rate) => rate * CES_PERIOD_SECONDS));
            return {
                trafficOutBytes: sumDefined(outgoing),
                trafficInBytes: sumDefined(incoming),
                requestCount,
            };
        }, errors);
        if (metrics.trafficInBytes !== undefined || metrics.trafficOutBytes !== undefined || metrics.requestCount !== undefined) {
            notes.push("noteMetricsWindow");
        }
        if (metrics.requestCount !== undefined) {
            notes.push("noteObsRate");
        }
        return {...usage, ...metrics, notes, errors};
    },
};

export {parseStorageInfo as parseObsStorageInfo};
