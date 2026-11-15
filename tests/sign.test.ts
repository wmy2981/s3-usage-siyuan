import {describe, expect, it} from "vitest";
import {createHash, createHmac} from "node:crypto";
import {signAwsV4} from "../src/sign/aws-v4";
import {ossV4SigningKey, signOssV4} from "../src/sign/oss-v4";
import {signTc3} from "../src/sign/tencent-tc3";
import {qiniuAuthorization, qiniuSigningString} from "../src/providers/qiniu-kodo";
import {aliyunRpcUrl} from "../src/sign/aliyun-rpc";
import {huaweiSignedParts, huaweiUrl, signHuaweiSdk} from "../src/sign/huawei-sdk";
import {minioMetricsToken} from "../src/sign/minio-jwt";

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

    it("matches the documented Aliyun RPC signature example", async () => {
        // 官方 RPC 签名文档里的示例：AccessKeySecret=testsecret，签名值 9NaGiOspFP5UPcwX8Iwt2YJXXuk=
        const url = await aliyunRpcUrl({
            endpoint: "https://ecs.aliyuncs.com",
            action: "DescribeDedicatedHosts",
            version: "2014-05-26",
            params: {RegionId: "cn-beijing"},
            accessKey: "testid",
            secretKey: "testsecret",
            date: new Date("2023-03-13T08:34:30Z"),
            nonce: "edb2b34af0af9a6d14deaf7c1a5315eb",
        });
        const params = new URL(url).searchParams;
        expect(params.get("Signature")).toBe("9NaGiOspFP5UPcwX8Iwt2YJXXuk=");
        expect(params.get("Timestamp")).toBe("2023-03-13T08:34:30Z");
        expect(params.get("Format")).toBe("JSON");
    });

    it("matches the documented Volcengine signature example", async () => {
        // 火山引擎「签名过程Demo」：AccessKey/SecretAccessKey 与最终 Authorization 都是公开示例值
        const headers = await signAwsV4({
            method: "GET",
            url: "https://iam.volcengineapi.com?Action=ListUsers&Limit=10&Offset=0&Version=2018-01-01",
            payload: "",
            service: "iam",
            region: "cn-beijing",
            accessKey: "AKLTYWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg",
            secretKey: "WkRZeE1EQmxPVGhsWWpWak5HVmtNbUUxTXpZeU9UVXlOMlE1TmpZeVlqTQ==",
            date: new Date("2024-06-19T07:13:06Z"),
            algorithm: "HMAC-SHA256",
            dateHeader: "x-date",
            payloadHeader: null,
            keyPrefix: "",
            terminal: "request",
        });
        expect(headers.Authorization).toBe(
            "HMAC-SHA256 Credential=AKLTYWViMTVmZGYzM2E0NDI5Mzk2MDZjNjFmMjc2MjRjMzg" +
                "/20240619/cn-beijing/iam/request, SignedHeaders=host;x-date, " +
                "Signature=e31c4558bcfe08a286001f59cedbf0791ffd0b2362f10e55ee2627467bcdde93",
        );
        expect(headers["x-content-sha256"]).toBeUndefined();
    });

    it("signs Aliyun RPC requests with the documented algorithm", async () => {
        const date = new Date("2026-01-01T00:00:00Z");
        const url = await aliyunRpcUrl({
            endpoint: "https://metrics.cn-hangzhou.aliyuncs.com",
            action: "DescribeMetricList",
            version: "2019-01-01",
            params: {
                Namespace: "acs_oss_dashboard",
                MetricName: "InternetSend",
                Period: "60",
                StartTime: "1767225600000",
                EndTime: "1767312000000",
                Dimensions: '{"BucketName":"demo"}',
            },
            accessKey: "testid",
            secretKey: "testsecret",
            date,
            nonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf",
        });
        const params = new URL(url).searchParams;
        expect(params.get("Format")).toBe("JSON");
        expect(params.get("Timestamp")).toBe("2026-01-01T00:00:00Z");

        // 按官方 RPC 签名规则独立算一遍：排序 → percentEncode → HMAC-SHA1(secret + "&")
        const encode = (value: string) => encodeURIComponent(value)
            .replace(/\+/g, "%20")
            .replace(/\*/g, "%2A")
            .replace(/%7E/g, "~");
        const canonical = [...params.entries()]
            .filter(([name]) => name !== "Signature")
            .map(([name, value]) => [encode(name), encode(value)] as const)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([name, value]) => `${name}=${value}`)
            .join("&");
        const stringToSign = `GET&${encode("/")}&${encode(canonical)}`;
        const expected = createHmac("sha1", "testsecret&").update(stringToSign).digest("base64");
        expect(params.get("Signature")).toBe(expected);
    });

    it("reproduces the documented Huawei canonical request hash", async () => {
        // 官方「API签名认证机制示例」里的规范请求哈希，可用于校验路径补斜杠、空行与排序
        const parts = await huaweiSignedParts({
            method: "GET",
            url: "https://service.region.example.com/v1/77b6a44cba5143ab91d13ab9a8ff44fd/vpcs" +
                "?limit=2&marker=13551d6b-755d-4757-b956-536f674975c0",
            headers: {"content-type": "application/json"},
            payload: "",
            accessKey: "QTWAKYUC",
            secretKey: "unused",
            date: new Date("2019-11-15T03:36:55Z"),
        });
        expect(parts.signedHeaders).toBe("content-type;host;x-sdk-date");
        expect(createHash("sha256").update(parts.canonicalRequest).digest("hex"))
            .toBe("b25362e603ee30f4f25e7858e8a7160fd36e803bb2dfe206278659d71a9bcd7a");
    });

    it("signs Huawei AK/SK requests with SDK-HMAC-SHA256", async () => {
        const date = new Date("2026-01-01T00:00:00Z");
        const url = huaweiUrl("https://ces.cn-north-4.myhuaweicloud.com/V1.0/project-id/metric-data", {
            namespace: "SYS.OBS",
            metric_name: "download_traffic",
            "dim.0": "bucket_name,demo",
            from: "1767225600000",
            to: "1767312000000",
            period: "3600",
            filter: "sum",
        });
        const headers = await signHuaweiSdk({
            method: "GET",
            url,
            headers: {"content-type": "application/json"},
            accessKey: "AK",
            secretKey: "SK",
            date,
        });
        const parsed = new URL(url);
        const encode = (value: string) => encodeURIComponent(value)
            .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
        const path = `${parsed.pathname.split("/").map(encode).join("/")}/`;
        const query = [...parsed.searchParams.entries()]
            .map(([name, value]) => [encode(name), encode(value)] as const)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([name, value]) => `${name}=${value}`)
            .join("&");
        const canonicalHeaders = `content-type:application/json\nhost:${parsed.host}\nx-sdk-date:20260101T000000Z\n`;
        const signedHeaders = "content-type;host;x-sdk-date";
        const canonicalRequest = [
            "GET",
            path,
            query,
            canonicalHeaders,
            signedHeaders,
            createHash("sha256").update("").digest("hex"),
        ].join("\n");
        const stringToSign = [
            "SDK-HMAC-SHA256",
            "20260101T000000Z",
            createHash("sha256").update(canonicalRequest).digest("hex"),
        ].join("\n");
        const signature = createHmac("sha256", "SK").update(stringToSign).digest("hex");
        expect(headers.Authorization).toBe(
            `SDK-HMAC-SHA256 Access=AK, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        );
        expect(headers["x-sdk-date"]).toBe("20260101T000000Z");
    });

    it("builds a MinIO metrics JWT signed with the secret key", async () => {
        const date = new Date("2026-01-01T00:00:00Z");
        const token = await minioMetricsToken("AK", "SK", date);
        const [header, payload, signature] = token.split(".");
        expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({alg: "HS512", typ: "JWT"});
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(claims).toEqual({
            exp: Math.floor(date.getTime() / 1000) + 100 * 365 * 24 * 60 * 60,
            sub: "AK",
            iss: "prometheus",
        });
        expect(signature).toBe(createHmac("sha512", "SK").update(`${header}.${payload}`).digest("base64url"));
    });
});
