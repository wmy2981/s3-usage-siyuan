/**
 * 腾讯云 COS：云监控 GetMonitorData（Namespace=QCE/COS）。
 *
 * COS 自身没有单桶用量 HTTP 接口，单桶容量/对象数/流量/请求数都在云监控里，
 * 维度是 appid + bucket，Region 固定填 ap-guangzhou（与桶实际地域无关）。
 * 存储类指标单位是 MB，这里统一换算成字节；对象数和请求数是「个/次」。
 */
import {signTc3} from "../sign/tencent-tc3";
import {asNumber, jsonPath} from "../xml";
import {cosAppId, requireAccessKey, requireSecretKey} from "./helpers";
import {MONITOR_WINDOW_MS, sumDefined} from "./monitoring";
import type {ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

const MONITOR_URL = "https://monitor.tencentcloudapi.com/";
const MONITOR_REGION = "ap-guangzhou";
const MB = 1024 * 1024;
const METRIC_PERIOD = 3600;
const WINDOW_MS = 48 * 60 * 60 * 1000;

interface MetricSpec {
    metric: string;
    key: string;
    name: string;
    objectMetric?: string;
    scale?: number;
}

const STORAGE_SPECS: MetricSpec[] = [
    {metric: "StdStorage", key: "standard", name: "STANDARD", objectMetric: "StdObjectNumber", scale: MB},
    {metric: "SiaStorage", key: "ia", name: "STANDARD_IA", objectMetric: "IaObjectNumber", scale: MB},
    {metric: "NelStorage", key: "line", name: "NEARLINE", objectMetric: "NlObjectNumber", scale: MB},
    {metric: "ArcStorage", key: "archive", name: "ARCHIVE", objectMetric: "ArcObjectNumber", scale: MB},
    {metric: "DeepArcStorage", key: "deepArchive", name: "DEEP_ARCHIVE", objectMetric: "DeepArcObjectNumber", scale: MB},
];

interface MetricPoint {
    value?: number;
    timestamp?: number;
}

function latestPoint(payload: unknown): MetricPoint {
    const dataPoints = jsonPath(payload, "Response", "DataPoints");
    if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
        return {};
    }
    let best: MetricPoint = {};
    for (const point of dataPoints) {
        const timestamps = jsonPath(point, "Timestamps");
        const values = jsonPath(point, "Values");
        if (!Array.isArray(timestamps) || !Array.isArray(values)) {
            continue;
        }
        for (let index = 0; index < timestamps.length; index++) {
            const timestamp = asNumber(timestamps[index]);
            const value = asNumber(values[index]);
            if (timestamp === undefined || value === undefined) {
                continue;
            }
            if (best.timestamp === undefined || timestamp > best.timestamp) {
                best = {timestamp, value};
            }
        }
    }
    return best;
}

/** 把一个时间窗口内的全部数据点求和；流量与请求数用这个口径。 */
export function summedCosPoint(payload: unknown): MetricPoint {
    const dataPoints = jsonPath(payload, "Response", "DataPoints");
    if (!Array.isArray(dataPoints)) {
        return {};
    }
    const values: (number | undefined)[] = [];
    let timestamp = 0;
    for (const point of dataPoints) {
        const timestamps = jsonPath(point, "Timestamps");
        const points = jsonPath(point, "Values");
        if (!Array.isArray(points)) {
            continue;
        }
        for (let index = 0; index < points.length; index++) {
            const value = asNumber(points[index]);
            if (value === undefined) {
                continue;
            }
            values.push(value);
            const time = Array.isArray(timestamps) ? asNumber(timestamps[index]) : undefined;
            if (time !== undefined && time > timestamp) {
                timestamp = time;
            }
        }
    }
    const total = sumDefined(values);
    return total === undefined ? {} : {value: total, timestamp: timestamp > 0 ? timestamp : undefined};
}

function errorOf(payload: unknown): string {
    const error = jsonPath(payload, "Response", "Error");
    if (!error || typeof error !== "object") {
        return "";
    }
    const code = jsonPath(error, "Code");
    const message = jsonPath(error, "Message");
    return [code, message].filter((item) => typeof item === "string" && item !== "").join(": ");
}

async function getMetric(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    metric: string,
    bucket: string,
    appId: string,
    options: {windowMs?: number; sum?: boolean} = {},
): Promise<MetricPoint> {
    const end = new Date();
    const start = new Date(end.getTime() - (options.windowMs ?? WINDOW_MS));
    const payload = JSON.stringify({
        Namespace: "QCE/COS",
        MetricName: metric,
        Period: METRIC_PERIOD,
        Instances: [{
            Dimensions: [
                {Name: "appid", Value: appId},
                {Name: "bucket", Value: bucket},
            ],
        }],
        StartTime: start.toISOString(),
        EndTime: end.toISOString(),
    });
    const headers = await signTc3({
        url: MONITOR_URL,
        payload,
        service: "monitor",
        region: MONITOR_REGION,
        secretId: requireAccessKey(ctx.source),
        secretKey: requireSecretKey(ctx.source),
        action: "GetMonitorData",
        version: "2018-07-24",
    });
    const response = await ctx.request({
        url: MONITOR_URL,
        method: "POST",
        headers,
        body: payload,
        contentType: "application/json; charset=utf-8",
    });
    const parsed = (() => {
        try {
            return JSON.parse(response.body) as unknown;
        } catch {
            return undefined;
        }
    })();
    if (response.status !== 200) {
        throw new ProviderError(errorOf(parsed) || response.body.slice(0, 300) || `HTTP ${response.status}`);
    }
    const message = errorOf(parsed);
    if (message !== "") {
        throw new ProviderError(message);
    }
    return options.sum === true ? summedCosPoint(parsed) : latestPoint(parsed);
}

/** 并发上限：腾讯云默认 50 次/秒，这里压到 4 条并发，避免一个桶就把额度打满。 */
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

export const tencentCos: ProviderDefinition = {
    id: "tencentCos",
    labelKey: "providerTencentCos",
    docsUrl: "https://cloud.tencent.com/document/product/248/45140",
    endpointRequired: false,
    regionRequired: true,
    accountIdRequired: false,
    accessKeyLabelKey: "providerTencentCosToken",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query(ctx) {
        // 地域只影响桶的归属，云监控请求固定走广州；这里校验地域只是防止用户漏填桶名后缀
        if (ctx.source.region.trim() === "" && !/-\d+$/.test(ctx.bucket)) {
            throw new ProviderError("Region is required");
        }
        const appId = cosAppId(ctx.source, ctx.bucket);
        const storagePoints = await mapLimit(STORAGE_SPECS, 4, (spec) => getMetric(ctx, spec.metric, ctx.bucket, appId));
        const objectPoints = await mapLimit(
            STORAGE_SPECS.filter((spec) => spec.objectMetric),
            4,
            (spec) => getMetric(ctx, spec.objectMetric ?? "", ctx.bucket, appId),
        );
        const [multipart, inbound, outbound, requests] = await mapLimit(
            [
                {metric: "StdMultipartNumber", sum: false},
                {metric: "InboundTraffic", sum: true},
                {metric: "InternetTraffic", sum: true},
                {metric: "TotalRequests", sum: true},
            ],
            4,
            (spec) => getMetric(ctx, spec.metric, ctx.bucket, appId, {
                sum: spec.sum,
                windowMs: spec.sum ? MONITOR_WINDOW_MS : undefined,
            }),
        );

        const classes: StorageClassUsage[] = [];
        let storageBytes = 0;
        let objectCount = 0;
        let hasStorage = false;
        let hasObjects = false;
        let dataTime = 0;
        STORAGE_SPECS.forEach((spec, index) => {
            const storage = storagePoints[index];
            const objects = objectPoints[index];
            const scaled = storage.value === undefined ? undefined : storage.value * (spec.scale ?? 1);
            if (scaled !== undefined) {
                storageBytes += scaled;
                hasStorage = true;
                dataTime = Math.max(dataTime, (storage.timestamp ?? 0) * 1000);
            }
            if (objects.value !== undefined) {
                objectCount += objects.value;
                hasObjects = true;
                dataTime = Math.max(dataTime, (objects.timestamp ?? 0) * 1000);
            }
            if ((scaled ?? 0) > 0 || (objects.value ?? 0) > 0) {
                classes.push({
                    key: spec.key,
                    name: spec.name,
                    storageBytes: scaled,
                    objectCount: objects.value,
                });
            }
        });
        const notes = ["noteCosDelay"];
        if (inbound.value !== undefined || outbound.value !== undefined || requests.value !== undefined) {
            notes.push("noteMetricsWindow");
        }
        return {
            storageBytes: hasStorage ? storageBytes : undefined,
            objectCount: hasObjects ? objectCount : undefined,
            multipartCount: multipart.value,
            trafficInBytes: inbound.value,
            trafficOutBytes: outbound.value,
            requestCount: requests.value,
            storageClasses: classes,
            dataTime: dataTime > 0 ? dataTime : undefined,
            notes,
        };
    },
};

export {latestPoint as latestCosPoint};
