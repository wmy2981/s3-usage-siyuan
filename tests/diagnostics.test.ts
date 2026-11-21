import {describe, expect, it} from "vitest";
import {
    detailedErrorText,
    redact,
    requestDetailsText,
    requestHeadersText,
    responseBodyText,
    responseHeadersText,
} from "../src/diagnostics";
import {providerError} from "../src/providers/helpers";
import {withMetrics} from "../src/providers/monitoring";
import {tencentCos} from "../src/providers/tencent-cos";
import type {DataSource} from "../src/config";
import {errorSummary} from "../src/format";

describe("error diagnostics", () => {
    it("preserves provider codes, request IDs, headers and the complete body", () => {
        const body = JSON.stringify({Response: {
            Error: {Code: "AuthFailure.UnauthorizedOperation", Message: "permission denied"},
            RequestId: "request-123",
            Detail: "x".repeat(1000),
        }});
        const error = providerError({
            status: 403,
            body,
            headers: {"x-request-id": ["request-123"]},
            diagnostics: {
                request: {
                    url: "https://monitor.tencentcloudapi.com/",
                    method: "POST",
                    headers: {Authorization: "TC3-HMAC-SHA256 Credential=AKIDSECRET/2026-01-01/monitor/tc3_request"},
                    body: '{"MetricName":"StdStorage"}',
                    contentType: "application/json; charset=utf-8",
                },
                timeoutMs: 5000,
            },
        });
        expect(error.message).toContain("HTTP 403");
        expect(error.message).toContain("permission denied");
        expect(error.message).toContain("request-123");
        expect(error.message).toContain("x".repeat(1000));
        expect(error.message).toContain("StdStorage");
        expect(error.message).not.toContain("AKIDSECRET");
    });

    it("does not truncate partial monitoring errors", async () => {
        const errors: string[] = [];
        await withMetrics(async () => {
            throw new Error("monitoring failed\n" + "detail".repeat(200));
        }, errors);
        expect(errors[1]).toContain("detail".repeat(200));
    });

    it("includes stack and cause for unexpected exceptions", () => {
        const cause = new TypeError("bad response shape");
        const error = new Error("query failed", {cause});
        const text = detailedErrorText(error);
        expect(text).toContain("Error: query failed");
        expect(text).toContain("Stack:");
        expect(text).toContain("TypeError: bad response shape");
    });

    it("exposes the Tencent COS operation and full raw error response", async () => {
        const source: DataSource = {
            id: "cos-test", name: "COS", provider: "tencentCos", buckets: ["photos-1250000000"],
            endpoint: "", region: "ap-guangzhou", accountId: "", useSyncConfig: false,
            accessKey: "AKID_TEST", secretKey: "SECRET_TEST", credentialsError: false, credentialsErrorReason: "",
        };
        const responseBody = JSON.stringify({Response: {Error: {
            Code: "AuthFailure.UnauthorizedOperation", Message: "no monitor permission",
        }, RequestId: "cos-request-id"}});
        // 只让 StdStorage 失败：存储类指标是并发查询的，让所有请求都失败会由最先返回的那个决定报错
        await expect(tencentCos.query({
            source, bucket: "photos-1250000000", timeoutMs: 5000,
            request: async (request) => {
                const metric = (JSON.parse(request.body ?? "{}") as {MetricName: string}).MetricName;
                if (metric !== "StdStorage") {
                    return {status: 200, body: JSON.stringify({Response: {DataPoints: []}}), headers: null};
                }
                return {status: 403, body: responseBody, headers: {"x-request-id": ["cos-request-id"]}};
            },
        })).rejects.toMatchObject({message: expect.stringMatching(/no monitor permission[\s\S]*cos-request-id[\s\S]*Metric: StdStorage/)});
    });

    it("redacts credentials and authorization data from diagnostics", () => {
        const headers = requestHeadersText({
            Authorization: "TC3-HMAC-SHA256 Credential=AKIDSECRET/2026-01-01/monitor/tc3_request, Signature=abcdef",
            "X-TC-Token": "temporary-token",
            "X-TC-Action": "GetMonitorData",
        });
        expect(headers).toContain("GetMonitorData");
        expect(headers).not.toContain("AKIDSECRET");
        expect(headers).not.toContain("temporary-token");
        expect(headers).not.toContain("abcdef");

        const body = responseBodyText('{"secretKey":"do-not-expose","requestId":"visible"}');
        expect(body).toContain("visible");
        expect(body).not.toContain("do-not-expose");
    });

    it("renders the request section instead of an object placeholder", () => {
        const error = providerError({
            status: 500,
            body: "boom",
            headers: null,
            diagnostics: {
                request: {
                    url: "https://oss-cn-hangzhou.aliyuncs.com/?stat",
                    method: "GET",
                    headers: {"x-test": "1"},
                    body: "",
                    contentType: "application/xml",
                },
                timeoutMs: 5000,
            },
        });
        expect(error.message).not.toContain("[object Object]");
        expect(error.message).toContain("Method: GET");
        expect(error.message).toContain("Request headers");
        expect(error.message).toContain("x-test");
    });

    it("redacts bearer tokens, session tokens and credentials in the URL", () => {
        const body = responseBodyText('{"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"}');
        expect(body).not.toContain("eyJhbGciOiJIUzI1NiJ9");

        const headers = requestHeadersText({"X-Amz-Security-Token": "sts-session-token"});
        expect(headers).not.toContain("sts-session-token");

        const details = requestDetailsText({
            url: "https://oss-cn-hangzhou.aliyuncs.com/?AccessKeyId=AKID_IN_URL&Signature=sig%3D",
            method: "GET",
            headers: {},
            body: "",
            contentType: "application/xml",
        }, 5000);
        expect(details).not.toContain("AKID_IN_URL");
        expect(details).not.toContain("sig%3D");
        expect(details).toContain("oss-cn-hangzhou.aliyuncs.com");
    });

    it("redacts sensitive response headers as well as request headers", () => {
        const headers = responseHeadersText({
            "set-cookie": ["session=do-not-expose"],
            "x-auth-token": ["token-value"],
            "x-request-id": ["request-123"],
        });
        expect(headers).toContain("request-123");
        expect(headers).not.toContain("do-not-expose");
        expect(headers).not.toContain("token-value");
        expect(responseHeadersText(null)).toBe("null");
    });

    it("redacts OSS, OBS and QBox authorization tokens and Huawei Access keys", () => {
        expect(redact("Authorization: OBS AKIAEXAMPLE:Zm9vYmFy")).not.toContain("AKIAEXAMPLE");
        expect(redact("Authorization: OSS AKEXAMPLE:c2lnbmF0dXJl")).not.toContain("AKEXAMPLE");
        expect(redact("Authorization: QBox AKQINIU:c2ln")).not.toContain("AKQINIU");
        expect(redact("SDK-HMAC-SHA256 Access=HUAWEIAK, SignedHeaders=host, Signature=abcd"))
            .not.toContain("HUAWEIAK");
        // 普通正文里的方案名不能被当成凭据抹掉
        expect(redact("Unexpected OSS response: missing BucketStat")).toContain("Unexpected OSS response");
        expect(redact("Unexpected OBS response: missing root")).toContain("Unexpected OBS response");
    });

    it("summarizes errors without leaking credentials", () => {
        const error = new Error('request failed: {"secretKey":"do-not-expose"}');
        expect(errorSummary(error)).not.toContain("do-not-expose");
        expect(errorSummary("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    });
});
