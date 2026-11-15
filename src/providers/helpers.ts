/** 适配器共用的参数校验与请求辅助。 */
import type {DataSource} from "../config";
import {serverErrorText} from "../http-error";
import {normalizeEndpoint} from "../config";
import type {ForwardResponse} from "./types";
import {ProviderError} from "./types";

export function requireEndpoint(source: DataSource): string {
    const endpoint = normalizeEndpoint(source.endpoint);
    if (endpoint === "") {
        throw new ProviderError("Endpoint is required");
    }
    return endpoint;
}

export function requireRegion(source: DataSource): string {
    if (source.region.trim() === "") {
        throw new ProviderError("Region is required");
    }
    return source.region.trim();
}

export function requireAccountId(source: DataSource): string {
    if (source.accountId.trim() === "") {
        throw new ProviderError("Account ID is required");
    }
    return source.accountId.trim();
}

export function requireAccessKey(source: DataSource): string {
    if (source.accessKey.trim() === "") {
        throw new ProviderError("Access Key is required");
    }
    return source.accessKey.trim();
}

export function requireSecretKey(source: DataSource): string {
    if (source.secretKey.trim() === "") {
        throw new ProviderError("Secret Key is required");
    }
    return source.secretKey.trim();
}

/** 腾讯云 COS 的桶名必须以 `-APPID` 结尾；没填 Account ID 时从桶名里取。 */
export function cosAppId(source: DataSource, bucket: string): string {
    if (source.accountId.trim() !== "") {
        return source.accountId.trim();
    }
    const match = /-(\d+)$/.exec(bucket);
    if (match) {
        return match[1];
    }
    throw new ProviderError("APPID is required (bucket name must end with -APPID or fill in Account ID)");
}

/** 服务端返回非 2xx 时，把 XML/JSON 错误体压成一句可读文本。 */
export function providerError(status: number, body: string): ProviderError {
    return new ProviderError(serverErrorText(status, body));
}

/** 取 XML/JSON 响应前先按状态码拦截。 */
export function ensureOk(response: ForwardResponse): ForwardResponse {
    if (response.status < 200 || response.status >= 300) {
        throw providerError(response.status, response.body);
    }
    return response;
}
