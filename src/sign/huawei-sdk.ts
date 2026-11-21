/**
 * 华为云 OpenAPI 的 AK/SK 签名（SDK-HMAC-SHA256）。
 *
 * 云监控 CES 走 API 网关，用的不是 OBS 的 `OBS <AK>:<sig>`（HMAC-SHA1），而是
 * `SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=..., Signature=...`：直接以 SK 为密钥
 * 对 StringToSign 做一次 HMAC-SHA256，没有 AWS 那样的日期/地域派生链。
 *
 * 两个容易踩的点：
 * 1. 计算签名时 CanonicalURI 必须以 `/` 结尾（实际发送的 URL 可以不带）。
 * 2. CanonicalHeaders 每行自带换行，与下一段拼接后会多出一个空行，这是官方规定。
 */
import {byCodePoint, canonicalHeaderValue, hmac, sha256Hex, toHex, uriEncode} from "./util";

export interface HuaweiSdkOptions {
    method: string;
    /** 必须用 `huaweiUrl()` 生成，保证 query 与签名串逐字一致。 */
    url: string;
    headers?: Record<string, string>;
    payload?: string;
    accessKey: string;
    secretKey: string;
    date?: Date;
}

export interface HuaweiSignedParts {
    sdkDate: string;
    signedHeaders: string;
    canonicalRequest: string;
    /** 需要随请求发送的头（含 host、x-sdk-date 与调用方传入的头）。 */
    headers: Record<string, string>;
}

/** 按签名规则拼 URL：参数名升序，名与值都做 RFC3986 编码。 */
export function huaweiUrl(base: string, params: Record<string, string>): string {
    const query = Object.keys(params)
        .sort(byCodePoint)
        .map((name) => `${uriEncode(name)}=${uriEncode(params[name])}`)
        .join("&");
    return query === "" ? base : `${base}?${query}`;
}

/** 构造规范请求；单独导出便于用官方示例的哈希做回归。 */
export async function huaweiSignedParts(options: HuaweiSdkOptions): Promise<HuaweiSignedParts> {
    const url = new URL(options.url);
    const method = options.method.toUpperCase();
    const payload = options.payload ?? "";
    const date = options.date ?? new Date();
    const sdkDate = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = {
        ...options.headers,
        host: url.host,
        "x-sdk-date": sdkDate,
    };
    const entries = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)] as const)
        .sort(([left], [right]) => byCodePoint(left, right));
    const signedHeaders = entries.map(([name]) => name).join(";");
    const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join("");

    const canonicalRequest = [
        method,
        canonicalPath(url.pathname),
        canonicalQuery(url),
        canonicalHeaders,
        signedHeaders,
        await sha256Hex(payload),
    ].join("\n");
    return {sdkDate, signedHeaders, canonicalRequest, headers};
}

/** 计算签名并返回需要随请求发送的头（含 host、x-sdk-date 与 Authorization）。 */
export async function signHuaweiSdk(options: HuaweiSdkOptions): Promise<Record<string, string>> {
    const parts = await huaweiSignedParts(options);
    const stringToSign = [
        "SDK-HMAC-SHA256",
        parts.sdkDate,
        await sha256Hex(parts.canonicalRequest),
    ].join("\n");
    const signature = toHex(await hmac("SHA-256", options.secretKey, stringToSign));
    return {
        ...parts.headers,
        Authorization: `SDK-HMAC-SHA256 Access=${options.accessKey}, SignedHeaders=${parts.signedHeaders}, ` +
            `Signature=${signature}`,
    };
}

/** 路径逐段编码，并补上签名要求的结尾 `/`。 */
export function canonicalPath(pathname: string): string {
    const path = pathname === "" ? "/" : pathname;
    const encoded = path.split("/").map((segment) => uriEncode(segment)).join("/");
    return encoded.endsWith("/") ? encoded : `${encoded}/`;
}

/** 查询串按名称升序重排，名与值都重新编码；空值保留 `=`。 */
export function canonicalQuery(url: URL): string {
    const pairs: [string, string][] = [];
    for (const [name, value] of url.searchParams.entries()) {
        pairs.push([uriEncode(name), uriEncode(value)]);
    }
    return pairs
        .sort(([leftName, leftValue], [rightName, rightValue]) =>
            byCodePoint(leftName, rightName) || byCodePoint(leftValue, rightValue)
        )
        .map(([name, value]) => `${name}=${value}`)
        .join("&");
}
