import {beforeEach, describe, expect, it, vi} from "vitest";

const {fetchSyncPost} = vi.hoisted(() => ({fetchSyncPost: vi.fn()}));
vi.mock("siyuan", () => ({fetchSyncPost}));

import {forward} from "../src/net";
import type {DataSource} from "../src/config";
import {aliyunOss} from "../src/providers/aliyun-oss";
import {minio} from "../src/providers/minio";

function source(provider: DataSource["provider"]): DataSource {
    return {
        id: provider, name: provider, provider, buckets: ["photos"], endpoint: "https://example.com",
        region: "cn-hangzhou", accountId: "", useSyncConfig: false,
        accessKey: "AK", secretKey: "SK", credentialsError: false, credentialsErrorReason: "",
    };
}

describe("diagnostics do not change provider control flow", () => {
    beforeEach(() => fetchSyncPost.mockReset());

    it("returns non-2xx responses instead of throwing them from transport", async () => {
        fetchSyncPost.mockResolvedValue({code: 0, data: {
            status: 403, body: "fallback response", headers: {"x-test": ["yes"]},
        }});
        const response = await forward({
            url: "https://example.com", method: "GET", headers: {}, contentType: "application/json",
        }, 5000);
        expect(response.status).toBe(403);
        expect(response.body).toBe("fallback response");
        // 诊断只是请求引用，不预先格式化响应正文；成功/回退路径没有额外字符串开销
        expect(response.diagnostics?.request.url).toBe("https://example.com");
    });

    it("sends the signed POST body with an encoding the kernel actually implements", async () => {
        // 内核只处理 json 与各种二进制编码；`text` 不会写入 payload，签名会与空请求体对不上。
        fetchSyncPost.mockResolvedValue({code: 0, data: {status: 200, body: "", headers: null}});
        await forward({
            url: "https://example.com/", method: "POST", headers: {}, body: '{"MetricName":"StdStorage"}',
            contentType: "application/json",
        }, 5000);
        const sent = fetchSyncPost.mock.calls[0][1] as Record<string, unknown>;
        expect(sent.payload).toBe('{"MetricName":"StdStorage"}');
        expect(sent.payloadEncoding).toBe("json");
    });

    it("still falls back from OSS V4 to V1 after a 403", async () => {
        const requests: string[] = [];
        const usage = await aliyunOss.query({
            source: source("aliyunOss"), bucket: "photos", timeoutMs: 5000,
            request: async (request) => {
                if (new URL(request.url).hostname.startsWith("metrics.")) {
                    return {status: 200, body: JSON.stringify({Success: true, Datapoints: []}), headers: null};
                }
                requests.push("request");
                if (requests.length === 1) {
                    return {status: 403, body: "V4 unsupported", headers: null};
                }
                return {
                    status: 200,
                    body: "<BucketStat><Storage>42</Storage><ObjectCount>3</ObjectCount></BucketStat>",
                    headers: null,
                };
            },
        });
        expect(requests).toHaveLength(2);
        expect(usage.storageBytes).toBe(42);
        expect(usage.objectCount).toBe(3);
    });

    it("still falls back to the MinIO v4 usage endpoint after a 404", async () => {
        const paths: string[] = [];
        const usage = await minio.query({
            source: source("minio"), bucket: "photos", timeoutMs: 5000,
            request: async (request) => {
                const path = new URL(request.url).pathname;
                paths.push(path);
                if (path.includes("datausageinfo")) {
                    if (path.includes("/v3/")) {
                        return {status: 404, body: "old endpoint", headers: null};
                    }
                    return {
                        status: 200,
                        body: JSON.stringify({bucketsUsageInfo: {photos: {size: 42, objectsCount: 3}}}),
                        headers: null,
                    };
                }
                return {status: 200, body: "", headers: null};
            },
        });
        expect(paths.slice(0, 2)).toEqual([
            "/minio/admin/v3/datausageinfo",
            "/minio/admin/v4/datausageinfo",
        ]);
        expect(usage.storageBytes).toBe(42);
        expect(usage.objectCount).toBe(3);
    });

    it("still falls back to anonymous metrics when MinIO rejects the token", async () => {
        const scrapes: string[] = [];
        const usage = await minio.query({
            source: source("minio"), bucket: "photos", timeoutMs: 5000,
            request: async (request) => {
                if (new URL(request.url).pathname.includes("datausageinfo")) {
                    return {
                        status: 200,
                        body: JSON.stringify({bucketsUsageInfo: {photos: {size: 42, objectsCount: 3}}}),
                        headers: null,
                    };
                }
                const authenticated = request.headers.Authorization !== undefined;
                scrapes.push(authenticated ? "token" : "anonymous");
                if (authenticated) {
                    return {status: 401, body: "token rejected", headers: null};
                }
                return {
                    status: 200,
                    headers: null,
                    body: [
                        'minio_bucket_traffic_received_bytes{bucket="photos"} 1000',
                        'minio_bucket_traffic_sent_bytes{bucket="photos"} 2000',
                        'minio_bucket_requests_total{bucket="photos"} 7',
                    ].join("\n"),
                };
            },
        });
        expect(scrapes).toEqual(["token", "anonymous"]);
        expect(usage.storageBytes).toBe(42);
        expect(usage.trafficInBytes).toBe(1000);
        expect(usage.trafficOutBytes).toBe(2000);
        expect(usage.requestCount).toBe(7);
        expect(usage.errors ?? []).toEqual([]);
    });
});
