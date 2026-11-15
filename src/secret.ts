/**
 * 凭据的落盘加密。
 *
 * 明文只存在于内存与编辑表单里：写进插件目录前换成 AES-GCM 信封，读回来时再解回明文。
 * 密钥取自思源的**数据仓库密钥**（`window.siyuan.config.repo.key`，32 字节随机数的 base64）。
 * 这样密文随插件数据同步到其他设备后，只要那台设备用的是同一个数据仓库密钥就能解开，
 * 不需要用户再记一个插件专用口令。
 *
 * 三个必须直说的边界：
 * 1. 思源不会自动生成数据仓库密钥；没初始化过时这里是空串，此时拒绝保存手动凭据，
 *    不退回明文（复用思源 S3 同步配置的数据源不需要存凭据，仍然可用）。
 * 2. 用户重置/更换数据仓库密钥后旧密文解不开；这不是配置错误，按「清空凭据、需要重填」处理。
 * 3. 通过 `http://局域网 IP:6806` 打开的思源不是安全上下文，`crypto.subtle` 不存在；
 *    这是「这里解不了」而不是「密文坏了」，密文要原样保留，换到桌面端或 127.0.0.1 还能解开。
 */
import {repoKeyBase64} from "./config";

/** 信封格式：`v1:<iv-base64>:<ciphertext-base64>`。 */
const ENVELOPE_VERSION = "v1";
/** HKDF 域分离标签：仓库密钥在思源那边用于快照加密，这里派生出一把独立的成品密钥。 */
const HKDF_INFO = "s3-usage-siyuan/credentials";
const IV_BYTES = 12;
const TAG_BITS = 128;

export type EncryptFailure = "noRepoKey" | "noWebCrypto" | "failed";
export type UnsealResult =
    | {status: "ok"; value: string}
    | {status: "unreadable"}
    | {status: "unavailable"};

function subtleCrypto(): SubtleCrypto | undefined {
    return typeof crypto === "undefined" ? undefined : crypto.subtle;
}

export function hasRepoKey(): boolean {
    return repoKeyBase64() !== "";
}

export function hasWebCrypto(): boolean {
    return subtleCrypto() !== undefined;
}

/** 当前环境能不能加密；设置页据此提示为什么不能保存手动凭据。 */
export function canEncrypt(): boolean {
    return hasRepoKey() && hasWebCrypto();
}

export function encryptionFailureReason(): EncryptFailure | undefined {
    if (!hasRepoKey()) {
        return "noRepoKey";
    }
    if (!hasWebCrypto()) {
        return "noWebCrypto";
    }
    return undefined;
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

/** 数据仓库密钥 → AES-GCM 密钥；取不到或格式不对时返回 undefined，绝不抛错。 */
async function deriveKey(): Promise<CryptoKey | undefined> {
    const subtle = subtleCrypto();
    const raw = repoKeyBase64();
    if (!subtle || raw === "") {
        return undefined;
    }
    try {
        const key = fromBase64(raw);
        if (key.length === 0) {
            return undefined;
        }
        const material = await subtle.importKey("raw", key, "HKDF", false, ["deriveKey"]);
        return await subtle.deriveKey(
            {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(0),
                info: new TextEncoder().encode(HKDF_INFO),
            },
            material,
            {name: "AES-GCM", length: 256},
            false,
            ["encrypt", "decrypt"],
        );
    } catch {
        return undefined;
    }
}

/** 明文 → 信封。不能加密时返回失败原因，由调用方决定提示什么。 */
export async function sealText(
    plain: string,
): Promise<{envelope: string} | {failure: EncryptFailure}> {
    const failure = encryptionFailureReason();
    if (failure) {
        return {failure};
    }
    const subtle = subtleCrypto();
    const key = await deriveKey();
    if (!subtle || !key) {
        return {failure: "failed"};
    }
    try {
        const iv = new Uint8Array(IV_BYTES);
        crypto.getRandomValues(iv);
        const ciphertext = new Uint8Array(
            await subtle.encrypt(
                {name: "AES-GCM", iv, tagLength: TAG_BITS},
                key,
                new TextEncoder().encode(plain),
            ),
        );
        return {envelope: `${ENVELOPE_VERSION}:${toBase64(iv)}:${toBase64(ciphertext)}`};
    } catch {
        return {failure: "failed"};
    }
}

/** 信封 → 明文。任何异常都折叠成状态，不往外抛。 */
export async function unsealText(envelope: string): Promise<UnsealResult> {
    const parts = envelope.split(":");
    if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
        return {status: "unreadable"};
    }
    if (!hasWebCrypto()) {
        return {status: "unavailable"};
    }
    const subtle = subtleCrypto();
    const key = await deriveKey();
    if (!subtle || !key) {
        return {status: "unreadable"};
    }
    try {
        const plain = await subtle.decrypt(
            {name: "AES-GCM", iv: fromBase64(parts[1]), tagLength: TAG_BITS},
            key,
            fromBase64(parts[2]),
        );
        return {status: "ok", value: new TextDecoder().decode(plain)};
    } catch {
        return {status: "unreadable"};
    }
}

/** 一条数据源的手动凭据。R2 只有 API Token，secret 为空。 */
export interface SourceCredentials {
    accessKey: string;
    secretKey: string;
}

/** 序列化后加密成信封。 */
export async function sealCredentials(
    credentials: SourceCredentials,
): Promise<{envelope: string} | {failure: EncryptFailure}> {
    return sealText(JSON.stringify({
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey,
    }));
}

/** 解开信封；返回值里的 `status` 区分「坏了」与「当前环境解不了」。 */
export async function unsealCredentials(envelope: string): Promise<
    | {status: "ok"; credentials: SourceCredentials}
    | {status: "unreadable"}
    | {status: "unavailable"}
> {
    const result = await unsealText(envelope);
    if (result.status !== "ok") {
        return result;
    }
    try {
        const parsed = JSON.parse(result.value) as Partial<SourceCredentials>;
        return {
            status: "ok",
            credentials: {
                accessKey: typeof parsed.accessKey === "string" ? parsed.accessKey : "",
                secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey : "",
            },
        };
    } catch {
        return {status: "unreadable"};
    }
}
