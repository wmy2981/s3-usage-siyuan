/** 异步工具：并发受限的 map，避免一次刷新就把云厂商的限流额度打满。 */

/**
 * 按并发上限执行 map，结果顺序与入参一致。
 *
 * 与 `Promise.all` 的区别只在并发数：云监控接口普遍按秒限流，
 * 一个桶要查十几个指标时并发全开很容易被拒。
 */
export async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await run(items[index]);
        }
    }));
    return results;
}
