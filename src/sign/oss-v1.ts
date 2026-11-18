/**
 * 阿里云 OSS 的 V1 签名与华为云 OBS 的 V2 签名。
 *
 * 两家都是「HMAC-SHA1 + base64 + Authorization: <Label> <AK>:<sig>」，待签字符串也几乎一样：
 *
 *   VERB \n Content-MD5 \n Content-Type \n Date \n CanonicalizedHeaders + CanonicalizedResource
 *
 * 差别只在厂商私有头的前缀（x-oss- / x-obs-）和 Authorization 标签。
 * Content-Type 必须与内核实际写到请求上的值完全一致——forwardProxy 会替我们写
 * `application/json`，所以这里也按这个值签。
 */
import {byCodePoint, hmac, rfc1123, toBase64} from "./util";

export interface V2SignOptions {
    method: string;
    url: string;
    bucket: string;
    /** 子资源，如 `stat` / `storageinfo`；桶根为空串。 */
    subresource: string;
    accessKey: string;
    secretKey: string;
    contentType: string;
    date?: Date;
    /** `x-oss-` 或 `x-obs-`。 */
    headerPrefix: string;
    /** 额外参与签名的厂商头。 */
    extraHeaders?: Record<string, string>;
}

/** 规范化资源：OSS/OBS 都要求 `/<bucket>/`，有子资源时接 `?subresource`。 */
export function canonicalResource(bucket: string, subresource: string): string {
    const base = `/${bucket}/`;
    return subresource === "" ? base : `${base}?${subresource}`;
}

/** 计算 V2 签名与需要发送的头。 */
export async function signV2(options: V2SignOptions): Promise<Record<string, string>> {
    const date = options.date ?? new Date();
    const dateText = rfc1123(date);
    const vendorHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
        if (name.toLowerCase().startsWith(options.headerPrefix)) {
            vendorHeaders[name.toLowerCase()] = value;
        }
    }
    const canonicalHeaders = Object.entries(vendorHeaders)
        .sort(([left], [right]) => byCodePoint(left, right))
        .map(([name, value]) => `${name}:${value.trim()}\n`)
        .join("");
    const stringToSign = [
        options.method.toUpperCase(),
        "",
        options.contentType,
        dateText,
        canonicalHeaders + canonicalResource(options.bucket, options.subresource),
    ].join("\n");
    const signature = toBase64(await hmac("SHA-1", options.secretKey, stringToSign));
    return {
        ...options.extraHeaders,
        Date: dateText,
        Authorization: `OSS ${options.accessKey}:${signature}`,
    };
}

/** 华为云 OBS 的标签是 `OBS`，其余步骤与 OSS 相同。 */
export async function signObsV2(options: Omit<V2SignOptions, "headerPrefix">): Promise<Record<string, string>> {
    const headers = await signV2({...options, headerPrefix: "x-obs-"});
    const authorization = headers.Authorization.replace(/^OSS /, "OBS ");
    return {...headers, Authorization: authorization};
}

/** 构造虚拟主机风格的桶根地址；endpoint 已经带桶名时原样使用。 */
export function virtualHostBucketUrl(endpoint: string, bucket: string, subresource = ""): string {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase().startsWith(`${bucket.toLowerCase()}.`)
        ? url.host
        : `${bucket}.${url.host}`;
    const query = subresource === "" ? "" : `?${subresource}`;
    return `${url.protocol}//${host}/${query}`;
}
