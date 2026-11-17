/**
 * 查询编排：把界面上的一个「数据源 + 桶」变成一次用量结果。
 *
 * 这里负责三件事：解析「使用思源 S3 同步配置」的实时凭据、选适配器、把底层错误
 * 归类成界面能说清楚的几类（网络没送达 / 认证失败 / 服务商报错 / 配置不全）。
 */
import {detectProvider, readSyncS3Config, type DataSource} from "./config";
import {ForwardError, forward} from "./net";
import {diagnosticSection, detailedErrorText} from "./diagnostics";
import {providerFor} from "./providers/registry";
import {PROVIDER_META} from "./providers/meta";
import type {BucketUsage} from "./providers/types";
import {ProviderError} from "./providers/types";

export type QueryErrorKind = "network" | "auth" | "provider" | "config";

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
    const config = readSyncS3Config();
    if (!config) {
        throw new QueryError("config", withQueryContext(new Error("SiYuan has no usable S3 sync configuration"), source, bucket, timeoutSeconds));
    }
    const provider = detectProvider(config.endpoint);
    return {
        ...source,
        provider,
        endpoint: config.endpoint,
        region: config.region || source.region,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        credentialsError: false,
        credentialsErrorReason: "",
    };
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
    try {
        return await providerFor(effective.provider).query({
            source: effective,
            bucket: bucket.trim(),
            timeoutMs: Math.max(5, timeoutSeconds) * 1000,
            request: (request) => forward(request, Math.max(5, timeoutSeconds) * 1000),
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
            if (/403|AccessDenied|SignatureDoesNotMatch|InvalidAccessKey|AuthFailure|Unauthorized|Forbidden/i.test(error.message)) {
                throw new QueryError("auth", context);
            }
            throw new QueryError("provider", context);
        }
        throw new QueryError("provider", context);
    }
}
