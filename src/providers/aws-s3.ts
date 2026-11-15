/**
 * AWS S3：CloudWatch GetMetricStatistics。
 *
 * S3 没有单桶用量接口；CloudWatch 的 AWS/S3 命名空间每天发布一次
 * BucketSizeBytes（按 StorageType 维度）和 NumberOfObjects（AllStorageTypes）。
 * 这里逐个存储类查询 BucketSizeBytes 再求和；某个存储类在该区域不支持时跳过，
 * 不让整次查询失败。
 */
import {signAwsV4} from "../sign/aws-v4";
import {asNumber, parseXml, recordAt, stringAt} from "../xml";
import {requireAccessKey, requireRegion, requireSecretKey} from "./helpers";
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

function parseDatapoints(body: string): MetricValue {
    const root = recordAt(parseXml(body), "GetMetricStatisticsResponse");
    const result = recordAt(root, "GetMetricStatisticsResult");
    const datapoints = recordAt(result, "Datapoints");
    const members = datapoints?.member;
    const list = Array.isArray(members) ? members : members === undefined ? [] : [members];
    let latest: MetricValue = {};
    for (const member of list) {
        if (!member || typeof member !== "object") {
            continue;
        }
        const rawTime = (member as Record<string, unknown>).Timestamp;
        const rawAverage = (member as Record<string, unknown>).Average;
        const time = Date.parse(typeof rawTime === "string" ? rawTime : "");
        const value = asNumber(rawAverage);
        if (!Number.isFinite(time) || value === undefined) {
            continue;
        }
        if (latest.timestamp === undefined || time > latest.timestamp) {
            latest = {timestamp: time, value};
        }
    }
    return latest;
}

function metricError(body: string): string {
    const root = recordAt(parseXml(body), "ErrorResponse");
    const error = recordAt(root, "Error");
    return [stringAt(error, "Code"), stringAt(error, "Message")].filter(Boolean).join(": ");
}

async function getMetric(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    bucket: string,
    metricName: string,
    storageType: string,
    unit: "Bytes" | "Count",
): Promise<MetricValue> {
    const region = requireRegion(ctx.source);
    const url = `https://monitoring.${region}.amazonaws.com/`;
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
        Action: "GetMetricStatistics",
        Version: "2010-08-01",
        Namespace: "AWS/S3",
        MetricName: metricName,
        "Dimensions.member.1.Name": "BucketName",
        "Dimensions.member.1.Value": bucket,
        "Dimensions.member.2.Name": "StorageType",
        "Dimensions.member.2.Value": storageType,
        "StartTime": start.toISOString(),
        "EndTime": end.toISOString(),
        Period: "86400",
        "Statistics.member.1": "Average",
        Unit: unit,
    });
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
        throw new ProviderError(metricError(response.body) || response.body.slice(0, 300) || `HTTP ${response.status}`);
    }
    return parseDatapoints(response.body);
}

export const awsS3: ProviderDefinition = {
    id: "awsS3",
    labelKey: "providerAwsS3",
    docsUrl: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/cloudwatch-monitoring.html",
    endpointRequired: false,
    regionRequired: true,
    accountIdRequired: false,
    accessKeyLabelKey: "providerAwsS3Token",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query(ctx) {
        const classes: StorageClassUsage[] = [];
        let storageBytes = 0;
        let hasStorage = false;
        let dataTime = 0;
        for (const storageType of STORAGE_TYPES) {
            try {
                const metric = await getMetric(ctx, ctx.bucket, "BucketSizeBytes", storageType.value, "Bytes");
                if (metric.value !== undefined) {
                    storageBytes += metric.value;
                    hasStorage = true;
                    dataTime = Math.max(dataTime, metric.timestamp ?? 0);
                    if (metric.value > 0) {
                        classes.push({key: storageType.key, name: storageType.name, storageBytes: metric.value});
                    }
                }
            } catch (error) {
                // 某个存储类在部分区域不发布是正常情况；只有全部失败才在下面报错
                if (error instanceof ProviderError && /InvalidParameterValue|InvalidParameterCombination/i.test(error.message)) {
                    continue;
                }
                throw error;
            }
        }
        const objects = await getMetric(ctx, ctx.bucket, "NumberOfObjects", "AllStorageTypes", "Count");
        if (hasStorage) {
            dataTime = Math.max(dataTime, objects.timestamp ?? 0);
        }
        return {
            storageBytes: hasStorage ? storageBytes : undefined,
            objectCount: objects.value,
            storageClasses: classes,
            dataTime: dataTime > 0 ? dataTime : undefined,
            notes: ["noteAwsDaily", "noteQuota"],
        };
    },
};

export {parseDatapoints as parseAwsDatapoints};
