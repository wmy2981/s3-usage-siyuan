/**
 * AWS Signature V4 的通用实现。
 *
 * AWS CloudWatch、MinIO 管理接口与火山引擎 TOS 都是同一套 HMAC 链，区别只在
 * 算法标签、日期头名、签名密钥前缀和 scope 终止串；这些差异全部由调用方显式传入，
 * 不靠猜。实现按 AWS 官方 SigV4 文档的步骤逐行对应，方便对账。
 */
import {
    amzDateParts,
    byCodePoint,
    canonicalHeaderValue,
    canonicalQuery,
    hmac,
    sha256Hex,
    toHex,
    uriEncode,
    utf8,
} from "./util";

export interface AwsV4Options {
    method: string;
    url: string;
    /** 参与签名的附加请求头（host 会自动加入）。 */
    headers?: Record<string, string>;
    payload?: string;
    service: string;
    region: string;
    accessKey: string;
    secretKey: string;
    date?: Date;
    /** 默认 AWS4-HMAC-SHA256。 */
    algorithm?: string;
    /** 默认 x-amz-date。 */
    dateHeader?: string;
    /** 默认 x-amz-content-sha256；传 null 表示不写这个头（火山引擎官方示例只签 host 与 x-date）。 */
    payloadHeader?: string | null;
    /** 签名密钥的前缀，默认 AWS4。 */
    keyPrefix?: string;
    /** scope 终止串，默认 aws4_request。 */
    terminal?: string;
    /** Authorization 的拼接风格：AWS 逗号后带空格，TOS 官方示例不带。 */
    authorizationStyle?: "aws" | "tos";
}

/** 计算签名并返回应随请求发送的全部头（含 host 与 Authorization）。 */
export async function signAwsV4(options: AwsV4Options): Promise<Record<string, string>> {
    const url = new URL(options.url);
    const method = options.method.toUpperCase();
    const payload = options.payload ?? "";
    const payloadHash = await sha256Hex(payload);
    const date = options.date ?? new Date();
    const {amzDate, dateStamp} = amzDateParts(date);
    const algorithm = options.algorithm ?? "AWS4-HMAC-SHA256";
    // 头名一律小写：否则调用方传入 "X-Amz-Date" 时会与这里补的同名头同时存在，
    // 规范化后 SignedHeaders 里出现两个相同头名，服务端必然拒签。
    const dateHeader = (options.dateHeader ?? "x-amz-date").toLowerCase();
    const payloadHeader = options.payloadHeader === null
        ? null
        : (options.payloadHeader ?? "x-amz-content-sha256").toLowerCase();
    const keyPrefix = options.keyPrefix ?? "AWS4";
    const terminal = options.terminal ?? "aws4_request";

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.headers ?? {})) {
        headers[name.toLowerCase()] = value;
    }
    headers.host = url.host;
    headers[dateHeader] = amzDate;
    if (payloadHeader !== null) {
        headers[payloadHeader] = payloadHash;
    }
    // 内核会自己写 Content-Length，签名里带上反而会与实际请求不一致
    delete headers["content-length"];

    const normalized = Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)] as const)
        .sort(([left], [right]) => byCodePoint(left, right));
    const signedHeaders = normalized.map(([name]) => name).join(";");
    const canonicalHeaders = normalized.map(([name, value]) => `${name}:${value}\n`).join("");

    const canonicalRequest = [
        method,
        canonicalUriOf(url),
        canonicalQueryOf(url),
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${options.region}/${options.service}/${terminal}`;
    const stringToSign = [algorithm, amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

    const keyDate = await hmac("SHA-256", `${keyPrefix}${options.secretKey}`, dateStamp);
    const keyRegion = await hmac("SHA-256", keyDate, options.region);
    const keyService = await hmac("SHA-256", keyRegion, options.service);
    const keySigning = await hmac("SHA-256", keyService, terminal);
    const signature = toHex(await hmac("SHA-256", keySigning, stringToSign));

    const separator = options.authorizationStyle === "tos" ? "," : ", ";
    return {
        ...headers,
        Authorization: `${algorithm} Credential=${options.accessKey}/${scope}${separator}` +
            `SignedHeaders=${signedHeaders}${separator}Signature=${signature}`,
    };
}

/** 路径按段编码，保留段之间的 `/`。 */
export function canonicalUriOf(url: URL): string {
    const path = url.pathname === "" ? "/" : url.pathname;
    return path.split("/").map((segment) => uriEncode(segment)).join("/");
}

/** 查询参数按编码后的键值排序；重复键只取第一个（本插件没有重复键的请求）。 */
export function canonicalQueryOf(url: URL): string {
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
        if (!(key in params)) {
            params[key] = value;
        }
    }
    return canonicalQuery(params);
}

/** 让调用方可以只用字符串签名而不关心 TextEncoder。 */
export function bytesOf(value: string): Uint8Array<ArrayBuffer> {
    return utf8(value);
}
