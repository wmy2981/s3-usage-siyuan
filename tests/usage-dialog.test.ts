import {afterEach, describe, expect, it, vi} from "vitest";
import type {PluginSettings} from "../src/config";
import type {BucketUsage} from "../src/providers/types";

const {queryBucket, dialogOptions} = vi.hoisted(() => ({
    queryBucket: vi.fn(),
    dialogOptions: {current: undefined as {destroyCallback?: () => void} | undefined},
}));

vi.mock("siyuan", () => ({
    confirm: vi.fn(),
    showMessage: vi.fn(),
    Dialog: class {
        readonly element: unknown;

        constructor(options: {destroyCallback?: () => void}) {
            dialogOptions.current = options;
            const root = {
                querySelector: () => null,
                querySelectorAll: () => [],
            };
            const live = {textContent: ""};
            this.element = {
                querySelector: (selector: string) => {
                    if (selector === ".s3u") {
                        return root;
                    }
                    if (selector === ".s3u__live") {
                        return live;
                    }
                    return null;
                },
            };
        }

        destroy(): void {
            dialogOptions.current?.destroyCallback?.();
        }
    },
}));

vi.mock("../src/query", () => ({
    queryBucket,
    QueryError: class extends Error {
        constructor(readonly kind: string, message: string) {
            super(message);
        }
    },
}));

vi.mock("../src/ui/drawer", () => ({
    bindMobileDrawer: vi.fn(),
    isMobileFrontend: () => false,
}));

vi.mock("../src/ui/source-form", () => ({
    renderSourceList: vi.fn(),
    SourceForm: class {},
}));

import {UsageDialog} from "../src/ui/usage-dialog";

interface PendingQuery {
    bucket: string;
    resolve: (usage: BucketUsage) => void;
}

function settings(): PluginSettings {
    return {
        version: 1,
        timeoutSeconds: 30,
        testTimeoutSeconds: 5,
        refreshMinutes: 5,
        sources: [{
            id: "source",
            name: "source",
            provider: "minio",
            buckets: ["bucket-a", "bucket-b"],
            endpoint: "http://127.0.0.1:9000",
            region: "",
            accountId: "",
            useSyncConfig: false,
            accessKey: "AK",
            secretKey: "SK",
            credentialsError: false,
            credentialsErrorReason: "",
        }],
    };
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe("usage dialog query lifecycle", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        queryBucket.mockReset();
        dialogOptions.current = undefined;
    });

    it("queries unfinished buckets again after closing and reopening", async () => {
        const pending: PendingQuery[] = [];
        queryBucket.mockImplementation((_source, bucket: string) => new Promise<BucketUsage>((resolve) => {
            pending.push({bucket, resolve});
        }));
        const dialog = new UsageDialog({
            t: (key) => key,
            settings: settings(),
            onSave: async (value) => value,
            onReload: async () => settings(),
        });
        const internal = dialog as unknown as {
            render: () => void;
            startTimer: () => void;
            tick: () => void;
            announce: (message: string) => void;
            autoRefreshDue: (now: number) => boolean;
            querying: boolean;
            results: Map<string, {state: string}>;
        };
        vi.spyOn(internal, "render").mockImplementation(() => {});
        vi.spyOn(internal, "startTimer").mockImplementation(() => {});
        vi.spyOn(internal, "tick").mockImplementation(() => {});
        vi.spyOn(internal, "announce").mockImplementation(() => {});

        dialog.open();
        expect(queryBucket).toHaveBeenCalledTimes(2);
        pending.find((item) => item.bucket === "bucket-a")?.resolve({storageBytes: 1});
        await settle();
        expect(internal.results.get("source\u0000bucket-a")?.state).toBe("ok");
        expect(internal.results.get("source\u0000bucket-b")?.state).toBe("loading");

        dialog.destroy();
        expect(internal.results.size).toBe(1);
        dialog.open();

        // 保留 A 的上次结果，也必须重新查询关闭时仍未完成的 B。
        expect(queryBucket).toHaveBeenCalledTimes(4);
        expect(queryBucket.mock.calls.slice(2).map((call) => call[1])).toEqual(["bucket-a", "bucket-b"]);

        // 旧 B 即使在重开后才返回，也不能结束新一轮查询或覆盖新结果。
        pending[1].resolve({storageBytes: 999});
        await settle();
        expect(internal.querying).toBe(true);
        pending[2].resolve({storageBytes: 2});
        pending[3].resolve({storageBytes: 3});
        await settle();
        expect(internal.querying).toBe(false);
        expect(internal.results.get("source\u0000bucket-b")?.state).toBe("ok");
        expect(internal.autoRefreshDue(Date.now() + 5 * 60_000 + 1)).toBe(true);

        dialog.destroy();
    });
});
