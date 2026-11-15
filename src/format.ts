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

/**
 * 卡片上的更新时间：当天只显示 HH:mm，跨天补上 MM-DD。
 * 用本地时钟手工拼接，避免不同系统 locale 下出现 12 小时制或多余秒。
 */
export function formatUpdatedAt(timestamp: number, now = Date.now()): string {
    if (!timestamp || !Number.isFinite(timestamp)) {
        return "—";
    }
    const date = new Date(timestamp);
    const current = new Date(now);
    const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const sameDay = date.getFullYear() === current.getFullYear()
        && date.getMonth() === current.getMonth()
        && date.getDate() === current.getDate();
    return sameDay ? time : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

/** 把错误对象变成一句可展示的文本。 */
export function errorText(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return typeof error === "string" ? error : String(error);
}
