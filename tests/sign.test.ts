import {describe, expect, it} from "vitest";
import {signAwsV4} from "../src/sign/aws-v4";
import {ossV4SigningKey, signOssV4} from "../src/sign/oss-v4";
import {signTc3} from "../src/sign/tencent-tc3";
import {qiniuAuthorization, qiniuSigningString} from "../src/providers/qiniu-kodo";

/** 固定时间，避免测试随时钟漂移。 */
const fixedDate = new Date("2026-01-01T00:00:00Z");

describe("signing", () => {
    it("matches an independent AWS SigV4 vector", async () => {
        const headers = await signAwsV4({
            method: "POST",
            url: "https://monitoring.us-east-1.amazonaws.com/",
            headers: {"content-type": "application/x-www-form-urlencoded; charset=utf-8"},
            payload: "Action=GetMetricStatistics&Version=2010-08-01",
            service: "monitoring",
            region: "us-east-1",
            accessKey: "AKIDEXAMPLE",
            secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            date: fixedDate,
        });
        expect(headers.Authorization).toContain(
            "Signature=feaf9c2f59a27c565188a64d05c782afd3cbfb0114eb2bd2d2cf101dbab8d7e2",
        );
    });

    it("derives a stable OSS V4 signing key", async () => {
        // 官方示例里的 SK 是脱敏占位符，SigningKey 无法复现；这里用固定输入做回归
        expect(await ossV4SigningKey("yourAccessKeySecret", "20250411", "cn-hangzhou"))
            .toBe("8a01ff4efcc65ca2cbc75375045c61ab5f3fa8b9a2d84f0add27ef16a25feb3c");
    });

    it("matches an OSS V4 GET ?stat vector", async () => {
        const headers = await signOssV4({
            method: "GET",
            url: "https://examplebucket.oss-cn-hangzhou.aliyuncs.com/?stat",
            bucket: "examplebucket",
            subresource: "stat",
            accessKey: "LTAIEXAMPLE",
            secretKey: "yourAccessKeySecret",
            region: "cn-hangzhou",
            contentType: "application/json",
            date: fixedDate,
        });
        expect(headers.Authorization).toBe(
            "OSS4-HMAC-SHA256 Credential=LTAIEXAMPLE/20260101/cn-hangzhou/oss/aliyun_v4_request," +
                "Signature=62d738fab17312aed487a60419ecb358525809cf3809232357d2868cbde0cf02",
        );
    });

    it("matches a TOS4 GET ?stat vector", async () => {
        const headers = await signAwsV4({
            method: "GET",
            url: "https://examplebucket.tos-cn-beijing.volces.com/?stat",
            headers: {"content-type": "application/json"},
            payload: "",
            service: "tos",
            region: "cn-beijing",
            accessKey: "AKLTEXAMPLE",
            secretKey: "tosSecret",
            date: fixedDate,
            algorithm: "TOS4-HMAC-SHA256",
            dateHeader: "x-tos-date",
            payloadHeader: "x-tos-content-sha256",
            keyPrefix: "",
            terminal: "request",
            authorizationStyle: "tos",
        });
        expect(headers.Authorization).toContain(
            "Signature=13ad26f5232da13af26874ba308d0e50937e8cddff265dab14e2b4d0160bd4bc",
        );
    });

    it("matches a TC3 vector", async () => {
        const payload = '{"Namespace":"QCE/COS","MetricName":"StdStorage","Period":3600,"Instances":[{"Dimensions":[{"Name":"appid","Value":"1250000000"},{"Name":"bucket","Value":"examplebucket-1250000000"}]}],"StartTime":"2025-12-31T00:00:00.000Z","EndTime":"2026-01-01T00:00:00.000Z"}';
        const headers = await signTc3({
            url: "https://monitor.tencentcloudapi.com/",
            payload,
            service: "monitor",
            region: "ap-guangzhou",
            secretId: "AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE",
            secretKey: "Gu5t9xGARNpq86cd98joQYCN3EXAMPLE",
            action: "GetMonitorData",
            version: "2018-07-24",
            timestamp: 1767225600,
        });
        expect(headers.Authorization).toBe(
            "TC3-HMAC-SHA256 Credential=AKIDz8krbsJ5yKBZQpn74WFkmLPx3EXAMPLE/2026-01-01/monitor/tc3_request, " +
                "SignedHeaders=content-type;host;x-tc-action, " +
                "Signature=fa60fd293d33b3639d2ea647e7885b79bd20340693d83781dcff4ef37ef0fc33",
        );
    });

    it("matches a Qiniu management API vector", async () => {
        const signing = qiniuSigningString(
            "GET",
            "/v6/space",
            "bucket=test&begin=20260101000000&end=20260102000000&g=day",
            "api.qiniuapi.com",
            "application/x-www-form-urlencoded",
            "20260101T000000Z",
        );
        expect(signing).toBe(
            "GET /v6/space?bucket=test&begin=20260101000000&end=20260102000000&g=day\n" +
                "Host: api.qiniuapi.com\n" +
                "Content-Type: application/x-www-form-urlencoded\n" +
                "X-Qiniu-Date: 20260101T000000Z\n\n",
        );
        expect(await qiniuAuthorization("qiniuAK", "qiniuSK", signing)).toBe("Qiniu qiniuAK:DEfDF88St1jTz1Z96Bz7Gu4uyOQ=");
    });
});
