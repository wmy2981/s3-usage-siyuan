import {describe, expect, it} from "vitest";
import {
    accountIdFromEndpoint,
    detectProvider,
    mergeStoredSettings,
    normalizeEndpoint,
    parseBucketList,
    regionFromEndpoint,
    resolveSource,
    siyuanRuntimeSource,
    SIYUAN_SOURCE_ID,
} from "../src/config";

/** 造一份「思源正在用 S3 同步」的宿主环境；返回还原函数。 */
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

const S3_SYNC_CONFIG = {
    sync: {
        provider: 2,
        s3: {
            endpoint: "oss-cn-hangzhou.aliyuncs.com",
            bucket: "sync-bucket",
            region: "",
            accessKey: "SYNC_AK",
            secretKey: "SYNC_SK",
        },
    },
    repo: {key: ""},
};

describe("config", () => {
    it("normalizes endpoints with or without a scheme", () => {
        expect(normalizeEndpoint("oss-cn-hangzhou.aliyuncs.com")).toBe("https://oss-cn-hangzhou.aliyuncs.com");
        expect(normalizeEndpoint("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000");
        expect(normalizeEndpoint("")).toBe("");
    });

    it("parses bucket lists from lines and commas", () => {
        expect(parseBucketList("a\nb, c；d")).toEqual(["a", "b", "c", "d"]);
        expect(parseBucketList("a\na\n")).toEqual(["a"]);
    });

    it("detects providers from endpoints", () => {
        expect(detectProvider("https://oss-cn-hangzhou.aliyuncs.com")).toBe("aliyunOss");
        expect(detectProvider("https://cos.ap-guangzhou.myqcloud.com")).toBe("tencentCos");
        expect(detectProvider("https://obs.cn-north-4.myhuaweicloud.com")).toBe("huaweiObs");
        // 华为云欧洲站是独立的 .eu 分区
        expect(detectProvider("https://obs.eu-west-101.myhuaweicloud.eu")).toBe("huaweiObs");
        expect(detectProvider("https://tos-cn-beijing.volces.com")).toBe("volcanoTos");
        // 七牛的 S3 兼容域名（思源里就是这一条）
        expect(detectProvider("https://s3.cn-south-1.qiniucs.com")).toBe("qiniuKodo");
        expect(detectProvider("s3.qiniucs.com")).toBe("qiniuKodo");
        expect(detectProvider("https://023e105f4ecef8ad9ca31a8372d0c353.r2.cloudflarestorage.com")).toBe("cloudflareR2");
        expect(detectProvider("https://s3.us-east-1.amazonaws.com")).toBe("awsS3");
        // AWS 中国区是 amazonaws.com.cn 分区
        expect(detectProvider("https://s3.cn-north-1.amazonaws.com.cn")).toBe("awsS3");
        expect(detectProvider("http://127.0.0.1:9000")).toBe("minio");
        expect(detectProvider("https://minio.example.com")).toBe("minio");
    });

    it("derives regions from standard endpoints", () => {
        expect(regionFromEndpoint("https://oss-cn-hangzhou.aliyuncs.com", "aliyunOss")).toBe("cn-hangzhou");
        expect(regionFromEndpoint("https://tos-cn-beijing.volces.com", "volcanoTos")).toBe("cn-beijing");
        expect(regionFromEndpoint("https://cos.ap-guangzhou.myqcloud.com", "tencentCos")).toBe("ap-guangzhou");
        expect(regionFromEndpoint("https://obs.cn-north-4.myhuaweicloud.com", "huaweiObs")).toBe("cn-north-4");
        expect(regionFromEndpoint("https://obs.eu-west-101.myhuaweicloud.eu", "huaweiObs")).toBe("eu-west-101");
        expect(regionFromEndpoint("https://s3.cn-south-1.qiniucs.com", "qiniuKodo")).toBe("cn-south-1");
        expect(regionFromEndpoint("https://s3.qiniucs.com", "qiniuKodo")).toBe("");
        expect(regionFromEndpoint("https://s3.cn-north-1.amazonaws.com.cn", "awsS3")).toBe("cn-north-1");
        expect(regionFromEndpoint("https://s3.eu-west-1.amazonaws.com", "awsS3")).toBe("eu-west-1");
    });

    it("reads the Cloudflare account id out of the R2 endpoint", () => {
        const endpoint = "https://023e105f4ecef8ad9ca31a8372d0c353.r2.cloudflarestorage.com";
        expect(accountIdFromEndpoint(endpoint, "cloudflareR2")).toBe("023e105f4ecef8ad9ca31a8372d0c353");
        expect(accountIdFromEndpoint(endpoint, "minio")).toBe("");
        expect(accountIdFromEndpoint("https://minio.example.com", "cloudflareR2")).toBe("");
    });

    it("drops invalid sources and clamps the timeout", () => {
        const merged = mergeStoredSettings({
            timeoutSeconds: 999,
            sources: [
                {id: "a", provider: "aliyunOss", buckets: "x\ny"},
                {id: "a", provider: "tencentCos"},
                {id: "b", provider: "nope"},
            ],
        });
        expect(merged.timeoutSeconds).toBe(300);
        expect(merged.sources).toHaveLength(1);
        expect(merged.sources[0].buckets).toEqual(["x", "y"]);
    });

    it("only accepts the offered auto-refresh intervals", () => {
        expect(mergeStoredSettings({refreshMinutes: 10}).refreshMinutes).toBe(10);
        expect(mergeStoredSettings({refreshMinutes: 7}).refreshMinutes).toBe(0);
        expect(mergeStoredSettings({}).refreshMinutes).toBe(0);
    });

    it("upgrades the legacy siyuan source into a standalone entry", () => {
        const merged = mergeStoredSettings({
            sources: [
                {id: "src-1", name: "SiYuan S3 · a", provider: "minio", buckets: ["a"], useSyncConfig: true},
                {id: "src-2", name: "B", provider: "minio", buckets: ["b"]},
                {id: "src-3", name: "另一条", provider: "minio", buckets: ["c"], useSyncConfig: true},
            ],
        });
        // 只能有一条思源导入，其余旧条目直接丢弃
        expect(merged.sources.map((source) => source.id)).toEqual(["src-2"]);
        expect(merged.siyuan).toEqual({name: "SiYuan S3 · a"});
    });

    it("keeps only the name of the siyuan entry", () => {
        const merged = mergeStoredSettings({sources: [], siyuan: {name: "  我的思源  ", endpoint: "https://x"}});
        expect(merged.siyuan).toEqual({name: "我的思源"});
        expect(merged.sources).toEqual([]);
    });

    it("reads the siyuan entry from the live sync configuration", () => {
        const restore = stubSiyuanConfig(S3_SYNC_CONFIG);
        try {
            const source = siyuanRuntimeSource("自定义名");
            expect(source.id).toBe(SIYUAN_SOURCE_ID);
            expect(source.name).toBe("自定义名");
            expect(source.useSyncConfig).toBe(true);
            expect(source.provider).toBe("aliyunOss");
            expect(source.endpoint).toBe("https://oss-cn-hangzhou.aliyuncs.com");
            expect(source.buckets).toEqual(["sync-bucket"]);
            // 地域留空时从 Endpoint 推导
            expect(source.region).toBe("cn-hangzhou");
            expect(source.accessKey).toBe("SYNC_AK");
            expect(resolveSource(source)).toEqual(source);
        } finally {
            restore();
        }
    });

    it("lets the siyuan entry override the detected provider", () => {
        const restore = stubSiyuanConfig(S3_SYNC_CONFIG);
        try {
            // 默认按 Endpoint 识别
            expect(siyuanRuntimeSource("自定义名").providerOverride).toBeUndefined();
            // 手动指定后以手动值为准，重建时也要保留
            const source = siyuanRuntimeSource("自定义名", "qiniuKodo");
            expect(source.provider).toBe("qiniuKodo");
            expect(source.providerOverride).toBe("qiniuKodo");
            expect(resolveSource(source).provider).toBe("qiniuKodo");
        } finally {
            restore();
        }
    });

    it("keeps a known provider of the siyuan entry and drops an unknown one", () => {
        expect(mergeStoredSettings({sources: [], siyuan: {name: "x", provider: "qiniuKodo"}}).siyuan)
            .toEqual({name: "x", provider: "qiniuKodo"});
        expect(mergeStoredSettings({sources: [], siyuan: {name: "x", provider: "nope"}}).siyuan)
            .toEqual({name: "x"});
    });

    it("leaves the siyuan entry empty when SiYuan does not sync to S3", () => {
        const restore = stubSiyuanConfig({sync: {provider: 3, s3: {endpoint: "x", bucket: "y"}}});
        try {
            const source = siyuanRuntimeSource("自定义名");
            expect(source.buckets).toEqual([]);
            expect(source.endpoint).toBe("");
        } finally {
            restore();
        }
    });
});
