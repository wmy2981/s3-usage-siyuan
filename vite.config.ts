import {defineConfig} from "vite";

// 思源插件入口固定为包内根目录的 index.js，CSS 固定为 index.css；
// siyuan 模块由宿主在运行时注入，必须保持 external。
//
// 产物必须是 CommonJS：宿主在 app/src/plugin/loader.ts 里把插件代码包进
// (function anonymous(require, module, exports){...}) 再 window.eval，
// ESM 输出会在第一行 import 处直接抛 SyntaxError。
export default defineConfig(({mode}) => ({
    build: {
        outDir: "dist",
        emptyOutDir: true,
        minify: mode === "production",
        sourcemap: mode !== "production",
        lib: {
            entry: "src/index.ts",
            formats: ["cjs"],
            fileName: () => "index.js",
            cssFileName: "index",
        },
        rollupOptions: {
            external: ["siyuan"],
        },
    },
}));
