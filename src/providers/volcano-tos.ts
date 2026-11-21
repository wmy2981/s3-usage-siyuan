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
import {asNumber, jsonPath, numberAt, parseXml, recordAt} from "../xml";
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

function parseTosStat(body: string): BucketUsage {
    const root = recordAt(parseXml(body), "BucketStat");
    if (!root) {
        throw new ProviderError(`Unexpected TOS response: missing BucketStat\nResponse body:\n${body}`);
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, nodeName: string) => {
        const node = recordAt(root, nodeName);
        const storageBytes = numberAt(node, "Storage");
        const objectCount = numberAt(node, "ObjectCount");
        if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
            classes.push({key, name, storageBytes, objectCount});
        }
    };
    addClass("standard", "STANDARD", "StandardStorageStat");
    addClass("ia", "IA", "IAStorageStat");
    addClass("archive", "ARCHIVE", "ArchiveStorageStat");
    addClass("coldArchive", "COLD_ARCHIVE", "ColdArchiveStorageStat");
    addClass("deepArchive", "DEEP_COLD_ARCHIVE", "DeepColdArchiveStorageStat");
    const intelligent = recordAt(root, "IntelligentTieringStorageStats");
    if (intelligent) {
        const addIntelligent = (key: string, name: string, nodeName: string) => {
            const node = recordAt(intelligent, nodeName);
            const storageBytes = numberAt(node, "Storage");
            const objectCount = numberAt(node, "ObjectCount");
            if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
                classes.push({key, name, storageBytes, objectCount});
            }
        };
        addIntelligent("intelligentFa", "INTELLIGENT_TIERING_FA", "HighFreqStorageStat");
        addIntelligent("intelligentIa", "INTELLIGENT_TIERING_IA", "LowFreqStorageStat");
        addIntelligent("intelligentArchive", "INTELLIGENT_TIERING_ARCHIVE", "ArchiveFrStorageStat");
    }
    const total = recordAt(root, "TotalStorageStat");
    return {
        storageBytes: numberAt(total, "Storage") ??
            classes.reduce((sum, item) => sum + (item.storageBytes ?? 0), 0),
        objectCount: numberAt(total, "ObjectCount") ??
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
        // 官方示例只签 host、x-date（以及显式传入的 content-type），不额外写 payload 哈希头
        payloadHeader: null,
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
