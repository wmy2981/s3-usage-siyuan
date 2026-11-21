import type {Plugin} from "siyuan";
import {describe, expect, it} from "vitest";
import {DEFAULT_SETTINGS, siyuanRuntimeSource, type PluginSettings} from "../src/config";
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

    it("clamps out-of-range values before writing instead of failing the read-back check", async () => {
        const {plugin, data} = fakePlugin();
        const settings = settingsWithEmptyCredentials();
        settings.timeoutSeconds = 999;
        settings.refreshMinutes = 7;
        const saved = await saveSettings(plugin, settings);
        const raw = data() as {timeoutSeconds: number; refreshMinutes: number};
        expect(raw.timeoutSeconds).toBe(300);
        expect(raw.refreshMinutes).toBe(0);
        expect(saved.timeoutSeconds).toBe(300);
        expect(saved.refreshMinutes).toBe(0);
    });

    it("maps the saved sources back by id when duplicate ids are collapsed", async () => {
        const {plugin, data} = fakePlugin();
        const settings = settingsWithEmptyCredentials();
        settings.sources = [
            {...settings.sources[0], id: "a", name: "A", endpoint: "a.example.com"},
            {...settings.sources[0], id: "a", name: "A duplicate", endpoint: "a.example.com"},
            {...settings.sources[0], id: "b", name: "B", endpoint: "b.example.com"},
        ];
        const saved = await saveSettings(plugin, settings);
        // 落盘时重复 id 只留第一条
        const raw = data() as {sources: {id: string; name: string; endpoint: string}[]};
        expect(raw.sources.map((source) => source.id)).toEqual(["a", "b"]);
        // 返回给界面的不能按原下标错位取到别的数据源
        expect(saved.sources[0].name).toBe("A");
        expect(saved.sources[1].name).toBe("A");
        expect(saved.sources[2].name).toBe("B");
        expect(saved.sources[2].endpoint).toBe("https://b.example.com");
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

    it("stores nothing but the name of the siyuan entry", async () => {
        const host = globalThis as {window?: unknown};
        const original = host.window;
        host.window = {
            siyuan: {
                config: {
                    sync: {
                        provider: 2,
                        s3: {
                            endpoint: "oss-cn-hangzhou.aliyuncs.com",
                            bucket: "sync-bucket",
                            accessKey: "SYNC_AK",
                            secretKey: "SYNC_SK",
                        },
                    },
                },
            },
        };
        try {
            const {plugin, data} = fakePlugin();
            const settings = settingsWithEmptyCredentials();
            settings.sources.push(siyuanRuntimeSource("我的思源"));
            const saved = await saveSettings(plugin, settings);

            const raw = data() as {sources: unknown[]; siyuan?: {name: string}};
            expect(raw.siyuan).toEqual({name: "我的思源"});
            expect(raw.sources).toHaveLength(1);
            const written = JSON.stringify(raw);
            expect(written).not.toContain("sync-bucket");
            expect(written).not.toContain("SYNC_AK");
            expect(written).not.toContain("SYNC_SK");
            // 返回给界面的仍是运行时读出来的那份
            expect(saved.sources[1].buckets).toEqual(["sync-bucket"]);
        } finally {
            if (original === undefined) {
                delete host.window;
            } else {
                host.window = original;
            }
        }
    });

    it("drops the siyuan entry once it is removed", async () => {
        const {plugin, data} = fakePlugin();
        const settings = settingsWithEmptyCredentials();
        settings.sources.push(siyuanRuntimeSource("我的思源"));
        await saveSettings(plugin, settings);

        settings.sources = settings.sources.filter((source) => !source.useSyncConfig);
        await saveSettings(plugin, settings);
        expect((data() as {siyuan?: unknown}).siyuan).toBeUndefined();
    });
});
