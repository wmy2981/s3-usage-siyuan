/**
 * 阿里云 OSS：GetBucketStat（`GET /?stat`）。
 *
 * 返回桶总存储量、对象数、未完成分片与各存储类型明细；使用 OSS V1 签名。
 * 官方明确统计非实时，延时可能超过 1 小时；低频/归档的 Storage 是计费口径。
 */
import {regionFromEndpoint} from "../config";
import {aliyunRpcUrl} from "../sign/aliyun-rpc";
import {signV2, virtualHostBucketUrl} from "../sign/oss-v1";
import {signOssV4} from "../sign/oss-v4";
import {asNumber, jsonPath, numberAt, parseXml, recordAt} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import {MONITOR_WINDOW_MS, sumDefined, withMetrics} from "./monitoring";
import type {BucketUsage, ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

function parseStat(body: string): BucketUsage {
    const root = recordAt(parseXml(body), "BucketStat");
    if (!root) {
        throw new ProviderError("Unexpected OSS response: missing BucketStat");
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, storageKey: string, objectKey: string) => {
        const storageBytes = numberAt(root, storageKey);
        const objectCount = numberAt(root, objectKey);
        if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
            classes.push({key, name, storageBytes, objectCount});
        }
    };
    addClass("standard", "StandardStorage", "StandardStorage", "StandardObjectCount");
    addClass("ia", "InfrequentAccessStorage", "InfrequentAccessStorage", "InfrequentAccessObjectCount");
    addClass("archive", "ArchiveStorage", "ArchiveStorage", "ArchiveObjectCount");
    addClass("coldArchive", "ColdArchiveStorage", "ColdArchiveStorage", "ColdArchiveObjectCount");
    addClass("deepArchive", "DeepColdArchiveStorage", "DeepColdArchiveStorage", "DeepColdArchiveObjectCount");

    const storageBytes = numberAt(root, "Storage") ?? classes.reduce((sum, item) => sum + (item.storageBytes ?? 0), 0);
    const objectCount = numberAt(root, "ObjectCount") ?? classes.reduce((sum, item) => sum + (item.objectCount ?? 0), 0);
    const lastModified = numberAt(root, "LastModifiedTime");
    return {
        storageBytes,
        objectCount,
        multipartCount: numberAt(root, "MultipartUploadCount"),
        storageClasses: classes,
        dataTime: lastModified && lastModified > 0 ? lastModified * 1000 : undefined,
        notes: ["noteOssDelay"],
    };
}

const CMS_VERSION = "2019-01-01";
const CMS_NAMESPACE = "acs_oss_dashboard";

/**
 * 云监控把 `Datapoints` 作为 JSON 字符串返回，需要二次解析。
 * 流量与请求数取每个统计周期的 `Average`（等价于该周期内的总量），再对窗口求和。
 */
export function parseCmsDatapoints(payload: unknown): number[] {
    const raw = jsonPath(payload, "Datapoints");
    let list: unknown = raw;
    if (typeof raw === "string") {
        try {
            list = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(list)) {
        return [];
    }
    const values: number[] = [];
    for (const point of list) {
        const value = asNumber(jsonPath(point, "Average")) ??
            asNumber(jsonPath(point, "Value")) ??
            asNumber(jsonPath(point, "Sum"));
        if (value !== undefined) {
            values.push(value);
        }
    }
    return values;
}

/** 查一个 Bucket 层级的 OSS 指标，返回最近 24 小时各统计周期之和。 */
async function cmsMetric(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    region: string,
    metric: string,
): Promise<number | undefined> {
    const end = new Date();
    const start = new Date(end.getTime() - MONITOR_WINDOW_MS);
    const values: number[] = [];
    let nextToken = "";
    // 24 小时 × 60 秒正好 1440 个点，正常一页取完；有 NextToken 时继续翻页
    for (let page = 0; page < 4; page++) {
        const params: Record<string, string> = {
            Namespace: CMS_NAMESPACE,
            MetricName: metric,
            Dimensions: JSON.stringify({BucketName: ctx.bucket}),
            Period: "60",
            StartTime: String(start.getTime()),
            EndTime: String(end.getTime()),
            Length: "1440",
        };
        if (nextToken !== "") {
            params.NextToken = nextToken;
        }
        const url = await aliyunRpcUrl({
            endpoint: `https://metrics.${region}.aliyuncs.com`,
            action: "DescribeMetricList",
            version: CMS_VERSION,
            params,
            accessKey: requireAccessKey(ctx.source),
            secretKey: requireSecretKey(ctx.source),
        });
        const response = await ctx.request({url, method: "GET", headers: {}, contentType: "application/json"});
        if (response.status !== 200) {
            throw providerError(response.status, response.body);
        }
        let payload: unknown;
        try {
            payload = JSON.parse(response.body);
        } catch {
            throw new ProviderError("Unexpected CloudMonitor response: not JSON");
        }
        if (jsonPath(payload, "Success") === false) {
            throw new ProviderError(String(jsonPath(payload, "Message") ?? "CloudMonitor query failed"));
        }
        values.push(...parseCmsDatapoints(payload));
        const token = jsonPath(payload, "NextToken");
        nextToken = typeof token === "string" ? token : "";
        if (nextToken === "") {
            break;
        }
    }
    return sumDefined(values);
}

export const aliyunOss: ProviderDefinition = {
    id: "aliyunOss",
    labelKey: "providerAliyunOss",
    docsUrl: "https://help.aliyun.com/zh/oss/developer-reference/getbucketstat",
    endpointRequired: true,
    regionRequired: false,
    accountIdRequired: false,
    accessKeyLabelKey: "providerAliyunOssToken",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query(ctx) {
        const {source, bucket, request} = ctx;
        const endpoint = requireEndpoint(source);
        const url = virtualHostBucketUrl(endpoint, bucket, "stat");
        const region = source.region.trim() || regionFromEndpoint(endpoint, "aliyunOss");
        if (region === "") {
            throw new ProviderError("Region is required for OSS V4 signature");
        }
        const contentType = "application/json";
        const v4Headers = await signOssV4({
            method: "GET",
            url,
            bucket,
            subresource: "stat",
            accessKey: requireAccessKey(source),
            secretKey: requireSecretKey(source),
            region,
            contentType,
        });
        let response = await request({url, method: "GET", headers: v4Headers, contentType});
        // 老账号/老桶可能还没开 V4，403 时退回 V1；新桶 V4 正常时不会走到这里
        if (response.status === 403) {
            const v1Headers = await signV2({
                method: "GET",
                url,
                bucket,
                subresource: "stat",
                accessKey: requireAccessKey(source),
                secretKey: requireSecretKey(source),
                contentType,
                headerPrefix: "x-oss-",
            });
            response = await request({url, method: "GET", headers: v1Headers, contentType});
        }
        if (response.status !== 200) {
            throw providerError(response.status, response.body);
        }
        const usage = parseStat(response.body);
        const notes = ["noteOssDelay"];
        const errors: string[] = [];
        const metrics = await withMetrics(async () => {
            const [outgoing, incoming, requests] = await Promise.all([
                cmsMetric(ctx, region, "InternetSend"),
                cmsMetric(ctx, region, "InternetRecv"),
                cmsMetric(ctx, region, "TotalRequestCount"),
            ]);
            return {trafficOutBytes: outgoing, trafficInBytes: incoming, requestCount: requests};
        }, errors);
        if (metrics.trafficInBytes !== undefined || metrics.trafficOutBytes !== undefined || metrics.requestCount !== undefined) {
            notes.push("noteMetricsWindow");
        }
        return {...usage, ...metrics, notes, errors};
    },
};

/** 供单元测试使用的纯解析函数。 */
export {parseStat as parseOssStat};
