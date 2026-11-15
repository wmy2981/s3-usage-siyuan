import type {Plugin} from "siyuan";
import {describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, type PluginSettings} from "../src/config";
import {saveSettings} from "../src/settings-store";

/** 只实现用到的方法，避免为一次保存测试搭整个宿主。 */
function fakePlugin(): {plugin: Plugin; data: () => unknown} {
    let stored: unknown;
    const plugin = {
        saveData: async (_name: string, value: unknown) => {
            stored = structuredClone(value);
            return {code: 0};
        },
        loadData: async () => stored,
    } as unknown as Plugin;
    return {plugin, data: () => stored};
}

function settingsWithEmptyCredentials(): PluginSettings {
    return {
        ...DEFAULT_SETTINGS,
        sources: [{
            id: "a",
            name: "A",
            provider: "minio",
            buckets: ["bucket"],
            endpoint: "http://127.0.0.1:9000",
            region: "",
            accountId: "",
            useSyncConfig: false,
            accessKey: "",
            secretKey: "",
            credentialsError: false,
            credentialsErrorReason: "",
        }],
    };
}

describe("settings store", () => {
    it("does not write an envelope when the credentials are already cleared", async () => {
        const {plugin, data} = fakePlugin();
        const saved = await saveSettings(plugin, settingsWithEmptyCredentials());
        const raw = data() as {sources: {credentials?: string}[]};
        expect(raw.sources[0].credentials).toBeUndefined();
        expect(saved.sources[0].credentials).toBeUndefined();
    });

    it("keeps an unreadable envelope when saving unrelated settings", async () => {
        const {plugin, data} = fakePlugin();
        const settings = settingsWithEmptyCredentials();
        settings.sources[0].credentials = "sealed-envelope";
        await saveSettings(plugin, settings);
        const raw = data() as {sources: {credentials?: string}[]};
        expect(raw.sources[0].credentials).toBe("sealed-envelope");
    });
});
