/**
 * 配置读写与凭据加解密的编排。
 *
 * 落盘只写密文；内存里的明文不落盘。读回时逐条解封，解不开只标记该数据源，
 * 不影响其他数据源继续工作。
 */
import type {Plugin} from "siyuan";
import {
    mergeStoredSettings,
    normalizeEndpoint,
    parseBucketList,
    siyuanRuntimeSource,
    STORAGE_NAME,
    text,
    type DataSource,
    type PluginSettings,
    type StoredSettings,
    type StoredSource,
} from "./config";
import {sealCredentials, unsealCredentials, type EncryptFailure} from "./secret";

export class SettingsError extends Error {
    readonly reason: EncryptFailure | "verify";

    constructor(message: string, reason: EncryptFailure | "verify") {
        super(message);
        this.name = "SettingsError";
        this.reason = reason;
    }
}

/** 读回并解封所有数据源；解不开的保留密文，标记 credentialsError。 */
export async function loadSettings(plugin: Plugin): Promise<PluginSettings> {
    const stored = mergeStoredSettings(await plugin.loadData(STORAGE_NAME));
    const sources: DataSource[] = [];
    for (const source of stored.sources) {
        const runtime: DataSource = {
            ...source,
            useSyncConfig: false,
            accessKey: "",
            secretKey: "",
            credentialsError: false,
            credentialsErrorReason: "",
        };
        if (source.credentials) {
            const result = await unsealCredentials(source.credentials);
            if (result.status === "ok") {
                runtime.accessKey = result.credentials.accessKey;
                runtime.secretKey = result.credentials.secretKey;
            } else if (result.status === "unreadable") {
                runtime.credentialsError = true;
                runtime.credentialsErrorReason = "unreadable";
            } else {
                // 当前环境解不了（非安全上下文）：保留密文，提示用户换环境
                runtime.credentialsError = true;
                runtime.credentialsErrorReason = "unavailable";
            }
        }
        sources.push(runtime);
    }
    if (stored.siyuan) {
        sources.push(siyuanRuntimeSource(stored.siyuan.name, stored.siyuan.provider));
    }
    return {
        version: 1,
        timeoutSeconds: stored.timeoutSeconds,
        testTimeoutSeconds: stored.testTimeoutSeconds,
        refreshMinutes: stored.refreshMinutes,
        sources,
    };
}

function sameSource(a: StoredSource, b: StoredSource): boolean {
    return a.id === b.id
        && a.name === b.name
        && a.provider === b.provider
        && a.endpoint === b.endpoint
        && a.region === b.region
        && a.accountId === b.accountId
        && a.credentials === b.credentials
        && a.buckets.length === b.buckets.length
        && a.buckets.every((bucket, index) => bucket === b.buckets[index]);
}

/** 读回校验比对全部落盘字段，避免「保存成功但内容被截断/改写」。 */
function sameStoredSettings(a: StoredSettings, b: StoredSettings): boolean {
    return a.version === b.version
        && a.timeoutSeconds === b.timeoutSeconds
        && a.testTimeoutSeconds === b.testTimeoutSeconds
        && a.refreshMinutes === b.refreshMinutes
        && a.siyuan?.name === b.siyuan?.name
        && a.siyuan?.provider === b.siyuan?.provider
        && a.sources.length === b.sources.length
        && a.sources.every((source, index) => sameSource(source, b.sources[index]));
}

/**
 * 保存配置。
 *
 * 手动凭据必须先封成信封；任何一条封不上就整体失败，不写半套配置，
 * 也不把明文落盘。思源导入那一条只落盘名字，地址与凭据一律不写。
 * 写完读回校验，防止 saveData 提前 resolve 却没真正落盘。
 */
export async function saveSettings(plugin: Plugin, settings: PluginSettings): Promise<PluginSettings> {
    const next: PluginSettings = {
        ...settings,
        sources: settings.sources.map((source) => ({...source, buckets: [...source.buckets]})),
    };
    const manual = next.sources.filter((source) => !source.useSyncConfig);
    const siyuan = next.sources.find((source) => source.useSyncConfig);
    const storedSources: StoredSource[] = [];
    for (const source of manual) {
        let credentials = source.credentials;
        if (source.accessKey !== "" || source.secretKey !== "") {
            const sealed = await sealCredentials({
                accessKey: source.accessKey,
                secretKey: source.secretKey,
            });
            if ("failure" in sealed) {
                const messages: Record<EncryptFailure, string> = {
                    noRepoKey: "The SiYuan data repo key is not initialized",
                    noWebCrypto: "WebCrypto is unavailable in this environment",
                    failed: "Encryption failed",
                };
                throw new SettingsError(messages[sealed.failure], sealed.failure);
            }
            credentials = sealed.envelope;
        }
        storedSources.push({
            id: source.id,
            // 与读回时的归一化保持一致：否则用户填了不带协议头的 Endpoint，精确校验会误报失败
            name: text(source.name) || source.id,
            provider: source.provider,
            buckets: parseBucketList(source.buckets.join("\n")),
            endpoint: normalizeEndpoint(source.endpoint),
            region: text(source.region),
            accountId: text(source.accountId),
            credentials,
        });
    }
    const storedSiyuanName = siyuan === undefined ? undefined : text(siyuan.name);
    // 先按读回时的规则归一化再写：否则越界超时、重复 id 这类值写进去会被读回时钳制，
    // 紧接着的精确比对必然失败，用户看到「保存失败」但数据其实已经落盘。
    const stored: StoredSettings = mergeStoredSettings({
        version: 1,
        timeoutSeconds: next.timeoutSeconds,
        testTimeoutSeconds: next.testTimeoutSeconds,
        refreshMinutes: next.refreshMinutes,
        sources: storedSources,
        ...(storedSiyuanName === undefined ? {} : {siyuan: {name: storedSiyuanName, provider: siyuan?.providerOverride}}),
    });
    const response = await plugin.saveData(STORAGE_NAME, stored) as {code?: number; msg?: string} | undefined;
    if (response && typeof response.code === "number" && response.code !== 0) {
        throw new SettingsError(response.msg || `saveData code ${response.code}`, "verify");
    }
    const verified = mergeStoredSettings(await plugin.loadData(STORAGE_NAME));
    if (!sameStoredSettings(stored, verified)) {
        throw new SettingsError("Saved data did not match what was written", "verify");
    }
    const persistedById = new Map(stored.sources.map((source) => [source.id, source]));
    return {
        ...next,
        // 返回落盘后的归一化字段：内存里不能留着被钳制掉的值，否则界面显示与磁盘不一致
        timeoutSeconds: stored.timeoutSeconds,
        testTimeoutSeconds: stored.testTimeoutSeconds,
        refreshMinutes: stored.refreshMinutes,
        sources: [
            // 按 id 关联而不是按下标：mergeStoredSettings 会去重、迁移旧条目，
            // 下标一旦错位，界面拿到的就是别的数据源的字段。
            ...manual.map((source) => {
                const persisted = persistedById.get(source.id);
                if (!persisted) {
                    return source;
                }
                return {
                    ...source,
                    name: persisted.name,
                    buckets: [...persisted.buckets],
                    endpoint: persisted.endpoint,
                    region: persisted.region,
                    accountId: persisted.accountId,
                    credentials: persisted.credentials,
                };
            }),
            // 思源导入那一条的其余字段是运行时读出来的，按落盘后的名字与服务商重建
            ...(storedSiyuanName === undefined ? [] : [siyuanRuntimeSource(storedSiyuanName, stored.siyuan?.provider)]),
        ],
    };
}
