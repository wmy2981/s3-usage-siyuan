/**
 * 网络传输：所有服务商请求都经内核的 `/api/network/forwardProxy` 发出。
 *
 * 渲染进程直连第三方对象存储会撞上跨域预检：桶上没有 CORS 规则时浏览器只给一个
 * `Failed to fetch`，桌面端与移动端还不一致。交给内核发请求后两端走同一条路，
 * 也顺带复用内核自己的网络代理设置。
 *
 * 转发接口要求管理员角色；发布服务访客是只读角色，必然 403，界面会按「发不出去」提示。
 */
import {fetchSyncPost} from "siyuan";
import type {ForwardRequest, ForwardResponse} from "./providers/types";

const FORWARD_PROXY_API = "/api/network/forwardProxy";

/** 请求没能送达（内核拒绝、网络错误、超时），与「服务端明确返回 4xx/5xx」区分。 */
export class ForwardError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ForwardError";
    }
}

interface ForwardData {
    status?: number;
    body?: string;
    headers?: Record<string, string[]> | null;
}

interface ForwardEnvelope {
    code: number;
    msg?: string;
    data?: ForwardData | null;
}

/**
 * 发一次请求。
 *
 * `redirect: false` 是必须的：签名只覆盖原始 URL，跟随 301/302 后目标地址变了，
 * 签名必然对不上，最后只会得到一个莫名其妙的 403。
 */
export async function forward(request: ForwardRequest, timeoutMs: number): Promise<ForwardResponse> {
    const timeout = Math.min(120_000, Math.max(5_000, Math.round(timeoutMs)));
    let response: ForwardEnvelope;
    try {
        response = await fetchSyncPost(FORWARD_PROXY_API, {
            url: request.url,
            method: request.method,
            timeout,
            contentType: request.contentType,
            headers: Object.entries(request.headers).map(([name, value]) => ({[name]: value})),
            payload: request.body ?? "",
            payloadEncoding: "text",
            responseEncoding: "text",
            redirect: false,
        }) as unknown as ForwardEnvelope;
    } catch (error) {
        throw new ForwardError(error instanceof Error ? error.message : String(error));
    }
    if (response.code !== 0) {
        throw new ForwardError(response.msg || `forwardProxy code ${response.code}`);
    }
    const data = response.data;
    if (!data || typeof data.status !== "number") {
        throw new ForwardError("forwardProxy returned no response data");
    }
    return {
        status: data.status,
        body: typeof data.body === "string" ? data.body : "",
        headers: data.headers ?? null,
    };
}
