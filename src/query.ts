/**
 * 查询编排：把界面上的一个「数据源 + 桶」变成一次用量结果。
 *
 * 这里负责三件事：解析「使用思源 S3 同步配置」的实时凭据、选适配器、把底层错误
 * 归类成界面能说清楚的几类（网络没送达 / 认证失败 / 服务商报错 / 配置不全）。
 */
import {detectProvider, readSyncS3Config, type DataSource} from "./config";
import {ForwardError, forward} from "./net";
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

function effectiveSource(source: DataSource): DataSource {
    if (!source.useSyncConfig) {
        return source;
    }
    const config = readSyncS3Config();
    if (!config) {
        throw new QueryError("config", "SiYuan has no usable S3 sync configuration");
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
        throw new QueryError("config", "Bucket is empty");
    }
    const effective = effectiveSource(source);
    if (effective.credentialsError) {
        throw new QueryError("config", "Credentials cannot be decrypted");
    }
    const meta = PROVIDER_META[effective.provider];
    if (effective.accessKey.trim() === "") {
        throw new QueryError("config", "Access Key is required");
    }
    if (meta.secretKeyRequired && effective.secretKey.trim() === "") {
        throw new QueryError("config", "Secret Key is required");
    }
    if (meta.endpointRequired && effective.endpoint.trim() === "") {
        throw new QueryError("config", "Endpoint is required");
    }
    if (meta.regionRequired && effective.region.trim() === "") {
        throw new QueryError("config", "Region is required");
    }
    if (meta.accountIdRequired && effective.accountId.trim() === "") {
        throw new QueryError("config", "Account ID is required");
    }
    try {
        return await providerFor(effective.provider).query({
            source: effective,
            bucket: bucket.trim(),
            timeoutMs: Math.max(5, timeoutSeconds) * 1000,
            request: (request) => forward(request, Math.max(5, timeoutSeconds) * 1000),
        });
    } catch (error) {
        if (error instanceof QueryError) {
            throw error;
        }
        if (error instanceof ForwardError) {
            throw new QueryError("network", error.message);
        }
        if (error instanceof ProviderError) {
            if (/403|AccessDenied|SignatureDoesNotMatch|InvalidAccessKey|AuthFailure|Unauthorized|Forbidden/i.test(error.message)) {
                throw new QueryError("auth", error.message);
            }
            throw new QueryError("provider", error.message);
        }
        throw new QueryError("provider", error instanceof Error ? error.message : String(error));
    }
}
