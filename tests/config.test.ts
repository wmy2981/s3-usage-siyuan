import {describe, expect, it} from "vitest";
import {
    detectProvider,
    mergeStoredSettings,
    normalizeEndpoint,
    parseBucketList,
    regionFromEndpoint,
} from "../src/config";

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
        expect(detectProvider("https://tos-cn-beijing.volces.com")).toBe("volcanoTos");
        expect(detectProvider("https://s3.us-east-1.amazonaws.com")).toBe("awsS3");
        expect(detectProvider("http://127.0.0.1:9000")).toBe("minio");
    });

    it("derives regions from standard endpoints", () => {
        expect(regionFromEndpoint("https://oss-cn-hangzhou.aliyuncs.com", "aliyunOss")).toBe("cn-hangzhou");
        expect(regionFromEndpoint("https://tos-cn-beijing.volces.com", "volcanoTos")).toBe("cn-beijing");
        expect(regionFromEndpoint("https://cos.ap-guangzhou.myqcloud.com", "tencentCos")).toBe("ap-guangzhou");
        expect(regionFromEndpoint("https://obs.cn-north-4.myhuaweicloud.com", "huaweiObs")).toBe("cn-north-4");
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
});
