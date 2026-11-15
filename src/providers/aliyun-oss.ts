/**
 * 阿里云 OSS：GetBucketStat（`GET /?stat`）。
 *
 * 返回桶总存储量、对象数、未完成分片与各存储类型明细；使用 OSS V1 签名。
 * 官方明确统计非实时，延时可能超过 1 小时；低频/归档的 Storage 是计费口径。
 */
import {regionFromEndpoint} from "../config";
import {signV2, virtualHostBucketUrl} from "../sign/oss-v1";
import {signOssV4} from "../sign/oss-v4";
import {numberAt, parseXml, recordAt} from "../xml";
import {requireAccessKey, requireEndpoint, requireSecretKey, providerError} from "./helpers";
import type {BucketUsage, ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

function parseStat(body: string): BucketUsage {
    const root = recordAt(parseXml(body), "BucketStat");
    if (!root) {
        throw new ProviderError("Unexpected OSS response: missing BucketStat");
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, storageKey: string, objectKey: string) => {
        const storageBytes = numberAt(root, storageKey);
        const objectCount = numberAt(root, objectKey);
        if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
            classes.push({key, name, storageBytes, objectCount});
        }
    };
    addClass("standard", "StandardStorage", "StandardStorage", "StandardObjectCount");
    addClass("ia", "InfrequentAccessStorage", "InfrequentAccessStorage", "InfrequentAccessObjectCount");
    addClass("archive", "ArchiveStorage", "ArchiveStorage", "ArchiveObjectCount");
    addClass("coldArchive", "ColdArchiveStorage", "ColdArchiveStorage", "ColdArchiveObjectCount");
    addClass("deepArchive", "DeepColdArchiveStorage", "DeepColdArchiveStorage", "DeepColdArchiveObjectCount");

    const storageBytes = numberAt(root, "Storage") ?? classes.reduce((sum, item) => sum + (item.storageBytes ?? 0), 0);
    const objectCount = numberAt(root, "ObjectCount") ?? classes.reduce((sum, item) => sum + (item.objectCount ?? 0), 0);
    const lastModified = numberAt(root, "LastModifiedTime");
    return {
        storageBytes,
        objectCount,
        multipartCount: numberAt(root, "MultipartUploadCount"),
        storageClasses: classes,
        dataTime: lastModified && lastModified > 0 ? lastModified * 1000 : undefined,
        notes: ["noteOssDelay"],
    };
}

export const aliyunOss: ProviderDefinition = {
    id: "aliyunOss",
    labelKey: "providerAliyunOss",
    docsUrl: "https://help.aliyun.com/zh/oss/developer-reference/getbucketstat",
    endpointRequired: true,
    regionRequired: false,
    accountIdRequired: false,
    accessKeyLabelKey: "providerAliyunOssToken",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query({source, bucket, request}) {
        const endpoint = requireEndpoint(source);
        const url = virtualHostBucketUrl(endpoint, bucket, "stat");
        const region = source.region.trim() || regionFromEndpoint(endpoint, "aliyunOss");
        if (region === "") {
            throw new ProviderError("Region is required for OSS V4 signature");
        }
        const contentType = "application/json";
        const v4Headers = await signOssV4({
            method: "GET",
            url,
            bucket,
            subresource: "stat",
            accessKey: requireAccessKey(source),
            secretKey: requireSecretKey(source),
            region,
            contentType,
        });
        let response = await request({url, method: "GET", headers: v4Headers, contentType});
        // 老账号/老桶可能还没开 V4，403 时退回 V1；新桶 V4 正常时不会走到这里
        if (response.status === 403) {
            const v1Headers = await signV2({
                method: "GET",
                url,
                bucket,
                subresource: "stat",
                accessKey: requireAccessKey(source),
                secretKey: requireSecretKey(source),
                contentType,
                headerPrefix: "x-oss-",
            });
            response = await request({url, method: "GET", headers: v1Headers, contentType});
        }
        if (response.status !== 200) {
            throw providerError(response.status, response.body);
        }
        return parseStat(response.body);
    },
};

/** 供单元测试使用的纯解析函数。 */
export {parseStat as parseOssStat};
