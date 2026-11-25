/**
 * 查询编排：把界面上的一个「数据源 + 桶」变成一次用量结果。
 *
 * 这里负责三件事：解析「使用思源 S3 同步配置」的实时凭据、选适配器、把底层错误
 * 归类成界面能说清楚的几类（网络没送达 / 认证失败 / 服务商报错 / 配置不全）。
 */
import {MIN_TEST_TIMEOUT_SECONDS, siyuanRuntimeSource, type DataSource} from "./config";
import {ForwardError, forward} from "./net";
import {diagnosticSection, detailedErrorText} from "./diagnostics";
import {providerFor} from "./providers/registry";
import {PROVIDER_META} from "./providers/meta";
import type {BucketUsage} from "./providers/types";
import {ProviderError} from "./providers/types";

export type QueryErrorKind = "network" | "auth" | "provider" | "config";

/** 认证类错误码；只有这些才归到「认证失败」，其余一律按服务商报错展示。 */
const AUTH_ERROR_PATTERN = /AccessDenied|SignatureDoesNotMatch|InvalidAccessKey|InvalidSecretId|InvalidCredential|AuthFailure|Unauthorized|Forbidden/i;

/**
 * 判断一个服务商错误是不是认证类。
 *
 * 优先看结构化的状态码与错误码；部分服务商把错误码写在 200 响应体里，
 * 这种情况只比对第一行摘要，绝不扫描整段诊断文本（里面的端口、时间戳都可能含 403）。
 */
function isAuthError(error: ProviderError): boolean {
    if (error.status === 401 || error.status === 403) {
        return true;
    }
    if (error.code !== "") {
        return AUTH_ERROR_PATTERN.test(error.code);
    }
    return AUTH_ERROR_PATTERN.test(error.message.split("\n", 1)[0]);
}

export class QueryError extends Error {
    readonly kind: QueryErrorKind;

    constructor(kind: QueryErrorKind, message: string) {
        super(message);
        this.name = "QueryError";
        this.kind = kind;
    }
}

function effectiveSource(source: DataSource, bucket: string, timeoutSeconds: number): DataSource {
    if (!source.useSyncConfig) {
        return source;
    }
    // 思源导入那一条必须和界面渲染走同一套归一化：补协议头、猜服务商、从 Endpoint 推导地域。
    // 这里若自己再拼一遍，会把已补全的 Endpoint 换回思源里那种不带协议头的裸 host。
    const resolved = siyuanRuntimeSource(source.name, source.providerOverride);
    if (resolved.buckets.length === 0) {
        throw new QueryError("config", withQueryContext(new Error("SiYuan has no usable S3 sync configuration"), source, bucket, timeoutSeconds));
    }
    return resolved;
}

function sourceContext(source: DataSource, bucket: string, timeoutSeconds: number): string {
    return [
        `Source ID: ${source.id}`,
        `Source name: ${source.name || "(unnamed)"}`,
        `Provider: ${source.provider}`,
        `Bucket: ${bucket}`,
        `Endpoint: ${source.endpoint || "(not set)"}`,
        `Region: ${source.region || "(not set)"}`,
        `Account ID / Project ID: ${source.accountId || "(not set)"}`,
        `Uses SiYuan sync config: ${source.useSyncConfig}`,
        `Credential state: ${source.credentialsError ? source.credentialsErrorReason : "loaded"}`,
        `Access key: ${source.accessKey ? "[SET, REDACTED]" : "(empty)"}`,
        `Secret key: ${source.secretKey ? "[SET, REDACTED]" : "(empty)"}`,
        `Timeout: ${timeoutSeconds} seconds`,
        `Client time: ${new Date().toISOString()}`,
    ].join("\n");
}

function withQueryContext(error: unknown, source: DataSource, bucket: string, timeoutSeconds: number): string {
    return detailedErrorText(error) + diagnosticSection("Data source and query", sourceContext(source, bucket, timeoutSeconds));
}

export interface QueryOutcome {
    usage?: BucketUsage;
    error?: {kind: QueryErrorKind; message: string};
    fetchedAt: number;
}

export async function queryBucket(
    source: DataSource,
    bucket: string,
    timeoutSeconds: number,
): Promise<BucketUsage> {
    if (bucket.trim() === "") {
        throw new QueryError("config", withQueryContext(new Error("Bucket is empty"), source, bucket, timeoutSeconds));
    }
    const effective = effectiveSource(source, bucket.trim(), timeoutSeconds);
    const configError = (message: string) => new QueryError("config", withQueryContext(new Error(message), effective, bucket, timeoutSeconds));
    if (effective.credentialsError) {
        throw configError(`Credentials cannot be decrypted: ${effective.credentialsErrorReason}`);
    }
    const meta = PROVIDER_META[effective.provider];
    if (effective.accessKey.trim() === "") {
        throw configError("Access Key is required");
    }
    if (meta.secretKeyRequired && effective.secretKey.trim() === "") {
        throw configError("Secret Key is required");
    }
    if (meta.endpointRequired && effective.endpoint.trim() === "") {
        throw configError("Endpoint is required");
    }
    if (meta.regionRequired && effective.region.trim() === "") {
        throw configError("Region is required");
    }
    if (meta.accountIdRequired && effective.accountId.trim() === "") {
        throw configError("Account ID is required");
    }
    // 连接检查的最小值是 1 秒，查询的最大值是 300 秒：这里只兜住非法值，不做额外收紧
    const timeoutMs = Math.max(MIN_TEST_TIMEOUT_SECONDS, timeoutSeconds) * 1000;
    try {
        return await providerFor(effective.provider).query({
            source: effective,
            bucket: bucket.trim(),
            timeoutMs,
            request: (request) => forward(request, timeoutMs),
        });
    } catch (error) {
        const context = withQueryContext(error, effective, bucket.trim(), timeoutSeconds);
        if (error instanceof QueryError) {
            throw new QueryError(error.kind, context);
        }
        if (error instanceof ForwardError) {
            throw new QueryError("network", context);
        }
        if (error instanceof ProviderError) {
            throw new QueryError(isAuthError(error) ? "auth" : "provider", context);
        }
        throw new QueryError("provider", context);
    }
}
