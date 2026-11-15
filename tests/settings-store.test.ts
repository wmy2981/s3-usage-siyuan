import type {Plugin} from "siyuan";
import {describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, type PluginSettings} from "../src/config";
import {saveSettings} from "../src/settings-store";

/** 只实现用到的方法，避免为一次保存测试搭整个宿主；tamper 模拟落盘后被改写。 */
function fakePlugin(tamper?: (data: unknown) => unknown): {plugin: Plugin; data: () => unknown} {
    let stored: unknown;
    const plugin = {
        saveData: async (_name: string, value: unknown) => {
            stored = structuredClone(value);
            return {code: 0};
        },
        loadData: async () => {
            const copy = structuredClone(stored);
            return tamper ? tamper(copy) : copy;
        },
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

    it("writes and reads back the complete configuration", async () => {
        const {plugin, data} = fakePlugin();
        const settings = settingsWithEmptyCredentials();
        settings.timeoutSeconds = 45;
        settings.refreshMinutes = 10;
        settings.sources[0].endpoint = "127.0.0.1:9000";
        const saved = await saveSettings(plugin, settings);
        const raw = data() as {
            timeoutSeconds: number;
            refreshMinutes: number;
            sources: {endpoint: string; name: string}[];
        };
        expect(saved.timeoutSeconds).toBe(45);
        expect(saved.sources[0].endpoint).toBe("https://127.0.0.1:9000");
        expect(raw.timeoutSeconds).toBe(45);
        expect(raw.refreshMinutes).toBe(10);
        expect(raw.sources[0].endpoint).toBe("https://127.0.0.1:9000");
        expect(raw.sources[0].name).toBe("A");
    });

    it("rejects a read-back that differs from what was written", async () => {
        const {plugin} = fakePlugin((value) => {
            const copy = value as {sources: {name: string}[]};
            copy.sources[0].name = "changed";
            return copy;
        });
        await expect(saveSettings(plugin, settingsWithEmptyCredentials()))
            .rejects.toMatchObject({reason: "verify"});
    });
});
