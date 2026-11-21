/** 请求诊断与错误格式化：保留完整信息，只脱敏凭据。 */
import type {ForwardRequest, ForwardResponse} from "./providers/types";

const SENSITIVE_HEADERS = new Set([
    "authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "x-security-token",
    "x-session-token",
    "x-amz-security-token",
    "x-tc-token",
]);

export function redact(text: string): string {
    return text
        // 认证头先整段抹掉：否则通用规则只吃掉认证方案名，令牌会留在行尾
        .replace(/(authorization"?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\r\n]+)/gi, "$1[REDACTED]")
        .replace(/\b(Bearer|Qiniu)\s+[^\s,;]+/gi, "$1 [REDACTED]")
        // OSS / OBS / QBox 的认证格式是「方案 + AccessKey:Signature」，
        // 只认这种令牌形状，避免把 “Unexpected OSS response” 这类正文一起吃掉
        .replace(/\b(OSS|OBS|QBox)\s+[A-Za-z0-9._~-]+:[A-Za-z0-9+/=_.~-]+/gi,
            (_match, scheme: string) => `${scheme} [REDACTED]`)
        .replace(/(Credential=)([^/,\s]+)/gi, "$1[REDACTED]")
        // 华为云 SDK-HMAC-SHA256 的 Authorization 形如 `Access=<AK>, SignedHeaders=...`
        .replace(/\b(Access=)([^,;\s]+)/gi, "$1[REDACTED]")
        .replace(/((?:access_?key(?:id)?|secret(?:access)?_?key|secretid|secretkey|signature|api_?key|api_?token|token|password)"?\s*[=:]\s*)(?:"([^"]*)"|'([^']*)'|([^\s,;&]+))/gi,
            (_match, prefix: string) => `${prefix}[REDACTED]`);
}

function formatValue(value: unknown): string {
    if (typeof value === "string") {
        return redact(value);
    }
    if (value === undefined) {
        return "(undefined)";
    }
    try {
        return redact(JSON.stringify(value, null, 2));
    } catch {
        return redact(String(value));
    }
}

export function requestHeadersText(headers: Record<string, string>): string {
    return JSON.stringify(Object.fromEntries(Object.entries(headers).map(([name, value]) => [
        name,
        SENSITIVE_HEADERS.has(name.toLowerCase()) ? "[REDACTED]" : redact(value),
    ])), null, 2);
}

export function responseHeadersText(headers: Record<string, string[]> | null): string {
    if (!headers) {
        return formatValue(headers);
    }
    // 响应头同样可能回显 Set-Cookie、认证令牌等敏感值，与请求头共用同一份敏感名单
    return JSON.stringify(Object.fromEntries(Object.entries(headers).map(([name, values]) => [
        name,
        SENSITIVE_HEADERS.has(name.toLowerCase())
            ? ["[REDACTED]"]
            : (Array.isArray(values) ? values : [String(values)]).map((value) => redact(value)),
    ])), null, 2);
}

/** 不把原始响应压成一行，也不截断；错误码、RequestId 等全部保留。 */
export function responseBodyText(body: string): string {
    return redact(body === "" ? "(empty response body)" : body);
}

export function diagnosticSection(title: string, content: string): string {
    return `\n\n===== ${title} =====\n${content}`;
}

/** 请求上下文文本；只在真正需要展示错误时调用。 */
export function requestDetailsText(request: ForwardRequest, timeoutMs: number): string {
    // URL 也要脱敏：阿里云 RPC 把 AccessKeyId 与 Signature 放在 query 里
    return `Method: ${request.method}\nURL: ${redact(request.url)}\nTimeout: ${timeoutMs} ms\n` +
        `Content-Type: ${request.contentType}` +
        diagnosticSection("Request headers", requestHeadersText(request.headers)) +
        diagnosticSection("Request body", redact(request.body ?? "(empty request body)"));
}

/** 失败响应的请求上下文段落；成功响应没有 diagnostics，也就没有格式化开销。 */
export function requestSection(response: ForwardResponse): string {
    if (!response.diagnostics) {
        return "";
    }
    return diagnosticSection("Request", requestDetailsText(
        response.diagnostics.request,
        response.diagnostics.timeoutMs,
    ));
}

/** Error 的 message/name/stack/cause 都输出，避免只留一句概括。 */
export function detailedErrorText(error: unknown): string {
    if (error instanceof Error) {
        const lines = [`${error.name}: ${error.message}`];
        if (error.stack !== undefined) {
            lines.push(`Stack:\n${error.stack}`);
        }
        if (error.cause !== undefined) {
            lines.push(`Cause:\n${detailedErrorText(error.cause)}`);
        }
        return redact(lines.join("\n"));
    }
    return formatValue(error);
}
