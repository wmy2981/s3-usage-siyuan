import {beforeEach, describe, expect, it, vi} from "vitest";

const {fetchSyncPost} = vi.hoisted(() => ({fetchSyncPost: vi.fn()}));
vi.mock("siyuan", () => ({fetchSyncPost}));

import type {DataSource} from "../src/config";
import {queryBucket, QueryError, type QueryErrorKind} from "../src/query";

function minioSource(overrides: Partial<DataSource> = {}): DataSource {
    return {
        id: "minio",
        name: "MinIO",
        provider: "minio",
        buckets: ["photos"],
        endpoint: "http://127.0.0.1:9000",
        region: "",
        accountId: "",
        useSyncConfig: false,
        accessKey: "AK",
        secretKey: "SK",
        credentialsError: false,
        credentialsErrorReason: "",
        ...overrides,
    };
}

/** 只关心归类结果：成功记为 "ok"，失败取出 QueryError 的 kind。 */
async function kindOf(source: DataSource, timeoutSeconds = 30): Promise<QueryErrorKind | "ok"> {
    try {
        await queryBucket(source, "photos", timeoutSeconds);
        return "ok";
    } catch (error) {
        if (error instanceof QueryError) {
            return error.kind;
        }
        throw error;
    }
}

function stubSiyuanConfig(config: unknown): () => void {
    const host = globalThis as {window?: unknown};
    const original = host.window;
    host.window = {siyuan: {config}};
    return () => {
        if (original === undefined) {
            delete host.window;
        } else {
            host.window = original;
        }
    };
}

describe("query orchestration", () => {
    beforeEach(() => fetchSyncPost.mockReset());

    it("classifies 403 responses as authentication failures", async () => {
        fetchSyncPost.mockResolvedValue({code: 0, data: {
            status: 403,
            body: "<Error><Code>AccessDenied</Code><Message>denied</Message></Error>",
            headers: null,
        }});
        expect(await kindOf(minioSource())).toBe("auth");
    });

    it("does not treat a 403 found inside diagnostics text as an authentication failure", async () => {
        fetchSyncPost.mockResolvedValue({code: 0, data: {
            status: 500,
            body: "gateway timeout after 403 seconds on port 4031",
            headers: null,
        }});
        expect(await kindOf(minioSource())).toBe("provider");
    });

    it("passes the configured timeout to the transport without narrowing it", async () => {
        fetchSyncPost.mockResolvedValue({code: 0, data: {
            status: 200,
            body: JSON.stringify({bucketsUsageInfo: {photos: {size: 1, objectsCount: 1}}}),
            headers: null,
        }});
        await kindOf(minioSource(), 1);
        expect((fetchSyncPost.mock.calls[0][1] as {timeout: number}).timeout).toBe(1000);

        fetchSyncPost.mockClear();
        await kindOf(minioSource(), 300);
        expect((fetchSyncPost.mock.calls[0][1] as {timeout: number}).timeout).toBe(300000);
    });

    it("normalizes the SiYuan sync endpoint before querying", async () => {
        const restore = stubSiyuanConfig({
            sync: {
                provider: 2,
                s3: {
                    endpoint: "127.0.0.1:9000",
                    bucket: "sync-bucket",
                    accessKey: "SYNC_AK",
                    secretKey: "SYNC_SK",
                },
            },
        });
        try {
            fetchSyncPost.mockResolvedValue({code: 0, data: {
                status: 200,
                body: JSON.stringify({bucketsUsageInfo: {"sync-bucket": {size: 2, objectsCount: 1}}}),
                headers: null,
            }});
            const usage = await queryBucket(minioSource({useSyncConfig: true}), "sync-bucket", 30);
            expect(usage.storageBytes).toBe(2);
            const url = (fetchSyncPost.mock.calls[0][1] as {url: string}).url;
            expect(url.startsWith("https://127.0.0.1:9000/")).toBe(true);
        } finally {
            restore();
        }
    });

    it("reports a missing SiYuan sync configuration as a config error", async () => {
        const restore = stubSiyuanConfig({sync: {provider: 3}});
        try {
            expect(await kindOf(minioSource({useSyncConfig: true}))).toBe("config");
        } finally {
            restore();
        }
    });
});
