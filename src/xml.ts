/** XML/JSON 读写的小工具，避免每个适配器重复写一遍防御性判断。 */
import {XMLParser} from "fast-xml-parser";

const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    trimValues: true,
    // 保留字符串：桶存量和对象数可能超过 2^53 的边界情况由调用方决定怎么处理
    parseTagValue: false,
});

export type UnknownRecord = Record<string, unknown>;

export function parseXml(body: string): UnknownRecord | undefined {
    try {
        const parsed = parser.parse(body);
        return parsed && typeof parsed === "object" ? parsed as UnknownRecord : undefined;
    } catch {
        return undefined;
    }
}

/** 按属性名取对象；数组只取第一项（这些接口的根节点不会重复）。 */
export function recordAt(value: unknown, key: string): UnknownRecord | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const field = (value as UnknownRecord)[key];
    if (Array.isArray(field)) {
        return field[0] && typeof field[0] === "object" ? field[0] as UnknownRecord : undefined;
    }
    return field && typeof field === "object" ? field as UnknownRecord : undefined;
}

/** 取字符串字段，去掉首尾空白。 */
export function stringAt(value: unknown, key: string): string {
    if (!value || typeof value !== "object") {
        return "";
    }
    const field = (value as UnknownRecord)[key];
    if (typeof field === "string") {
        return field.trim();
    }
    if (typeof field === "number") {
        return String(field);
    }
    return "";
}

/** 取数字字段；缺失或非法时返回 undefined（0 与「没这个字段」必须区分）。 */
export function numberAt(value: unknown, key: string): number | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const field = (value as UnknownRecord)[key];
    const parsed = typeof field === "number" ? field : Number(field);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** 取数组字段；单元素时 fast-xml-parser 会给对象，统一成数组。 */
export function arrayAt(value: unknown, key: string): unknown[] {
    if (!value || typeof value !== "object") {
        return [];
    }
    const field = (value as UnknownRecord)[key];
    if (Array.isArray(field)) {
        return field;
    }
    return field === undefined || field === null ? [] : [field];
}

/** 从 JSON 对象按路径取值；路径不存在时返回 undefined。 */
export function jsonPath(value: unknown, ...keys: string[]): unknown {
    let current: unknown = value;
    for (const key of keys) {
        if (!current || typeof current !== "object") {
            return undefined;
        }
        current = (current as UnknownRecord)[key];
    }
    return current;
}

/** 把 JSON 里的数字/字符串统一成 number；null、空串与布尔值视为「没有值」，不能当 0。 */
export function asNumber(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
