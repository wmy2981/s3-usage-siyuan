// 核对 package.zip 的内容：必需文件齐全、布局扁平、图片不超标。
// CI 与 CD 共用同一个校验；zip 用自带中央目录解析，不依赖 unzip。
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = path.join(ROOT, "package.zip");

const REQUIRED = [
    "plugin.json",
    "index.js",
    "index.css",
    "icon.png",
    "preview.png",
    "README.md",
    "README.zh-CN.md",
    "LICENSE",
    "i18n/en.json",
    "i18n/zh-CN.json",
];

// 集市限制：icon 64 KiB，preview 512 KiB
const IMAGE_LIMITS = new Map([
    ["icon.png", 64 * 1024],
    ["preview.png", 512 * 1024],
]);

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

const readEntries = (buffer) => {
    let eocd = -1;
    for (let offset = buffer.length - 22; offset >= 0; offset--) {
        if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
            eocd = offset;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error("package.zip has no end of central directory record");
    }
    const entries = [];
    let offset = buffer.readUInt32LE(eocd + 16);
    const total = buffer.readUInt16LE(eocd + 10);
    for (let index = 0; index < total; index++) {
        if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
            throw new Error("package.zip central directory is corrupt");
        }
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        entries.push({
            name: buffer.toString("utf8", offset + 46, offset + 46 + nameLength),
            size: buffer.readUInt32LE(offset + 24),
        });
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
};

if (!fs.existsSync(ZIP)) {
    console.error("package.zip is missing, run `npm run build` first");
    process.exit(1);
}

const entries = readEntries(fs.readFileSync(ZIP));
const names = entries.map((entry) => entry.name);
const problems = [];

REQUIRED.filter((file) => !names.includes(file))
    .forEach((file) => problems.push(`missing ${file}`));

names.filter((name) => name.endsWith("/") && name !== "i18n/")
    .forEach((name) => problems.push(`unexpected directory entry ${name}`));

const extra = names.filter((name) => !REQUIRED.includes(name) && !name.endsWith("/"));
extra.forEach((name) => problems.push(`unexpected file ${name}`));

for (const [name, limit] of IMAGE_LIMITS) {
    const entry = entries.find((item) => item.name === name);
    if (entry && entry.size > limit) {
        problems.push(`${name} is ${entry.size} bytes, over the ${limit} byte limit`);
    }
}

if (problems.length) {
    problems.forEach((problem) => console.error(`::error::${problem}`));
    process.exit(1);
}

const total = entries.reduce((sum, entry) => sum + entry.size, 0);
console.log(`package.zip ok: ${names.length} files, ${total} bytes uncompressed`);
