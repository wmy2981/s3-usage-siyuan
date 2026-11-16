/**
 * MinIO：Admin API `datausageinfo`。
 *
 * MinIO 没有标准的单桶用量 S3 接口，但管理端提供了全量桶用量快照；
 * 请求按 AWS SigV4 签名，service 固定 `s3`，region 一般用 `us-east-1`。
 * 不同版本的字段名在 `bucketsUsage` / `bucketsUsageInfo` 之间变动过，这里都兼容。
 */
import {signAwsV4} from "../sign/aws-v4";
import {minioMetricsToken} from "../sign/minio-jwt";
import {asNumber, jsonPath} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import {sumDefined, withMetrics} from "./monitoring";
import type {MetricsPart} from "./monitoring";
import type {BucketUsage, ForwardResponse, ProviderDefinition} from "./types";
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
        notes: ["noteMinioRealtime"],
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

interface PrometheusSample {
    name: string;
    labels: Record<string, string>;
    value: number;
}

/** Prometheus 文本格式的最小解析：跳过注释，取指标名、标签与样本值。 */
export function parsePrometheusText(body: string): PrometheusSample[] {
    const samples: PrometheusSample[] = [];
    for (const raw of body.split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
        if (!match) {
            continue;
        }
        const value = Number(match[3]);
        if (!Number.isFinite(value)) {
            continue;
        }
        const labels: Record<string, string> = {};
        if (match[2]) {
            const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
            let found: RegExpExecArray | null;
            while ((found = pattern.exec(match[2])) !== null) {
                labels[found[1]] = found[2].replace(/\\(.)/g, "$1");
            }
        }
        samples.push({name: match[1], labels, value});
    }
    return samples;
}

// v2 端点用 minio_bucket_*，v3 端点改成 minio_bucket_api_*；两套名字都认。
// 请求数优先取 requests_total，个别版本只有直方图的 _count（观测次数即请求数）。
const TRAFFIC_IN = ["minio_bucket_traffic_received_bytes", "minio_bucket_api_traffic_received_bytes"];
const TRAFFIC_OUT = ["minio_bucket_traffic_sent_bytes", "minio_bucket_api_traffic_sent_bytes"];
const REQUESTS = ["minio_bucket_requests_total", "minio_bucket_requests_ttfb_seconds_count", "minio_bucket_api_total"];

/**
 * 桶级流量与请求数。
 *
 * 这些是「自进程启动以来」的累计值（v2 是 gauge、v3 是 counter），不是 24 小时窗口，
 * 界面上必须靠 notes 说明，否则会被当成区间用量。
 */
export function parseMinioMetrics(body: string, bucket: string): MetricsPart {
    const samples = parsePrometheusText(body);
    const sumOf = (name: string) => sumDefined(samples
        .filter((sample) => sample.name === name &&
            (sample.labels.bucket === undefined || sample.labels.bucket === bucket))
        .map((sample) => sample.value));
    // 同一含义的不同指标名只会命中一个，逐个试，避免把两套名字加起来翻倍
    const pick = (names: string[]) => {
        for (const name of names) {
            const total = sumOf(name);
            if (total !== undefined) {
                return total;
            }
        }
        return undefined;
    };
    return {
        trafficInBytes: pick(TRAFFIC_IN),
        trafficOutBytes: pick(TRAFFIC_OUT),
        requestCount: pick(REQUESTS),
    };
}

/** 抓取指标端点：先试 v2，404 时退回 v3；JWT 被拒时再试匿名（公开指标）模式。 */
async function fetchMetrics(ctx: Parameters<ProviderDefinition["query"]>[0]): Promise<string> {
    const endpoint = requireEndpoint(ctx.source);
    const token = await minioMetricsToken(
        requireAccessKey(ctx.source),
        requireSecretKey(ctx.source),
    );
    const scrape = async (url: string): Promise<ForwardResponse> => {
        const response = await ctx.request({
            url,
            method: "GET",
            headers: {Authorization: `Bearer ${token}`},
            contentType: "text/plain",
        });
        if (response.status !== 401 && response.status !== 403) {
            return response;
        }
        // MINIO_PROMETHEUS_AUTH_TYPE=public 时不需要认证
        return ctx.request({url, method: "GET", headers: {}, contentType: "text/plain"});
    };
    let response = await scrape(`${endpoint}/minio/v2/metrics/bucket`);
    if (response.status === 404) {
        response = await scrape(`${endpoint}/minio/metrics/v3/bucket/api/${encodeURIComponent(ctx.bucket)}`);
    }
    if (response.status !== 200) {
        throw providerError(response.status, response.body);
    }
    return response.body;
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
        const usage = parseMinioUsage(response.body, ctx.bucket);
        const notes = ["noteMinioRealtime"];
        const errors: string[] = [];
        const metrics = await withMetrics(async () => parseMinioMetrics(await fetchMetrics(ctx), ctx.bucket), errors);
        if (metrics.trafficInBytes !== undefined || metrics.trafficOutBytes !== undefined || metrics.requestCount !== undefined) {
            notes.push("noteMinioCumulative");
        }
        return {...usage, ...metrics, notes, errors};
    },
};

export {parseMinioUsage};
