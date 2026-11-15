/** 签名与编码的底层工具：WebCrypto 实现，不引第三方加密库。 */

const encoder = new TextEncoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(value);
}

export function toHex(bytes: Uint8Array): string {
    let result = "";
    for (const byte of bytes) {
        result += byte.toString(16).padStart(2, "0");
    }
    return result;
}

export function fromHex(value: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/** 七牛要求 URL-safe base64 且去掉 `=` 填充。 */
export function toBase64UrlNoPadding(bytes: Uint8Array): string {
    return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(value)));
}

export async function sha256Hex(value: string): Promise<string> {
    return toHex(await sha256(value));
}

export async function hmac(
    hash: "SHA-1" | "SHA-256" | "SHA-512",
    key: Uint8Array | string,
    value: string,
): Promise<Uint8Array<ArrayBuffer>> {
    const keyBytes: Uint8Array<ArrayBuffer> = typeof key === "string" ? utf8(key) : new Uint8Array(key);
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        {name: "HMAC", hash},
        false,
        ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8(value)));
}

export async function hmacSha256Hex(key: Uint8Array | string, value: string): Promise<string> {
    return toHex(await hmac("SHA-256", key, value));
}

/**
 * AWS 风格 URI 编码：只保留 `A-Z a-z 0-9 - _ . ~`，其余按 UTF-8 百分号编码。
 * 与 `encodeURIComponent` 的差别是它不编码 `!'()*`，这里必须编码。
 */
export function uriEncode(value: string, encodeSlash = true): string {
    let result = "";
    for (const byte of utf8(value)) {
        const char = String.fromCharCode(byte);
        if (
            (byte >= 0x30 && byte <= 0x39) ||
            (byte >= 0x41 && byte <= 0x5a) ||
            (byte >= 0x61 && byte <= 0x7a) ||
            char === "-" || char === "_" || char === "." || char === "~"
        ) {
            result += char;
        } else if (char === "/" && !encodeSlash) {
            result += "/";
        } else {
            result += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        }
    }
    return result;
}

/** 规范化查询串：按编码后的键、值排序，空值保留 `=`。 */
export function canonicalQuery(params: Record<string, string | undefined>): string {
    return Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [uriEncode(key), uriEncode(value ?? "")] as const)
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
            leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
        )
        .map(([key, value]) => `${key}=${value}`)
        .join("&");
}

/** 头值规范化：去掉首尾空白，把连续空白折叠为一个空格。 */
export function canonicalHeaderValue(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

/** 2026-11-15T12:00:00.000Z → {amzDate: 20261115T120000Z, dateStamp: 20261115} */
export function amzDateParts(date: Date): {amzDate: string; dateStamp: string} {
    const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    return {amzDate: iso, dateStamp: iso.slice(0, 8)};
}

/** RFC 1123（`Date` 头）时间。 */
export function rfc1123(date: Date): string {
    return date.toUTCString();
}

/**
 * 阿里云 RPC 签名要求的 percentEncode。
 *
 * 官方规定在 `encodeURIComponent` 之后再把 `+` 换成 `%20`、`*` 换成 `%2A`、
 * `%7E` 还原成 `~`；`!'()` 保持不编码，这一点与 AWS 的 `uriEncode` 不同。
 */
export function aliyunEncode(value: string): string {
    return encodeURIComponent(value)
        .replaceAll("+", "%20")
        .replaceAll("*", "%2A")
        .replaceAll("%7E", "~");
}

/** 签名 nonce；优先用 WebCrypto，退化到时间 + 随机串。 */
export function randomNonce(): string {
    const api = typeof crypto === "undefined" ? undefined : crypto;
    if (api && typeof api.randomUUID === "function") {
        return api.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 取 Object 上的字符串字段；不是字符串就当空串。 */
export function stringField(value: unknown, key: string): string {
    if (!value || typeof value !== "object") {
        return "";
    }
    const field = (value as Record<string, unknown>)[key];
    return typeof field === "string" ? field : "";
}

/** 解析数字字段；缺失/非法时返回 undefined，而不是 0。 */
export function numberField(value: unknown, key: string): number | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const field = (value as Record<string, unknown>)[key];
    const parsed = typeof field === "number" ? field : Number(field);
    return Number.isFinite(parsed) ? parsed : undefined;
}
