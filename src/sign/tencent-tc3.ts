/**
 * 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名。
 *
 * 与 AWS SigV4 的差别集中在三处：算法标签、签名密钥派生（`TC3` 前缀 + 服务名 + tc3_request）、
 * 以及 `x-tc-action` 参与签名时值要转小写（请求上仍按 `X-TC-Action: GetMonitorData` 发送）。
 * 这三处任何一处照 AWS 抄都会得到 SignatureFailure。
 */
import {hmac, sha256Hex, toHex, utf8} from "./util";

export interface Tc3Options {
    url: string;
    payload: string;
    service: string;
    region: string;
    secretId: string;
    secretKey: string;
    action: string;
    version: string;
    timestamp?: number;
}

/** 返回需要随请求发送的头；Host 由转发层按 URL 自动设置，这里只负责签它。 */
export async function signTc3(options: Tc3Options): Promise<Record<string, string>> {
    const url = new URL(options.url);
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const contentType = "application/json; charset=utf-8";
    const canonicalHeaders =
        `content-type:${contentType}\n` +
        `host:${url.host.toLowerCase()}\n` +
        `x-tc-action:${options.action.toLowerCase()}\n`;
    const signedHeaders = "content-type;host;x-tc-action";
    const hashedPayload = await sha256Hex(options.payload);
    const canonicalRequest = [
        "POST",
        "/",
        "",
        canonicalHeaders,
        signedHeaders,
        hashedPayload,
    ].join("\n");
    const scope = `${date}/${options.service}/tc3_request`;
    const stringToSign = [
        "TC3-HMAC-SHA256",
        String(timestamp),
        scope,
        await sha256Hex(canonicalRequest),
    ].join("\n");

    const secretDate = await hmac("SHA-256", utf8(`TC3${options.secretKey}`), date);
    const secretService = await hmac("SHA-256", secretDate, options.service);
    const secretSigning = await hmac("SHA-256", secretService, "tc3_request");
    const signature = toHex(await hmac("SHA-256", secretSigning, stringToSign));

    return {
        "Content-Type": contentType,
        "X-TC-Action": options.action,
        "X-TC-Version": options.version,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Region": options.region,
        Authorization: `TC3-HMAC-SHA256 Credential=${options.secretId}/${scope}, ` +
            `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
}
