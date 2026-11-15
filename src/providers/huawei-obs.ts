/**
 * 华为云 OBS：GetBucketStorageInfo（`GET /?storageinfo`）。
 *
 * 使用 OBS 原生 Header 签名（V2）：HMAC-SHA1 + base64，Authorization 标签为 `OBS`。
 * 官方示例不带 Content-Type，但转发层一定会写一个，所以这里显式按 `application/json` 签名，
 * 保证待签字符串与实际请求逐字一致。
 */
import {signObsV2, virtualHostBucketUrl} from "../sign/oss-v1";
import {numberAt, parseXml, recordAt} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import type {BucketUsage, ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

function parseStorageInfo(body: string): BucketUsage {
    const root = recordAt(parseXml(body), "GetBucketStorageInfoResult");
    if (!root) {
        throw new ProviderError("Unexpected OBS response: missing GetBucketStorageInfoResult");
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, storageKey: string, objectKey: string) => {
        const storageBytes = numberAt(root, storageKey);
        const objectCount = numberAt(root, objectKey);
        if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
            classes.push({key, name, storageBytes, objectCount});
        }
    };
    addClass("standard", "STANDARD", "StandardSize", "StandardObjectNumber");
    addClass("ia", "WARM", "WarmSize", "WarmObjectNumber");
    addClass("archive", "COLD", "ColdSize", "ColdObjectNumber");
    addClass("deepArchive", "DEEP_ARCHIVE", "DeepArchiveSize", "DeepArchiveObjectNumber");

    return {
        storageBytes: numberAt(root, "Size"),
        objectCount: numberAt(root, "ObjectNumber"),
        storageClasses: classes,
        notes: ["noteObsDelay"],
    };
}

export const huaweiObs: ProviderDefinition = {
    id: "huaweiObs",
    labelKey: "providerHuaweiObs",
    docsUrl: "https://support.huaweicloud.com/api-obs/obs_04_0054.html",
    endpointRequired: true,
    regionRequired: false,
    accountIdRequired: false,
    accessKeyLabelKey: "providerHuaweiObsToken",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query({source, bucket, request}) {
        const endpoint = requireEndpoint(source);
        const url = virtualHostBucketUrl(endpoint, bucket, "storageinfo");
        const headers = await signObsV2({
            method: "GET",
            url,
            bucket,
            subresource: "storageinfo",
            accessKey: requireAccessKey(source),
            secretKey: requireSecretKey(source),
            contentType: "application/json",
        });
        const response = await request({
            url,
            method: "GET",
            headers,
            contentType: "application/json",
        });
        if (response.status !== 200) {
            throw providerError(response.status, response.body);
        }
        return parseStorageInfo(response.body);
    },
};

export {parseStorageInfo as parseObsStorageInfo};
