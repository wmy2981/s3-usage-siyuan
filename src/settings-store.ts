/**
 * 配置读写与凭据加解密的编排。
 *
 * 落盘只写密文；内存里的明文不落盘。读回时逐条解封，解不开只标记该数据源，
 * 不影响其他数据源继续工作。
 */
import type {Plugin} from "siyuan";
import {
    mergeStoredSettings,
    STORAGE_NAME,
    type DataSource,
    type PluginSettings,
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
            accessKey: "",
            secretKey: "",
            credentialsError: false,
            credentialsErrorReason: "",
        };
        if (!source.useSyncConfig && source.credentials) {
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
    return {
        version: 1,
        timeoutSeconds: stored.timeoutSeconds,
        sources,
    };
}

/**
 * 保存配置。
 *
 * 手动凭据必须先封成信封；任何一条封不上就整体失败，不写半套配置，
 * 也不把明文落盘。写完读回校验，防止 saveData 提前 resolve 却没真正落盘。
 */
export async function saveSettings(plugin: Plugin, settings: PluginSettings): Promise<PluginSettings> {
    const next: PluginSettings = {
        ...settings,
        sources: settings.sources.map((source) => ({...source, buckets: [...source.buckets]})),
    };
    const storedSources: StoredSource[] = [];
    for (const source of next.sources) {
        let credentials = source.credentials;
        if (!source.useSyncConfig) {
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
        } else {
            credentials = undefined;
        }
        storedSources.push({
            id: source.id,
            name: source.name,
            provider: source.provider,
            buckets: source.buckets,
            endpoint: source.endpoint,
            region: source.region,
            accountId: source.accountId,
            useSyncConfig: source.useSyncConfig,
            credentials,
        });
    }
    const stored = {
        version: 1 as const,
        timeoutSeconds: next.timeoutSeconds,
        sources: storedSources,
    };
    const response = await plugin.saveData(STORAGE_NAME, stored) as {code?: number; msg?: string} | undefined;
    if (response && typeof response.code === "number" && response.code !== 0) {
        throw new SettingsError(response.msg || `saveData code ${response.code}`, "verify");
    }
    const verified = mergeStoredSettings(await plugin.loadData(STORAGE_NAME));
    if (verified.sources.length !== stored.sources.length) {
        throw new SettingsError("Saved data could not be read back", "verify");
    }
    return {
        ...next,
        sources: next.sources.map((source, index) => ({
            ...source,
            credentials: stored.sources[index]?.credentials,
        })),
    };
}
