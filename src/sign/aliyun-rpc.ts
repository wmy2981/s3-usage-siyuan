/**
 * 阿里云 RPC 风格签名（SignatureVersion 1.0，HMAC-SHA1）。
 *
 * 云监控的 OpenAPI 属于 RPC 风格：所有参数都在 query 里，公共参数（Action、Version、
 * Timestamp、SignatureNonce 等）与业务参数一起参与签名。签名规则见官方「RPC 签名机制」：
 * 参数按名称字典序排序 → percentEncode → 拼 `k=v&...` → StringToSign 再各编码一次。
 *
 * 与 OSS 的 V1/V4 签名不同，这里不需要 AccessKey 前缀，也不涉及 x-oss-* 头。
 */
import {aliyunEncode, hmac, randomNonce, toBase64} from "./util";

export interface AliyunRpcOptions {
    /** 例如 https://metrics.cn-hangzhou.aliyuncs.com */
    endpoint: string;
    action: string;
    version: string;
    /** 业务参数；公共参数由本函数补齐。 */
    params: Record<string, string>;
    accessKey: string;
    secretKey: string;
    date?: Date;
    /** 固定 nonce 便于测试；默认随机。 */
    nonce?: string;
}

/** 生成带签名的完整 GET URL（阿里云 RPC 接口只接受 GET/POST，这里统一用 GET）。 */
export async function aliyunRpcUrl(options: AliyunRpcOptions): Promise<string> {
    const date = options.date ?? new Date();
    const params: Record<string, string> = {
        ...options.params,
        AccessKeyId: options.accessKey,
        Action: options.action,
        Format: "JSON",
        SignatureMethod: "HMAC-SHA1",
        SignatureNonce: options.nonce ?? randomNonce(),
        SignatureVersion: "1.0",
        Timestamp: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
        Version: options.version,
    };
    // 按参数名排序后逐项 percentEncode；值里的中文/空格都走同一套规则
    const canonical = Object.keys(params)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((name) => `${aliyunEncode(name)}=${aliyunEncode(params[name])}`)
        .join("&");
    const stringToSign = `GET&${aliyunEncode("/")}&${aliyunEncode(canonical)}`;
    const signature = toBase64(await hmac("SHA-1", `${options.secretKey}&`, stringToSign));
    return `${options.endpoint}/?${canonical}&Signature=${aliyunEncode(signature)}`;
}
