/**
 * 插件的配置模型：数据源、存储格式与运行时形态。
 *
 * 落盘时只保存 `StoredSource`，AK/SK 单独封进 `credentials` 信封（见 secret.ts）；
 * 内存里用 `DataSource`，明文凭据只在需要发请求的那一刻存在。
 */
export const STORAGE_NAME = "s3-usage-config";

export const PROVIDER_IDS = [
    "aliyunOss",
    "tencentCos",
    "huaweiObs",
    "volcanoTos",
    "qiniuKodo",
    "minio",
    "cloudflareR2",
    "awsS3",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];

export interface StoredSource {
    id: string;
    name: string;
    provider: ProviderId;
    buckets: string[];
    endpoint: string;
    region: string;
    accountId: string;
    /** 读取思源「设置 → 同步 → S3」里的凭据，而不是用插件自己保存的凭据。 */
    useSyncConfig: boolean;
    /** AES-GCM 信封；没有手动凭据时为空。 */
    credentials?: string;
}

export interface DataSource extends StoredSource {
    accessKey: string;
    secretKey: string;
    /** 密文存在但解不开（仓库密钥被更换，或当前环境没有 WebCrypto）。 */
    credentialsError: boolean;
    /** 解不开的具体原因，界面据此给不同提示。 */
    credentialsErrorReason: "unreadable" | "unavailable" | "";
}

export interface StoredSettings {
    version: 1;
    timeoutSeconds: number;
    sources: StoredSource[];
}

export interface PluginSettings {
    version: 1;
    timeoutSeconds: number;
    sources: DataSource[];
}

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 300;

export const DEFAULT_SETTINGS: PluginSettings = {
    version: 1,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    sources: [],
};

/** 思源同步配置里的 S3 那一段。 */
export interface SyncS3Config {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
    pathStyle: boolean;
    timeout: number;
}

interface SiyuanConfigShape {
    sync?: {provider?: number; s3?: Partial<SyncS3Config>};
    repo?: {key?: string};
}

function siyuanConfig(): SiyuanConfigShape | undefined {
    if (typeof window === "undefined") {
        return undefined;
    }
    return (window as unknown as {siyuan?: {config?: SiyuanConfigShape}}).siyuan?.config;
}

/**
 * 读思源当前保存的 S3 同步配置。
 *
 * 只在同步服务商确实是 S3 时返回；切到 WebDAV/本地目录后，旧字段还留在配置里也不能用，
 * 否则会出现「数据源在、查的是另一套配置」。
 */
export function readSyncS3Config(): SyncS3Config | undefined {
    const config = siyuanConfig();
    if (config?.sync?.provider !== 2) {
        return undefined;
    }
    const s3 = config.sync.s3;
    if (!s3) {
        return undefined;
    }
    const endpoint = text(s3.endpoint);
    const bucket = text(s3.bucket);
    if (endpoint === "" || bucket === "") {
        return undefined;
    }
    return {
        endpoint,
        accessKey: text(s3.accessKey),
        secretKey: text(s3.secretKey),
        bucket,
        region: text(s3.region),
        pathStyle: s3.pathStyle === true,
        timeout: numberIn(s3.timeout, DEFAULT_TIMEOUT_SECONDS),
    };
}

/** 数据仓库密钥的 base64 文本；没初始化过或当前角色读不到时为空串。 */
export function repoKeyBase64(): string {
    return text(siyuanConfig()?.repo?.key);
}

/** 字符串字段的归一化：非字符串按空串处理，去首尾空白。 */
export function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberIn(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/** Endpoint 归一化：补 https、去掉末尾斜杠与路径以外的空白。 */
export function normalizeEndpoint(value: unknown): string {
    let endpoint = text(value);
    if (endpoint === "") {
        return "";
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)) {
        endpoint = `https://${endpoint}`;
    }
    try {
        const url = new URL(endpoint);
        return `${url.protocol}//${url.host}`;
    } catch {
        return "";
    }
}

/** 桶名列表：按换行或逗号拆分、去重、去空白。 */
export function parseBucketList(value: unknown): string[] {
    const raw = Array.isArray(value) ? value.join("\n") : text(value);
    const seen = new Set<string>();
    const buckets: string[] = [];
    for (const part of raw.split(/[\n,，;；]+/)) {
        const bucket = part.trim();
        if (bucket !== "" && !seen.has(bucket)) {
            seen.add(bucket);
            buckets.push(bucket);
        }
    }
    return buckets;
}

export function isProviderId(value: unknown): value is ProviderId {
    return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function normalizeStoredSource(value: unknown, index: number): StoredSource | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const source = value as Record<string, unknown>;
    if (!isProviderId(source.provider)) {
        return undefined;
    }
    const id = text(source.id) || `source-${index + 1}`;
    const name = text(source.name) || id;
    return {
        id,
        name,
        provider: source.provider,
        buckets: parseBucketList(source.buckets),
        endpoint: normalizeEndpoint(source.endpoint),
        region: text(source.region),
        accountId: text(source.accountId),
        useSyncConfig: source.useSyncConfig === true,
        credentials: text(source.credentials) || undefined,
    };
}

/**
 * 读回落盘配置并做防御性归一化。
 *
 * 旧版本或手改过的数据可能缺字段、类型不对；这里一律回退默认值，坏数据不进入运行时。
 * 重复 id 只保留第一条，避免 React 之外的 DOM 列表出现两个同名数据源。
 */
export function mergeStoredSettings(raw: unknown): StoredSettings {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const seen = new Set<string>();
    const sources: StoredSource[] = [];
    if (Array.isArray(value.sources)) {
        value.sources.forEach((item, index) => {
            const source = normalizeStoredSource(item, index);
            if (source && !seen.has(source.id)) {
                seen.add(source.id);
                sources.push(source);
            }
        });
    }
    const timeout = Math.round(numberIn(value.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS));
    return {
        version: 1,
        timeoutSeconds: Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, timeout)),
        sources,
    };
}

/** 从 Endpoint 猜服务商；只用于「导入思源同步配置」和默认值，不改变用户已选的类型。 */
export function detectProvider(endpoint: string): ProviderId {
    const host = (() => {
        try {
            return new URL(normalizeEndpoint(endpoint)).hostname.toLowerCase();
        } catch {
            return "";
        }
    })();
    if (host.endsWith(".aliyuncs.com")) {
        return "aliyunOss";
    }
    if (host.endsWith(".myqcloud.com")) {
        return "tencentCos";
    }
    if (host.endsWith(".myhuaweicloud.com")) {
        return "huaweiObs";
    }
    if (host.endsWith(".volces.com")) {
        return "volcanoTos";
    }
    if (host.endsWith(".amazonaws.com")) {
        return "awsS3";
    }
    return "minio";
}

/** 从 OSS/COS 等 Endpoint 推导地域，尽力而为；失败时返回空串，由用户手填。 */
export function regionFromEndpoint(endpoint: string, provider: ProviderId): string {
    const host = (() => {
        try {
            return new URL(normalizeEndpoint(endpoint)).hostname.toLowerCase();
        } catch {
            return "";
        }
    })();
    if (provider === "aliyunOss") {
        const match = /^oss-([a-z0-9-]+)\.aliyuncs\.com$/.exec(host);
        return match?.[1] ?? "";
    }
    if (provider === "volcanoTos") {
        const match = /(?:^|\.)tos-([a-z0-9-]+)\.volces\.com$/.exec(host);
        return match?.[1] ?? "";
    }
    if (provider === "tencentCos") {
        const match = /^cos\.([a-z0-9-]+)\.myqcloud\.com$/.exec(host);
        return match?.[1] ?? "";
    }
    if (provider === "huaweiObs") {
        const match = /^obs\.([a-z0-9-]+)\.myhuaweicloud\.com$/.exec(host);
        return match?.[1] ?? "";
    }
    return "";
}

/** 创建数据源时的稳定 id：随机 + 时间，卸载重装也不会撞。 */
export function newSourceId(): string {
    return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
