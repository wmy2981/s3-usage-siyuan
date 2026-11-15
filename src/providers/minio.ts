/**
 * MinIO：Admin API `datausageinfo`。
 *
 * MinIO 没有标准的单桶用量 S3 接口，但管理端提供了全量桶用量快照；
 * 请求按 AWS SigV4 签名，service 固定 `s3`，region 一般用 `us-east-1`。
 * 不同版本的字段名在 `bucketsUsage` / `bucketsUsageInfo` 之间变动过，这里都兼容。
 */
import {signAwsV4} from "../sign/aws-v4";
import {asNumber, jsonPath} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import type {BucketUsage, ProviderDefinition} from "./types";
import {ProviderError} from "./types";

interface BucketEntry {
    size?: number;
    objectsCount?: number;
    versionsCount?: number;
    lastUpdate?: number;
}

function firstBucketEntry(payload: unknown, bucket: string): BucketEntry | undefined {
    const candidates = [
        jsonPath(payload, "bucketsUsageInfo", bucket),
        jsonPath(payload, "bucketsUsage", bucket),
        jsonPath(payload, "dataUsageInfo", "bucketsUsage", bucket),
    ];
    for (const candidate of candidates) {
        if (candidate && typeof candidate === "object") {
            const record = candidate as Record<string, unknown>;
            return {
                size: asNumber(record.size ?? record.Size),
                objectsCount: asNumber(record.objectsCount ?? record.objects_count ?? record.ObjectsCount),
                versionsCount: asNumber(record.versionsCount ?? record.versions_count),
            };
        }
    }
    return undefined;
}

function parseMinioUsage(body: string, bucket: string): BucketUsage {
    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        throw new ProviderError("Unexpected MinIO response: not JSON");
    }
    const entry = firstBucketEntry(payload, bucket);
    if (!entry) {
        throw new ProviderError(`MinIO returned no usage for bucket ${bucket}`);
    }
    const sizeFallback = asNumber(jsonPath(payload, "bucketsSizes", bucket));
    const lastUpdate = jsonPath(payload, "lastUpdate");
    // RFC3339Nano 带 9 位小数，Date.parse 只稳定支持毫秒，先截到 3 位
    const dataTime = typeof lastUpdate === "string"
        ? Date.parse(lastUpdate.replace(/(\.\d{3})\d+/, "$1"))
        : undefined;
    return {
        storageBytes: entry.size ?? sizeFallback,
        objectCount: entry.objectsCount,
        dataTime: Number.isFinite(dataTime) ? dataTime : undefined,
        notes: ["noteMinioRealtime", "noteQuota"],
    };
}

async function requestUsage(
    ctx: Parameters<ProviderDefinition["query"]>[0],
    path: string,
): Promise<{status: number; body: string}> {
    const endpoint = requireEndpoint(ctx.source);
    const url = `${endpoint}${path}`;
    const region = ctx.source.region.trim() === "" ? "us-east-1" : ctx.source.region.trim();
    const headers = await signAwsV4({
        method: "GET",
        url,
        headers: {"content-type": "application/json"},
        payload: "",
        service: "s3",
        region,
        accessKey: requireAccessKey(ctx.source),
        secretKey: requireSecretKey(ctx.source),
    });
    const response = await ctx.request({
        url,
        method: "GET",
        headers,
        contentType: "application/json",
    });
    return {status: response.status, body: response.body};
}

export const minio: ProviderDefinition = {
    id: "minio",
    labelKey: "providerMinio",
    docsUrl: "https://docs.min.io/aistor/reference/aistor-server/http-endpoints",
    endpointRequired: true,
    regionRequired: false,
    accountIdRequired: false,
    accessKeyLabelKey: "providerMinioToken",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query(ctx) {
        let response = await requestUsage(ctx, "/minio/admin/v3/datausageinfo");
        if (response.status === 404) {
            response = await requestUsage(ctx, "/minio/admin/v4/datausageinfo");
        }
        if (response.status !== 200) {
            throw providerError(response.status, response.body);
        }
        return parseMinioUsage(response.body, ctx.bucket);
    },
};

export {parseMinioUsage};
