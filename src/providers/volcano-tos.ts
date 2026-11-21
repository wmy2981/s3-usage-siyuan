/**
 * 火山引擎 TOS：GetBucketStat（`GET /?stat`）。
 *
 * 使用 TOS4-HMAC-SHA256：与 AWS SigV4 同构，但签名密钥起点是裸 SK（没有 `AWS4` 前缀），
 * scope 终止串是 `request`，Authorization 的逗号后不带空格。子资源 `?stat` 必须出现在
 * CanonicalQueryString 里写成 `stat=`，否则签名对不上。
 */
import {mapLimit} from "../async";
import {detailedErrorText, requestSection} from "../diagnostics";
import {signAwsV4} from "../sign/aws-v4";
import {virtualHostBucketUrl} from "../sign/oss-v1";
import {asNumber, jsonPath} from "../xml";
import {requireAccessKey, requireEndpoint, requireRegion, requireSecretKey, providerError} from "./helpers";
import {MONITOR_WINDOW_MS, sumDefined, withMetrics} from "./monitoring";
import type {BucketUsage, ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

const CM_VERSION = "2018-01-01";
const CM_PERIOD = "1h";
const HOUR_SECONDS = 3600;
const MB = 1024 * 1024;
// 桶维度只有 ResourceID（即桶名），流量是带宽（MB/s）、请求是各 API 的 QPS，
// 都要按周期积分成总量；指标名取自云监控 VCM_TOS 的指标清单。
const BANDWIDTH_METRICS = {in: "InternetUploadBandwidthV2", out: "InternetDownloadBandwidthV2"};
const QPS_METRICS = [
    "GetObjectQps",
    "PutObjectQps",
    "ListObjectsQps",
    "UploadPartQps",
    "DeleteObjectQps",
    "PostObjectQps",
    "DeleteObjectsQps",
];

/** 取一个存储统计节点；TOS 的 `Storage` 是字符串，统一走 asNumber。 */
function statEntry(value: unknown): {storageBytes?: number; objectCount?: number} | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    return {
        storageBytes: asNumber(jsonPath(value, "Storage")),
        objectCount: asNumber(jsonPath(value, "ObjectCount")),
    };
}

/**
 * `GET /?stat` 返回的是 **JSON**（没有根节点包装），字段与官方 Go SDK 的
 * `GetBucketStatOutput` 一一对应：Storage 是字符串，对象数是数字。
 */
function parseTosStat(body: string): BucketUsage {
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new ProviderError(`Unexpected TOS response: not JSON\nResponse body:\n${body}`);
    }
    if (!payload || typeof payload !== "object") {
        throw new ProviderError(`Unexpected TOS response: empty body\nResponse body:\n${body}`);
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, ...nodePath: string[]) => {
        const entry = statEntry(jsonPath(payload, ...nodePath));
        if (!entry) {
            return;
        }
        if ((entry.storageBytes ?? 0) > 0 || (entry.objectCount ?? 0) > 0) {
            classes.push({key, name, ...entry});
        }
    };
    addClass("standard", "STANDARD", "StandardStorageStat");
    addClass("ia", "IA", "IAStorageStat");
    addClass("archiveFr", "ARCHIVE_FR", "ArchiveFrStorageStat");
    addClass("archive", "ARCHIVE", "ArchiveStorageStat");
    addClass("coldArchive", "COLD_ARCHIVE", "ColdArchiveStorageStat");
    addClass("deepArchive", "DEEP_COLD_ARCHIVE", "DeepColdArchiveStorageStat");
    addClass("intelligentFa", "INTELLIGENT_TIERING_FA", "IntelligentTieringStorageStats", "HighFreqStorageStat");
    addClass("intelligentIa", "INTELLIGENT_TIERING_IA", "IntelligentTieringStorageStats", "LowFreqStorageStat");
    addClass("intelligentArchive", "INTELLIGENT_TIERING_ARCHIVE", "IntelligentTieringStorageStats", "ArchiveFrStorageStat");
    const total = statEntry(jsonPath(payload, "TotalStorageStat"));
    return {
        storageBytes: total?.storageBytes ??
            classes.reduce((sum, item) => sum + (item.storageBytes ?? 0), 0),
        objectCount: total?.objectCount ??
            classes.reduce((sum, item) => sum + (item.objectCount ?? 0), 0),
        storageClasses: classes,
        notes: ["noteTosDelay"],
    };
}

/** 云监控返回 `Result.Data.MetricDataResults[].DataPoints[].Value`。 */
export function parseVolcanoPoints(payload: unknown): number[] {
    const results = jsonPath(payload, "Result", "Data", "MetricDataResults");
    if (!Array.isArray(results)) {
        return [];
    }
    const values: number[] = [];
    for (const result of results) {
        const points = jsonPath(result, "DataPoints");
        if (!Array.isArray(points)) {
            continue;
        }
        for (const point of points) {
            const value = asNumber(jsonPath(point, "Value"));
            if (value !== undefined) {
                values.push(value);
            }
        }
    }
    return values;
}

/** 查一个 VCM_TOS 指标，返回最近 24 小时按小时聚合的原始值。 */
async function cmSeries(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    subNamespace: string,
    metricName: string,
): Promise<number[]> {
    const region = requireRegion(ctx.source);
    const end = Math.floor(Date.now() / 1000);
    const start = end - MONITOR_WINDOW_MS / 1000;
    const url = `https://cloudmonitor.${region}.volcengineapi.com?Action=GetMetricData&Version=${CM_VERSION}`;
    const body = JSON.stringify({
        Namespace: "VCM_TOS",
        SubNamespace: subNamespace,
        MetricName: metricName,
        Period: CM_PERIOD,
        StartTime: start,
        EndTime: end,
        StatisticsMethods: "avg",
        Instances: [{Dimensions: [{Name: "ResourceID", Value: ctx.bucket}]}],
    });
    const headers = await signAwsV4({
        method: "POST",
        url,
        headers: {"content-type": "application/json"},
        payload: body,
        service: "cloudmonitor",
        region,
        accessKey: requireAccessKey(ctx.source),
        secretKey: requireSecretKey(ctx.source),
        algorithm: "HMAC-SHA256",
        dateHeader: "x-date",
        // 官方 SDK（volc-sdk-golang base/sign.go）对每个请求都写入并签名 X-Content-Sha256，
        // 省掉这个头会让 SignedHeaders 与官方签名机制不一致
        payloadHeader: "x-content-sha256",
        keyPrefix: "",
        terminal: "request",
    });
    const response = await ctx.request({
        url,
        method: "POST",
        headers,
        body,
        contentType: "application/json",
    });
    if (response.status !== 200) {
        throw providerError(response);
    }
    let payload: unknown;
    try {
        payload = JSON.parse(response.body);
    } catch {
        throw new ProviderError(`Unexpected CloudMonitor response: not JSON\nResponse body:\n${response.body}` +
            requestSection(response));
    }
    const error = jsonPath(payload, "ResponseMetadata", "Error");
    if (error) {
        throw new ProviderError(`${String(jsonPath(error, "Message") ?? "CloudMonitor query failed")}\nResponse body:\n${response.body}` +
            requestSection(response));
    }
    return parseVolcanoPoints(payload);
}

/** 流量与请求数：带宽（MB/s）与 QPS 都按周期积分成 24 小时总量。 */
async function queryTraffic(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    errors: string[],
): Promise<{trafficInBytes?: number; trafficOutBytes?: number; requestCount?: number}> {
    const [outgoing, incoming] = await mapLimit(
        [BANDWIDTH_METRICS.out, BANDWIDTH_METRICS.in],
        2,
        (metric) => cmSeries(ctx, "bandwidth", metric),
    );
    // 单个 API 的指标可能因版本差异不存在，缺哪个就少算哪个，不让整次查询失败。
    // 云监控按秒限流，7 个 QPS 指标压到 4 条并发；失败原因汇总成一条说明，逐条细节跟在后面。
    let requestsFailed = false;
    const rates = await mapLimit(QPS_METRICS, 4, async (name) => {
        try {
            return await cmSeries(ctx, "qps", name);
        } catch (error) {
            if (!requestsFailed) {
                requestsFailed = true;
                errors.push("noteMetricsFailed");
            }
            errors.push(`Metric ${name}: ${detailedErrorText(error)}`);
            return [];
        }
    });
    const requestCount = sumDefined(rates.flat().map((rate) => rate * HOUR_SECONDS));
    return {
        trafficOutBytes: sumDefined(outgoing.map((rate) => rate * HOUR_SECONDS * MB)),
        trafficInBytes: sumDefined(incoming.map((rate) => rate * HOUR_SECONDS * MB)),
        requestCount,
    };
}

export const volcanoTos: ProviderDefinition = {
    id: "volcanoTos",
    async query(ctx) {
        const {source, bucket, request} = ctx;
        const endpoint = requireEndpoint(source);
        const region = requireRegion(source);
        const url = virtualHostBucketUrl(endpoint, bucket, "stat");
        const headers = await signAwsV4({
            method: "GET",
            url,
            headers: {"content-type": "application/json"},
            payload: "",
            service: "tos",
            region,
            accessKey: requireAccessKey(source),
            secretKey: requireSecretKey(source),
            algorithm: "TOS4-HMAC-SHA256",
            dateHeader: "x-tos-date",
            payloadHeader: "x-tos-content-sha256",
            keyPrefix: "",
            terminal: "request",
            authorizationStyle: "tos",
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
        const usage = parseTosStat(response.body);
        const notes = ["noteTosDelay"];
        const errors: string[] = [];
        const metrics = await withMetrics(() => queryTraffic(ctx, errors), errors);
        if (metrics.trafficInBytes !== undefined || metrics.trafficOutBytes !== undefined || metrics.requestCount !== undefined) {
            notes.push("noteMetricsWindow", "noteVolcDerived");
        }
        return {...usage, ...metrics, notes, errors};
    },
};

export {parseTosStat};
