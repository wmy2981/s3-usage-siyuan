import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

export default defineConfig({
    resolve: {
        alias: {siyuan: fileURLToPath(new URL("./tests/siyuan-stub.ts", import.meta.url))},
    },
    test: {
        // 只测纯函数与协议解析，不启动思源，也不需要 DOM
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // 容器里进程数受限时，默认的多进程 worker 会 EAGAIN；顺序执行足够
        fileParallelism: false,
    },
});
