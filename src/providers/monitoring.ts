/** 监控类指标的公共约定：窗口统一取最近 24 小时，失败时保留存储数据。 */
import type {BucketUsage} from "./types";
import {detailedErrorText} from "../diagnostics";

/** 与 Cloudflare R2 保持一致的统计窗口。 */
export const MONITOR_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MetricsPart = Pick<BucketUsage, "trafficInBytes" | "trafficOutBytes" | "requestCount">;

/**
 * 监控接口与用量接口往往不是同一套权限。
 *
 * 监控查询失败时不把整张卡片变成错误，而是保留存储量与对象数，把原因记进 errors：
 * 缺监控权限、没开通计费、指标名变更都属于这类「能看容量、看不到流量」的场景。
 * 失败原因单独走 errors 通道，界面据此标红；普通的「数据延迟」说明仍留在 notes。
 */
export async function withMetrics(
    run: () => Promise<MetricsPart>,
    errors: string[],
): Promise<MetricsPart> {
    try {
        return await run();
    } catch (error) {
        errors.push("noteMetricsFailed");
        const message = detailedErrorText(error);
        if (message !== "") {
            errors.push(message);
        }
        return {};
    }
}

/** 求和；全部为空时返回 undefined，不用 0 冒充「没有数据」。 */
export function sumDefined(values: (number | undefined)[]): number | undefined {
    let total = 0;
    let seen = false;
    for (const value of values) {
        if (value === undefined || !Number.isFinite(value)) {
            continue;
        }
        total += value;
        seen = true;
    }
    return seen ? total : undefined;
}
