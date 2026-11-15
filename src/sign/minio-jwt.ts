/**
 * MinIO 指标端点的 JWT（HS512）。
 *
 * `mc admin prometheus generate` 生成的就是这个 token：header 是标准 JWT，claims 只有
 * `exp`（签发后 100 年）、`sub`（Access Key）与 `iss: "prometheus"`，用对应 Secret Key
 * 做 HMAC-SHA512 签名。服务端只校验签名与 `admin:Prometheus` 权限，不关心其余声明。
 */
import {hmac, toBase64UrlNoPadding, utf8} from "./util";

const LIFETIME_SECONDS = 100 * 365 * 24 * 60 * 60;

export async function minioMetricsToken(
    accessKey: string,
    secretKey: string,
    date = new Date(),
): Promise<string> {
    const header = toBase64UrlNoPadding(utf8(JSON.stringify({alg: "HS512", typ: "JWT"})));
    const payload = toBase64UrlNoPadding(utf8(JSON.stringify({
        exp: Math.floor(date.getTime() / 1000) + LIFETIME_SECONDS,
        sub: accessKey,
        iss: "prometheus",
    })));
    const signingInput = `${header}.${payload}`;
    const signature = toBase64UrlNoPadding(await hmac("SHA-512", utf8(secretKey), signingInput));
    return `${signingInput}.${signature}`;
}
