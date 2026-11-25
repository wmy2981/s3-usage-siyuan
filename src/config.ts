/**
 * 插件的配置模型：数据源、存储格式与运行时形态。
 *
 * 落盘时只保存 `StoredSource`，AK/SK 单独封进 `credentials` 信封（见 secret.ts）；
 * 内存里用 `DataSource`，明文凭据只在需要发请求的那一刻存在。
 */
export const STORAGE_NAME = "s3-usage-config";

/** 从思源导入那一条数据源的固定 id：全局只有一条。 */
export const SIYUAN_SOURCE_ID = "siyuan-import";

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
    /** AES-GCM 信封；没有手动凭据时为空。 */
    credentials?: string;
}

export interface DataSource extends StoredSource {
    accessKey: string;
    secretKey: string;
    /**
     * 「从思源导入」那一条数据的标记，只由插件内部置位，用户不能选择。
     *
     * 置位后除名字外的所有字段都是运行时从思源「设置 → 同步 → S3」现读的，
     * 落盘只留名字（见 `StoredSettings.siyuan`）。
     */
    useSyncConfig: boolean;
    /**
     * 「从思源导入」那一条手动指定的服务商；不填表示按 Endpoint 自动识别。
     *
     * 只对思源导入有意义：手动数据源直接用 provider 本身。
     */
    providerOverride?: ProviderId;
    /** 密文存在但解不开（仓库密钥被更换，或当前环境没有 WebCrypto）。 */
    credentialsError: boolean;
    /** 解不开的具体原因，界面据此给不同提示。 */
    credentialsErrorReason: "unreadable" | "unavailable" | "";
}

/** 从思源导入的唯一一条数据源：落盘只有用户改过的名字与手动指定的服务商，其余全在运行时读。 */
export interface StoredSiyuanImport {
    /** 显示名；空串表示用默认名。 */
    name: string;
    /** 手动指定的服务商；不写表示按 Endpoint 自动识别。 */
    provider?: ProviderId;
}

export interface StoredSettings {
    version: 1;
    timeoutSeconds: number;
    /** 连接检查的超时（秒）。 */
    testTimeoutSeconds: number;
    /** 自动刷新间隔（分钟）；0 表示只在手动点击时刷新。 */
    refreshMinutes: number;
    /** 只包含手动填写的数据源。 */
    sources: StoredSource[];
    /** 存在即表示已经导入过思源配置，且最多只能有一条。 */
    siyuan?: StoredSiyuanImport;
}

export interface PluginSettings {
    version: 1;
    timeoutSeconds: number;
    testTimeoutSeconds: number;
    refreshMinutes: number;
    sources: DataSource[];
}

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 300;

/** 连接检查单独计时：只发一个轻量请求，默认 5 秒足够。 */
export const DEFAULT_TEST_TIMEOUT_SECONDS = 5;
export const MIN_TEST_TIMEOUT_SECONDS = 1;
export const MAX_TEST_TIMEOUT_SECONDS = 60;

/** 传输层钳制范围（毫秒）：查询与连接检查共用同一层转发，必须覆盖 1–300 秒两端。 */
export const MIN_TRANSPORT_TIMEOUT_MS = MIN_TEST_TIMEOUT_SECONDS * 1000;
export const MAX_TRANSPORT_TIMEOUT_MS = MAX_TIMEOUT_SECONDS * 1000;

/** 自动刷新只提供固定档位，避免用户填出 1 分钟这种会打满监控接口的值。 */
export const REFRESH_MINUTES_OPTIONS = [0, 5, 10, 30] as const;

export const DEFAULT_SETTINGS: PluginSettings = {
    version: 1,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    testTimeoutSeconds: DEFAULT_TEST_TIMEOUT_SECONDS,
    refreshMinutes: 0,
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

/**
 * 用思源当前的 S3 同步配置构建「从思源导入」的运行时数据源。
 *
 * 服务商、桶名、地域、凭据每次调用都重新读；思源侧改了同步配置就自动跟着变，
 * 没有可用配置时返回一条空壳，界面据此显示「思源当前没有可用的 S3 同步配置」。
 */
export function siyuanRuntimeSource(name: string, providerOverride?: ProviderId): DataSource {
    const base: DataSource = {
        id: SIYUAN_SOURCE_ID,
        name,
        provider: providerOverride ?? "minio",
        providerOverride,
        buckets: [],
        endpoint: "",
        region: "",
        accountId: "",
        useSyncConfig: true,
        accessKey: "",
        secretKey: "",
        credentialsError: false,
        credentialsErrorReason: "",
    };
    const config = readSyncS3Config();
    if (!config) {
        return base;
    }
    // 思源里存的是不带协议头的 host，查询前统一补全
    const endpoint = normalizeEndpoint(config.endpoint);
    // 自动识别认错了就用手动指定的那一条，界面上的选择优先于域名
    const provider = providerOverride ?? detectProvider(endpoint);
    return {
        ...base,
        provider,
        buckets: [config.bucket],
        endpoint,
        region: config.region || regionFromEndpoint(endpoint, provider),
        // R2 的账号 ID 在 Endpoint 里，其余服务商这一栏没有可推导的值
        accountId: accountIdFromEndpoint(endpoint, provider),
        accessKey: config.accessKey,
        secretKey: config.secretKey,
    };
}

/** 手动数据源原样返回；思源导入那一条按当前同步配置重建。 */
export function resolveSource(source: DataSource): DataSource {
    return source.useSyncConfig ? siyuanRuntimeSource(source.name, source.providerOverride) : source;
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
        credentials: text(source.credentials) || undefined,
    };
}

/** 旧版本把思源导入混在数据源列表里，这类条目升级时统一迁到独立的 siyuan 字段。 */
function isLegacySiyuanSource(value: unknown): boolean {
    return !!value && typeof value === "object" && (value as Record<string, unknown>).useSyncConfig === true;
}

/** 旧配置里可能有多条，迁移只认第一条。 */
function legacySiyuanName(rawSources: unknown): string | undefined {
    if (!Array.isArray(rawSources)) {
        return undefined;
    }
    const legacy = rawSources.find(isLegacySiyuanSource);
    return legacy === undefined ? undefined : text((legacy as Record<string, unknown>).name);
}

function mergeSiyuanImport(rawSiyuan: unknown, rawSources: unknown): StoredSiyuanImport | undefined {
    if (rawSiyuan && typeof rawSiyuan === "object") {
        const provider = (rawSiyuan as Record<string, unknown>).provider;
        return {
            name: text((rawSiyuan as Record<string, unknown>).name),
            // 只接受已知的服务商 id；其余值一律当作「自动识别」，不把脏数据带进运行时
            ...(isProviderId(provider) ? {provider} : {}),
        };
    }
    const legacy = legacySiyuanName(rawSources);
    return legacy === undefined ? undefined : {name: legacy};
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
            // 旧配置里的思源导入条目升级到 siyuan 字段，不再当作普通数据源
            if (isLegacySiyuanSource(item)) {
                return;
            }
            const source = normalizeStoredSource(item, index);
            if (source && !seen.has(source.id)) {
                seen.add(source.id);
                sources.push(source);
            }
        });
    }
    const timeout = Math.round(numberIn(value.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS));
    const testTimeout = Math.round(numberIn(value.testTimeoutSeconds, DEFAULT_TEST_TIMEOUT_SECONDS));
    const refresh = Math.round(numberIn(value.refreshMinutes, 0));
    const siyuan = mergeSiyuanImport(value.siyuan, value.sources);
    return {
        version: 1,
        timeoutSeconds: Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, timeout)),
        // 旧配置没有这个字段，一律回退到 5 秒
        testTimeoutSeconds: Math.min(MAX_TEST_TIMEOUT_SECONDS, Math.max(MIN_TEST_TIMEOUT_SECONDS, testTimeout)),
        // 旧配置没有这个字段；非法档位一律回到「不自动刷新」
        refreshMinutes: (REFRESH_MINUTES_OPTIONS as readonly number[]).includes(refresh) ? refresh : 0,
        sources,
        ...(siyuan ? {siyuan} : {}),
    };
}

/** Endpoint 的 host 小写形式；不是合法 URL 时返回空串。 */
function hostOf(endpoint: string): string {
    try {
        return new URL(normalizeEndpoint(endpoint)).hostname.toLowerCase();
    } catch {
        return "";
    }
}

/**
 * 各家 S3 兼容域名 → 服务商。
 *
 * 只收各家的对象存储域名，认不出来的一律按 MinIO / 自建处理。
 * .amazonaws.com.cn 是中国区独立分区，不能与 .amazonaws.com 合并成一条。
 */
const PROVIDER_HOST_SUFFIXES: {suffix: string; provider: ProviderId}[] = [
    {suffix: ".aliyuncs.com", provider: "aliyunOss"},
    {suffix: ".myqcloud.com", provider: "tencentCos"},
    {suffix: ".myhuaweicloud.com", provider: "huaweiObs"},
    // 欧洲站用独立的 .eu 分区
    {suffix: ".myhuaweicloud.eu", provider: "huaweiObs"},
    {suffix: ".volces.com", provider: "volcanoTos"},
    // 七牛的 S3 兼容域名形如 s3.cn-south-1.qiniucs.com
    {suffix: ".qiniucs.com", provider: "qiniuKodo"},
    {suffix: ".r2.cloudflarestorage.com", provider: "cloudflareR2"},
    {suffix: ".amazonaws.com.cn", provider: "awsS3"},
    {suffix: ".amazonaws.com", provider: "awsS3"},
];

/** 从 Endpoint 猜服务商；只用于「导入思源同步配置」和默认值，不改变用户已选的类型。 */
export function detectProvider(endpoint: string): ProviderId {
    const host = hostOf(endpoint);
    for (const entry of PROVIDER_HOST_SUFFIXES) {
        if (host.endsWith(entry.suffix)) {
            return entry.provider;
        }
    }
    return "minio";
}

/** 从 OSS/COS 等 Endpoint 推导地域，尽力而为；失败时返回空串，由用户手填。 */
export function regionFromEndpoint(endpoint: string, provider: ProviderId): string {
    const host = hostOf(endpoint);
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
        const match = /^obs\.([a-z0-9-]+)\.myhuaweicloud\.(?:com|eu)$/.exec(host);
        return match?.[1] ?? "";
    }
    if (provider === "qiniuKodo") {
        const match = /^s3\.([a-z0-9-]+)\.qiniucs\.com$/.exec(host);
        return match?.[1] ?? "";
    }
    if (provider === "awsS3") {
        const match = /^s3\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host);
        return match?.[1] ?? "";
    }
    return "";
}

/**
 * Cloudflare R2 的 S3 Endpoint 是「账号 ID.r2.cloudflarestorage.com」，
 * 账号 ID 直接写在域名里，导入时不必让用户再填一次。
 */
export function accountIdFromEndpoint(endpoint: string, provider: ProviderId): string {
    if (provider !== "cloudflareR2") {
        return "";
    }
    const match = /^([0-9a-f]{32})\.r2\.cloudflarestorage\.com$/.exec(hostOf(endpoint));
    return match?.[1] ?? "";
}

/** 创建数据源时的稳定 id：随机 + 时间，卸载重装也不会撞。 */
export function newSourceId(): string {
    return `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
