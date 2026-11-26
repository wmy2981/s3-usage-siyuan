// 把 Vite 产物补全为可安装的插件包，并压成仓库根目录的 package.zip。
// 包内布局扁平：index.js  index.css  plugin.json  icon.png  preview.png  README*.md  i18n/
import {createWriteStream, existsSync, rmSync} from "node:fs";
import {cp, stat} from "node:fs/promises";
import path from "node:path";
import {ZipArchive} from "archiver";

const root = process.cwd();
const dist = path.join(root, "dist");

const entries = [
    ["plugin.json", "plugin.json"],
    ["assets/icon.png", "icon.png"],
    ["assets/preview.png", "preview.png"],
    ["README.md", "README.md"],
    ["README.zh-CN.md", "README.zh-CN.md"],
    ["LICENSE", "LICENSE"],
    ["src/i18n", "i18n"],
];

for (const [from, to] of entries) {
    const source = path.join(root, from);
    if (!existsSync(source)) {
        // 文档和图片可能在首次构建时还没生成：缺图片必须让后续 verify:package 失败
        console.warn(`skip missing: ${from}`);
        continue;
    }
    await cp(source, path.join(dist, to), {recursive: true});
}

const zipPath = path.join(root, "package.zip");
rmSync(zipPath, {force: true});

await new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = new ZipArchive({zlib: {level: 9}});
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(dist, false);
    archive.finalize();
});

const {size} = await stat(zipPath);
console.log(`package.zip done: ${size} bytes`);
