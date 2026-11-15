/** 展示层格式化：字节、数量、时间与 HTML 转义。 */

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];

/** 1024 进制换算，与各家控制台一致；`B` 不带小数。 */
export function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
        return "—";
    }
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? Math.round(value) : value.toFixed(2)} ${SIZE_UNITS[unit]}`;
}

/** 千分位计数；无值显示破折号。 */
export function formatCount(count: number | undefined): string {
    if (count === undefined || !Number.isFinite(count) || count < 0) {
        return "—";
    }
    return Math.round(count).toLocaleString();
}

/** 本地时间；0/非法值显示破折号。 */
export function formatTimestamp(timestamp: number | undefined): string {
    if (!timestamp || !Number.isFinite(timestamp)) {
        return "—";
    }
    return new Date(timestamp).toLocaleString();
}

/** 把错误对象变成一句可展示的文本。 */
export function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : String(error);
}
