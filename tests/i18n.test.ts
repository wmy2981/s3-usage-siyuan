import {describe, expect, it} from "vitest";
import {readFileSync, readdirSync} from "node:fs";
import en from "../src/i18n/en.json";
import zh from "../src/i18n/zh-CN.json";
import {PROVIDER_META} from "../src/providers/meta";

/** 收集源码里所有直接写死的翻译键：漏翻一个键，界面上就会露出裸 key。 */
function usedKeys(): Set<string> {
    const keys = new Set<string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, {withFileTypes: true})) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(path);
            } else if (path.endsWith(".ts")) {
                const source = readFileSync(path, "utf8");
                for (const match of source.matchAll(/\bt\("([A-Za-z0-9]+)"/g)) {
                    keys.add(match[1]);
                }
            }
        }
    };
    walk(`${import.meta.dirname}/../src`);
    for (const meta of Object.values(PROVIDER_META)) {
        keys.add(meta.labelKey);
        keys.add(meta.accessKeyLabelKey);
        keys.add(meta.secretKeyLabelKey);
        keys.add(meta.bucketHintKey);
        if (meta.accountIdLabelKey) {
            keys.add(meta.accountIdLabelKey);
        }
        if (meta.accountIdHintKey) {
            keys.add(meta.accountIdHintKey);
        }
    }
    return keys;
}

describe("i18n", () => {
    it("keeps both languages on the same key set", () => {
        expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    });

    it("has a translation for every key the source code asks for", () => {
        const missing = [...usedKeys()].filter((key) => !(key in en) || !(key in zh)).sort();
        expect(missing).toEqual([]);
    });

    it("labels every storage class the providers can report", () => {
        // 与各适配器的 key 一一对应：usage-dialog 用 storageClass<Capitalized> 查表
        const keys = [
            "standard", "ia", "line", "archive", "archiveFr", "coldArchive", "deepArchive", "glacier", "glacierIr",
            "oneZoneIa", "reducedRedundancy", "intelligentFa", "intelligentIa", "intelligentAia",
            "intelligentAa", "intelligentDaa", "intelligentArchive",
        ];
        for (const key of keys) {
            const i18nKey = `storageClass${key.charAt(0).toUpperCase()}${key.slice(1)}`;
            expect(en, i18nKey).toHaveProperty(i18nKey);
            expect(zh, i18nKey).toHaveProperty(i18nKey);
        }
    });
});
