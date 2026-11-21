/**
 * AWS S3：CloudWatch GetMetricStatistics。
 *
 * S3 没有单桶用量接口；CloudWatch 的 AWS/S3 命名空间每天发布一次
 * BucketSizeBytes（按 StorageType 维度）和 NumberOfObjects（AllStorageTypes）。
 * 这里逐个存储类查询 BucketSizeBytes 再求和；某个存储类在该区域不支持时跳过，
 * 不让整次查询失败。
 *
 * 流量与请求数（BytesUploaded / BytesDownloaded / AllRequests）属于「请求指标」：
 * 必须在桶上单独启用 metrics configuration，指标维度固定是 BucketName + FilterId，
 * 所以先用 ListMetrics 找出 FilterId，再按 Sum 统计最近 24 小时。
 */
import {mapLimit} from "../async";
import {signAwsV4} from "../sign/aws-v4";
import {arrayAt, asNumber, parseXml, recordAt, stringAt} from "../xml";
import {requireAccessKey, requireRegion, requireSecretKey, providerError} from "./helpers";
import {MONITOR_WINDOW_MS, sumDefined, withMetrics} from "./monitoring";
import type {ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

// 官方 BucketSizeBytes 的 valid storage-type filters；不含 *Overhead / *StagingStorage，
// 那些是计费附加项，混进「对象存储量」会让数字对不上控制台。
const STORAGE_TYPES: {value: string; key: string; name: string}[] = [
    {value: "StandardStorage", key: "standard", name: "STANDARD"},
    {value: "StandardIAStorage", key: "ia", name: "STANDARD_IA"},
    {value: "OneZoneIAStorage", key: "oneZoneIa", name: "ONEZONE_IA"},
    {value: "ReducedRedundancyStorage", key: "reducedRedundancy", name: "REDUCED_REDUNDANCY"},
    {value: "GlacierInstantRetrievalStorage", key: "glacierIr", name: "GLACIER_IR"},
    {value: "GlacierStorage", key: "glacier", name: "GLACIER"},
    {value: "DeepArchiveStorage", key: "deepArchive", name: "DEEP_ARCHIVE"},
    {value: "IntelligentTieringFAStorage", key: "intelligentFa", name: "INTELLIGENT_TIERING_FA"},
    {value: "IntelligentTieringIAStorage", key: "intelligentIa", name: "INTELLIGENT_TIERING_IA"},
    {value: "IntelligentTieringAIAStorage", key: "intelligentAia", name: "INTELLIGENT_TIERING_AIA"},
    {value: "IntelligentTieringAAStorage", key: "intelligentAa", name: "INTELLIGENT_TIERING_AA"},
    {value: "IntelligentTieringDAAStorage", key: "intelligentDaa", name: "INTELLIGENT_TIERING_DAA"},
];

interface MetricValue {
    value?: number;
    timestamp?: number;
}

function datapointMembers(body: string): unknown[] {
    const root = recordAt(parseXml(body), "GetMetricStatisticsResponse");
    const result = recordAt(root, "GetMetricStatisticsResult");
    const datapoints = recordAt(result, "Datapoints");
    return arrayAt(datapoints, "member");
}

/** 按指定统计字段解析全部数据点；存储量用 Average，请求指标用 Sum。 */
export function parseAwsSeries(body: string, field: "Average" | "Sum"): MetricValue[] {
    const points: MetricValue[] = [];
    for (const member of datapointMembers(body)) {
        if (!member || typeof member !== "object") {
            continue;
        }
        const record = member as Record<string, unknown>;
        const time = Date.parse(typeof record.Timestamp === "string" ? record.Timestamp : "");
        const value = asNumber(record[field]);
        if (!Number.isFinite(time) || value === undefined) {
            continue;
        }
        points.push({timestamp: time, value});
    }
    return points;
}

function parseDatapoints(body: string): MetricValue {
    let latest: MetricValue = {};
    for (const point of parseAwsSeries(body, "Average")) {
        if (latest.timestamp === undefined || (point.timestamp ?? 0) > latest.timestamp) {
            latest = point;
        }
    }
    return latest;
}

/**
 * ListMetrics 的结果里，请求指标同时带 BucketName 与 FilterId 两个维度；
 * 只用 BucketName 查 GetMetricStatistics 会返回空数据，所以必须先拿到 FilterId。
 */
export function parseListMetricsFilters(body: string): string[] {
    const root = recordAt(parseXml(body), "ListMetricsResponse");
    const result = recordAt(root, "ListMetricsResult");
    const metrics = recordAt(result, "Metrics");
    const filters: string[] = [];
    for (const member of arrayAt(metrics, "member")) {
        const dimensions = recordAt(member, "Dimensions");
        for (const dimension of arrayAt(dimensions, "member")) {
            if (stringAt(dimension, "Name") === "FilterId") {
                const value = stringAt(dimension, "Value");
                if (value !== "" && !filters.includes(value)) {
                    filters.push(value);
                }
            }
        }
    }
    return filters;
}

interface MetricQuery {
    metricName: string;
    unit: "Bytes" | "Count";
    statistic: "Average" | "Sum";
    periodSeconds: number;
    windowMs: number;
    /** BucketName 之外的维度，例如 StorageType 或 FilterId。 */
    dimensions?: Record<string, string>;
}

async function requestMetric(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    bucket: string,
    query: MetricQuery,
): Promise<string> {
    const region = requireRegion(ctx.source);
    const url = `https://monitoring.${region}.amazonaws.com/`;
    const end = new Date();
    const start = new Date(end.getTime() - query.windowMs);
    const params = new URLSearchParams({
        Action: "GetMetricStatistics",
        Version: "2010-08-01",
        Namespace: "AWS/S3",
        MetricName: query.metricName,
        "Dimensions.member.1.Name": "BucketName",
        "Dimensions.member.1.Value": bucket,
        "StartTime": start.toISOString(),
        "EndTime": end.toISOString(),
        Period: String(query.periodSeconds),
        "Statistics.member.1": query.statistic,
        Unit: query.unit,
    });
    let index = 2;
    for (const [name, value] of Object.entries(query.dimensions ?? {})) {
        params.set(`Dimensions.member.${index}.Name`, name);
        params.set(`Dimensions.member.${index}.Value`, value);
        index += 1;
    }
    const payload = params.toString();
    const headers = await signAwsV4({
        method: "POST",
        url,
        headers: {"content-type": "application/x-www-form-urlencoded; charset=utf-8"},
        payload,
        service: "monitoring",
        region,
        accessKey: requireAccessKey(ctx.source),
        secretKey: requireSecretKey(ctx.source),
    });
    const response = await ctx.request({
        url,
        method: "POST",
        headers,
        body: payload,
        contentType: "application/x-www-form-urlencoded; charset=utf-8",
    });
    if (response.status !== 200) {
        throw providerError(response);
    }
    return response.body;
}

async function getMetric(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    bucket: string,
    metricName: string,
    storageType: string,
    unit: "Bytes" | "Count",
): Promise<MetricValue> {
    const body = await requestMetric(ctx, bucket, {
        metricName,
        unit,
        statistic: "Average",
        periodSeconds: 86400,
        windowMs: 3 * 24 * 60 * 60 * 1000,
        dimensions: {StorageType: storageType},
    });
    return parseDatapoints(body);
}

/** 用 ListMetrics 找出请求指标的 FilterId（未启用请求指标时返回空数组）。 */
async function listRequestMetricFilters(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    bucket: string,
): Promise<string[]> {
    const region = requireRegion(ctx.source);
    const url = `https://monitoring.${region}.amazonaws.com/`;
    const payload = new URLSearchParams({
        Action: "ListMetrics",
        Version: "2010-08-01",
        Namespace: "AWS/S3",
        MetricName: "AllRequests",
        "Dimensions.member.1.Name": "BucketName",
        "Dimensions.member.1.Value": bucket,
    }).toString();
    const headers = await signAwsV4({
        method: "POST",
        url,
        headers: {"content-type": "application/x-www-form-urlencoded; charset=utf-8"},
        payload,
        service: "monitoring",
        region,
        accessKey: requireAccessKey(ctx.source),
        secretKey: requireSecretKey(ctx.source),
    });
    const response = await ctx.request({
        url,
        method: "POST",
        headers,
        body: payload,
        contentType: "application/x-www-form-urlencoded; charset=utf-8",
    });
    if (response.status !== 200) {
        throw providerError(response);
    }
    return parseListMetricsFilters(response.body);
}

/** 请求指标按 FilterId 分别查询后求和；一次启用多条配置时数值会累加。 */
async function sumRequestMetric(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    bucket: string,
    filters: string[],
    metricName: string,
    unit: "Bytes" | "Count",
): Promise<number | undefined> {
    const values = await Promise.all(filters.map(async (filterId) => {
        const body = await requestMetric(ctx, bucket, {
            metricName,
            unit,
            statistic: "Sum",
            periodSeconds: 3600,
            windowMs: MONITOR_WINDOW_MS,
            dimensions: {FilterId: filterId},
        });
        return sumDefined(parseAwsSeries(body, "Sum").map((point) => point.value));
    }));
    return sumDefined(values);
}

export const awsS3: ProviderDefinition = {
    id: "awsS3",
    async query(ctx) {
        // 12 个存储类 + 对象数：串行要跨网往返十几次，单桶就能耗十几秒；按 4 条并发压成几轮。
        const storageResults = await mapLimit(STORAGE_TYPES, 4, async (storageType) => {
            try {
                return await getMetric(ctx, ctx.bucket, "BucketSizeBytes", storageType.value, "Bytes");
            } catch (error) {
                // 某个存储类在部分区域不发布是正常情况，缺哪个就不算哪个
                if (error instanceof ProviderError && /InvalidParameterValue|InvalidParameterCombination/i.test(error.message)) {
                    return {};
                }
                throw error;
            }
        });
        const classes: StorageClassUsage[] = [];
        let storageBytes = 0;
        let hasStorage = false;
        let dataTime = 0;
        STORAGE_TYPES.forEach((storageType, index) => {
            const metric = storageResults[index];
            if (metric.value === undefined) {
                return;
            }
            storageBytes += metric.value;
            hasStorage = true;
            dataTime = Math.max(dataTime, metric.timestamp ?? 0);
            if (metric.value > 0) {
                classes.push({key: storageType.key, name: storageType.name, storageBytes: metric.value});
            }
        });
        const objects = await getMetric(ctx, ctx.bucket, "NumberOfObjects", "AllStorageTypes", "Count");
        dataTime = Math.max(dataTime, objects.timestamp ?? 0);

        const notes = ["noteAwsDaily", "noteAwsScope"];
        const errors: string[] = [];
        const metrics = await withMetrics(async () => {
            const filters = await listRequestMetricFilters(ctx, ctx.bucket);
            if (filters.length === 0) {
                notes.push("noteAwsRequestMetrics");
                return {};
            }
            notes.push("noteMetricsWindow");
            if (filters.length > 1) {
                // 整桶过滤器与按前缀过滤器的统计范围会重叠，相加可能重复计数
                notes.push("noteAwsMultiFilter");
            }
            const [requestCount, trafficInBytes, trafficOutBytes] = await Promise.all([
                sumRequestMetric(ctx, ctx.bucket, filters, "AllRequests", "Count"),
                sumRequestMetric(ctx, ctx.bucket, filters, "BytesUploaded", "Bytes"),
                sumRequestMetric(ctx, ctx.bucket, filters, "BytesDownloaded", "Bytes"),
            ]);
            return {requestCount, trafficInBytes, trafficOutBytes};
        }, errors);

        return {
            storageBytes: hasStorage ? storageBytes : undefined,
            objectCount: objects.value,
            storageClasses: classes,
            dataTime: dataTime > 0 ? dataTime : undefined,
            notes,
            errors,
            ...metrics,
        };
    },
};

export {parseDatapoints as parseAwsDatapoints};
