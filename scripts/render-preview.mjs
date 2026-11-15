// 用 Playwright 给 assets/preview.html 截图，生成集市要求的插件预览图。
//
// 预览图必须和真机一致，所以样式不手写：思源本体的 CSS、daylight 主题和图标集都直接从
// 本机安装的思源里取（可用 SIYUAN_RESOURCES 指定 resources 目录），插件的样式则由
// src/index.scss 现场编译，页面里只保留与 ui/*.ts 完全一致的 DOM 结构。
//
// 尺寸与体积上限取自 plugin-sample/README.md 的 preview 字段说明（建议尺寸 1024*768，
// 支持 PNG/JPEG/WebP/AVIF，上限 512KiB）。截图按 1024x768 视口、1 倍像素密度拍摄，
// preview.html 的 body 也是同样的尺寸且 overflow: hidden，所以不出现滚动条，
// 也不需要整页截图。
//
// 首次使用前需要下载 Chromium：npx playwright install chromium。
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {compileAsync} from "sass-embedded";
import sharp from "sharp";

const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 768;
const MAX_BYTES = 512 * 1024;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "assets", "preview.html");
const pngPath = path.join(root, "assets", "preview.png");
const scssPath = path.join(root, "src", "index.scss");
const playwrightCli = path.join(root, "node_modules", "playwright", "cli.js");

if (!fs.existsSync(playwrightCli)) {
    console.error(`Playwright not found at ${path.relative(root, playwrightCli)}; run npm install first.`);
    process.exit(1);
}

/** 本机思源的 resources 目录：先看环境变量，再看常见安装位置和 PATH。 */
function findSiyuanResources() {
    const candidates = [];
    if (process.env.SIYUAN_RESOURCES) {
        candidates.push(process.env.SIYUAN_RESOURCES);
    }
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
        if (!base) {
            continue;
        }
        candidates.push(path.join(base, "SiYuan", "resources"));
        candidates.push(path.join(base, "siyuan", "resources"));
        candidates.push(path.join(base, "Programs", "SiYuan", "resources"));
        candidates.push(path.join(base, "Programs", "siyuan", "resources"));
    }
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const name of ["siyuan.exe", "siyuan"]) {
            const exe = path.join(dir, name);
            if (fs.existsSync(exe)) {
                // 思源把 siyuan(.exe) 放在 resources/kernel/ 下
                candidates.push(path.join(path.dirname(path.dirname(exe))));
                candidates.push(path.join(path.dirname(exe), "resources"));
            }
        }
    }
    for (const candidate of candidates) {
        if (isSiyuanResources(candidate)) {
            return candidate;
        }
    }
    return "";
}

function isSiyuanResources(dir) {
    return fs.existsSync(path.join(dir, "appearance", "themes", "daylight", "theme.css"))
        && fs.existsSync(path.join(dir, "stage", "build", "app"))
        && fs.existsSync(path.join(dir, "appearance", "icons"));
}

/** 应用主体样式是 stage/build/app 里体积最大的 base.*.css。 */
function findHostCss(resources) {
    const buildDir = path.join(resources, "stage", "build", "app");
    const files = fs.readdirSync(buildDir)
        .filter((name) => /^base\..*\.css$/.test(name))
        .map((name) => path.join(buildDir, name))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    return files[0] || "";
}

/** 图标 symbol 集：优先用 litheness（思源默认图标主题）。 */
function findIcons(resources) {
    const iconsDir = path.join(resources, "appearance", "icons");
    const preferred = path.join(iconsDir, "litheness", "icon.js");
    if (fs.existsSync(preferred)) {
        return preferred;
    }
    for (const name of fs.readdirSync(iconsDir)) {
        const candidate = path.join(iconsDir, name, "icon.js");
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return "";
}

const html = fs.readFileSync(htmlPath, "utf8");
const width = /body\s*\{[^}]*?width:\s*(\d+)px/s.exec(html)?.[1];
const height = /body\s*\{[^}]*?height:\s*(\d+)px/s.exec(html)?.[1];

if (width !== String(EXPECTED_WIDTH) || height !== String(EXPECTED_HEIGHT)) {
    console.error(`assets/preview.html declares ${width}x${height}; the marketplace expects ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
    process.exit(1);
}

const resources = findSiyuanResources();
if (resources === "") {
    console.error("SiYuan installation not found; the preview needs the app CSS. "
        + "Set SIYUAN_RESOURCES to the app's resources directory (the one containing appearance/ and stage/).");
    process.exit(1);
}
const hostCss = findHostCss(resources);
const themeCss = path.join(resources, "appearance", "themes", "daylight", "theme.css");
const icons = findIcons(resources);
if (hostCss === "" || icons === "") {
    console.error(`Could not find the app stylesheet or icon set under ${resources}`);
    process.exit(1);
}

// 先截到临时目录：任何一步失败都不会破坏仓库里已有的 preview.png
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), "siyuan-preview-"));
let failure = "";

try {
    fs.copyFileSync(themeCss, path.join(shotDir, "theme.css"));
    fs.copyFileSync(hostCss, path.join(shotDir, "host.css"));
    fs.copyFileSync(icons, path.join(shotDir, "icon.js"));
    const plugin = await compileAsync(scssPath, {style: "expanded"});
    fs.writeFileSync(path.join(shotDir, "plugin.css"), plugin.css);

    const composed = html.replace("<!--PREVIEW_STYLES-->", [
        '<link rel="stylesheet" href="theme.css">',
        '<link rel="stylesheet" href="host.css">',
        '<link rel="stylesheet" href="plugin.css">',
    ].join("\n"));
    if (composed === html) {
        throw new Error("assets/preview.html has no <!--PREVIEW_STYLES--> placeholder");
    }
    const pagePath = path.join(shotDir, "preview.html");
    fs.writeFileSync(pagePath, composed);

    const shotPath = path.join(shotDir, "preview.png");
    try {
        execFileSync(process.execPath, [
            playwrightCli,
            "screenshot",
            "--browser=chromium",
            `--viewport-size=${EXPECTED_WIDTH},${EXPECTED_HEIGHT}`,
            "--wait-for-timeout=500",
            pathToFileURL(pagePath).href,
            shotPath,
        ], {stdio: ["ignore", "ignore", "inherit"]});
    } catch {
        throw new Error("Screenshot failed; if Chromium is missing, run: npx playwright install chromium");
    }

    const metadata = await sharp(shotPath).metadata();
    const actual = `${metadata.width}x${metadata.height}`;
    if (actual !== `${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`) {
        throw new Error(`The screenshot is ${actual}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`);
    }

    const before = fs.statSync(shotPath).size;
    const optimized = await sharp(shotPath)
        .png({compressionLevel: 9, palette: true, quality: 92, effort: 10})
        .toBuffer();
    if (optimized.length > MAX_BYTES) {
        throw new Error(`The compressed preview is ${optimized.length} bytes, over the marketplace limit of ${MAX_BYTES}`);
    }

    fs.writeFileSync(pngPath, optimized);
    console.log(`assets/preview.png: ${before} -> ${optimized.length} bytes (${actual}, limit ${MAX_BYTES})`);
    console.log(`host css: ${path.relative(resources, hostCss)}`);
} catch (error) {
    failure = error.message;
} finally {
    fs.rmSync(shotDir, {recursive: true, force: true});
}

if (failure) {
    console.error(failure);
    process.exit(1);
}
