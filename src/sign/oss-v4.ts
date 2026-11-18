/**
 * 阿里云 OSS V4 签名（OSS4-HMAC-SHA256）。
 *
 * 2025-09-01 起新建 Bucket 不能再使用 V1 签名，因此默认走 V4。V4 与 AWS SigV4 的
 * 关键差异：
 * 1. CanonicalRequest 有 6 段，比 AWS 多一段 AdditionalHeaders（没有可留空）；
 * 2. Canonical URI 要包含 `/{bucket}/`，即使请求是虚拟主机风格；
 * 3. 必须带 `x-oss-content-sha256`，无 body 时用 `UNSIGNED-PAYLOAD`；
 * 4. 签名密钥前缀是 `aliyun_v4`，scope 终止串是 `aliyun_v4_request`；
 * 5. Authorization 用逗号连接且不带空格，AdditionalHeaders 为空时整段省略。
 *
 * 空值子资源的 query 规范与 TOS 不同：OSS SDK 对空值只写参数名（`stat`），不补 `=`。
 */
import {amzDateParts, canonicalHeaderValue, fromHex, hmac, sha256Hex, toHex, uriEncode, utf8} from "./util";

export interface OssV4Options {
    method: string;
    url: string;
    bucket: string;
    /** 子资源名，例如 `stat`；为空表示桶根。 */
    subresource: string;
    accessKey: string;
    secretKey: string;
    region: string;
    contentType: string;
    date?: Date;
}

/** Canonical URI 包含桶名，路径编码保留 `/`。 */
export function ossV4CanonicalUri(bucket: string): string {
    return `/${uriEncode(bucket)}/`;
}

/** 空值子资源只写参数名，不补 `=`（与 OSS SDK 的 ParameterCollection 行为一致）。 */
export function ossV4CanonicalQuery(subresource: string): string {
    return subresource === "" ? "" : uriEncode(subresource);
}

/** 导出签名密钥派生，便于用官方示例的 SigningKey 做回归测试。 */
export async function ossV4SigningKey(secretKey: string, dateStamp: string, region: string): Promise<string> {
    const keyDate = await hmac("SHA-256", utf8(`aliyun_v4${secretKey}`), dateStamp);
    const keyRegion = await hmac("SHA-256", keyDate, region);
    const keyService = await hmac("SHA-256", keyRegion, "oss");
    const keySigning = await hmac("SHA-256", keyService, "aliyun_v4_request");
    return toHex(keySigning);
}

export async function signOssV4(options: OssV4Options): Promise<Record<string, string>> {
    const date = options.date ?? new Date();
    const {amzDate, dateStamp} = amzDateParts(date);
    // 默认参与 V4 签名的只有 content-type、content-md5 与全部 x-oss-* 头；
    // host 只有在 AdditionalHeaders（预签名 URL）里显式声明时才参与，Header 签名不能带上它。
    const canonicalHeaders =
        `content-type:${canonicalHeaderValue(options.contentType)}\n` +
        `x-oss-content-sha256:UNSIGNED-PAYLOAD\n` +
        `x-oss-date:${amzDate}\n`;
    // SDK 的拼接是：CanonicalHeaders（自带末尾换行）+ "\n" + AdditionalHeaders + "\n" + HashedPayload
    const canonicalRequest = [
        options.method.toUpperCase(),
        ossV4CanonicalUri(options.bucket),
        ossV4CanonicalQuery(options.subresource),
        canonicalHeaders,
        "",
        "UNSIGNED-PAYLOAD",
    ].join("\n");
    const scope = `${dateStamp}/${options.region}/oss/aliyun_v4_request`;
    const stringToSign = [
        "OSS4-HMAC-SHA256",
        amzDate,
        scope,
        await sha256Hex(canonicalRequest),
    ].join("\n");
    const keySigningHex = await ossV4SigningKey(options.secretKey, dateStamp, options.region);
    const keySigning = fromHex(keySigningHex);
    const signature = toHex(await hmac("SHA-256", keySigning, stringToSign));
    return {
        "x-oss-content-sha256": "UNSIGNED-PAYLOAD",
        "x-oss-date": amzDate,
        Authorization: `OSS4-HMAC-SHA256 Credential=${options.accessKey}/${scope},Signature=${signature}`,
    };
}
