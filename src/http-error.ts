/** HTTP 错误体的解析：不依赖 siyuan 运行时，便于纯函数测试。 */

export function parseJsonBody(body: string): unknown {
    try {
        return JSON.parse(body);
    } catch {
        return undefined;
    }
}

/** 把服务端错误体压成一句话；不包含任何请求头。 */
export function serverErrorText(status: number, body: string): string {
    const trimmed = body.trim();
    if (trimmed === "") {
        return `HTTP ${status}`;
    }
    const json = parseJsonBody(trimmed);
    if (json && typeof json === "object") {
        const record = json as Record<string, unknown>;
        const response = record.Response as Record<string, unknown> | undefined;
        const error = (response?.Error ?? record.error ?? record) as Record<string, unknown>;
        const message = error.Message ?? error.message ?? record.message ?? record.msg;
        if (typeof message === "string" && message.trim() !== "") {
            return `HTTP ${status}: ${message.trim()}`;
        }
    }
    if (trimmed.startsWith("<")) {
        const code = /<Code>([^<]+)<\/Code>/.exec(trimmed)?.[1];
        const message = /<Message>([^<]+)<\/Message>/.exec(trimmed)?.[1];
        const combined = [code, message].filter(Boolean).join(": ");
        if (combined !== "") {
            return `HTTP ${status}: ${combined}`;
        }
    }
    return `HTTP ${status}: ${trimmed.slice(0, 300)}`;
}
