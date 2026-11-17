/** Vitest 宿主替身；只有传输层测试会 mock 其中的方法。 */
export async function fetchSyncPost(): Promise<never> {
    throw new Error("fetchSyncPost must be mocked in tests");
}
