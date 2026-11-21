import {describe, expect, it} from "vitest";
import {createHash, createHmac} from "node:crypto";
import type {DataSource} from "../src/config";
import {qiniuKodo} from "../src/providers/qiniu-kodo";
import {tencentCos} from "../src/providers/tencent-cos";
import type {ForwardRequest} from "../src/providers/types";

function source(): DataSource {
    return {
        id: "cos", name: "cos", provider: "tencentCos", buckets: ["photos-1250000000"],
        endpoint: "", region: "ap-guangzhou", accountId: "", useSyncConfig: false,
        accessKey: "AKIDEXAMPLE", secretKey: "SECRETEXAMPLE", credentialsError: false, credentialsErrorReason: "",
    };
}

describe("Tencent COS monitoring requests", () => {
    it("posts a signed JSON body with the documented headers and dimensions", async () => {
        const requests: ForwardRequest[] = [];
        const usage = await tencentCos.query({
            source: source(), bucket: "photos-1250000000", timeoutMs: 5000,
            request: async (request) => {
                requests.push(request);
                return {status: 200, body: JSON.stringify({Response: {DataPoints: []}}), headers: null};
            },
        });

        // 5 个存储类 + 5 个对象数 + 碎片 + 3 个流量/请求指标
        expect(requests).toHaveLength(14);
        for (const request of requests) {
            expect(request.method).toBe("POST");
            expect(request.url).toBe("https://monitor.tencentcloudapi.com/");
            expect(request.contentType).toBe("application/json");
            expect(request.headers["Content-Type"]).toBe("application/json");
            expect(request.headers["X-TC-Action"]).toBe("GetMonitorData");
            expect(request.headers["X-TC-Version"]).toBe("2018-07-24");
            expect(request.headers["X-TC-Region"]).toBe("ap-guangzhou");
            expect(request.headers.Authorization).toBe(expectedTc3Authorization(request));

            const payload = JSON.parse(request.body ?? "{}") as {
                Namespace: string;
                Period: number;
                StartTime: string;
                EndTime: string;
                Instances: {Dimensions: {Name: string; Value: string}[]}[];
            };
            expect(payload.Namespace).toBe("QCE/COS");
            expect(payload.Period).toBe(3600);
            expect(payload.StartTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
            expect(payload.EndTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
            expect(payload.Instances[0].Dimensions).toEqual([
                {Name: "appid", Value: "1250000000"},
                {Name: "bucket", Value: "photos-1250000000"},
            ]);
        }
        expect(usage.storageBytes).toBeUndefined();
    });

    it("keeps the business error code when the provider answers 200", async () => {
        let error: {code?: string; message?: string} | undefined;
        try {
            await tencentCos.query({
                source: source(), bucket: "photos-1250000000", timeoutMs: 5000,
                request: async () => ({
                    status: 200,
                    body: JSON.stringify({Response: {
                        Error: {Code: "AuthFailure.SignatureFailure", Message: "signature mismatch"},
                        RequestId: "request-123",
                    }}),
                    headers: null,
                }),
            });
        } catch (reason) {
            error = reason as {code?: string; message?: string};
        }
        // 200 响应体里的业务错误也要带出错误码，认证类失败才能被归类
        expect(error?.code).toBe("AuthFailure.SignatureFailure");
        expect(error?.message).toContain("AuthFailure.SignatureFailure: signature mismatch");
        expect(error?.message).toContain("Response body");
    });
});

/** 按腾讯云 TC3 文档独立重算一次签名，确认签的就是实际发送的 body。 */
function expectedTc3Authorization(request: ForwardRequest): string {
    const timestamp = request.headers["X-TC-Timestamp"];
    const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const canonicalRequest = [
        "POST",
        "/",
        "",
        `content-type:application/json\nhost:monitor.tencentcloudapi.com\n`,
        "content-type;host",
        hash(request.body ?? ""),
    ].join("\n");
    const stringToSign = [
        "TC3-HMAC-SHA256",
        timestamp,
        `${date}/monitor/tc3_request`,
        hash(canonicalRequest),
    ].join("\n");
    const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
    const secretDate = hmac("TC3SECRETEXAMPLE", date);
    const secretService = hmac(secretDate, "monitor");
    const secretSigning = hmac(secretService, "tc3_request");
    const signature = createHmac("sha256", secretSigning).update(stringToSign).digest("hex");
    return `TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/${date}/monitor/tc3_request, ` +
        `SignedHeaders=content-type;host, Signature=${signature}`;
}

describe("Qiniu Kodo endpoint handling", () => {
    function qiniuSource(endpoint: string): DataSource {
        return {
            id: "qiniu", name: "qiniu", provider: "qiniuKodo", buckets: ["photos"],
            endpoint, region: "", accountId: "", useSyncConfig: false,
            accessKey: "QINIU_AK", secretKey: "QINIU_SK", credentialsError: false, credentialsErrorReason: "",
        };
    }

    /** 数据统计接口（space/count）与流量接口（blob_io/rs_put）用同一份载荷喂一次查询。 */
    async function run(endpoint: string) {
        const urls: string[] = [];
        const usage = await qiniuKodo.query({
            source: qiniuSource(endpoint), bucket: "photos", timeoutMs: 5000,
            request: async (request) => {
                urls.push(request.url);
                expect(request.headers.Authorization).toContain("QINIU_AK:");
                return {status: 200, body: JSON.stringify({times: [1700000000], datas: [1024]}), headers: null};
            },
        });
        return {urls, usage};
    }

    it("turns a bare host typed into the form into a usable base URL", async () => {
        const {urls, usage} = await run("api.qiniuapi.com/");
        expect(urls).not.toHaveLength(0);
        for (const url of urls) {
            expect(url.startsWith("https://api.qiniuapi.com/v6/")).toBe(true);
        }
        expect(usage.storageBytes).toBe(4 * 1024);
        expect(usage.objectCount).toBe(4 * 1024);
    });

    it("falls back to the public endpoint when the field is empty", async () => {
        const {urls} = await run("  ");
        for (const url of urls) {
            expect(url.startsWith("https://api.qiniuapi.com/v6/")).toBe(true);
        }
    });
});
