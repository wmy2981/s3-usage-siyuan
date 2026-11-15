/**
 * 火山引擎 TOS：GetBucketStat（`GET /?stat`）。
 *
 * 使用 TOS4-HMAC-SHA256：与 AWS SigV4 同构，但签名密钥起点是裸 SK（没有 `AWS4` 前缀），
 * scope 终止串是 `request`，Authorization 的逗号后不带空格。子资源 `?stat` 必须出现在
 * CanonicalQueryString 里写成 `stat=`，否则签名对不上。
 */
import {signAwsV4} from "../sign/aws-v4";
import {virtualHostBucketUrl} from "../sign/oss-v1";
import {numberAt, parseXml, recordAt} from "../xml";
import {requireAccessKey, requireEndpoint, requireRegion, requireSecretKey, providerError} from "./helpers";
import type {BucketUsage, ProviderDefinition, StorageClassUsage} from "./types";
import {ProviderError} from "./types";

function parseTosStat(body: string): BucketUsage {
    const root = recordAt(parseXml(body), "BucketStat");
    if (!root) {
        throw new ProviderError("Unexpected TOS response: missing BucketStat");
    }
    const classes: StorageClassUsage[] = [];
    const addClass = (key: string, name: string, nodeName: string) => {
        const node = recordAt(root, nodeName);
        const storageBytes = numberAt(node, "Storage");
        const objectCount = numberAt(node, "ObjectCount");
        if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
            classes.push({key, name, storageBytes, objectCount});
        }
    };
    addClass("standard", "STANDARD", "StandardStorageStat");
    addClass("ia", "IA", "IAStorageStat");
    addClass("archive", "ARCHIVE", "ArchiveStorageStat");
    addClass("coldArchive", "COLD_ARCHIVE", "ColdArchiveStorageStat");
    addClass("deepArchive", "DEEP_COLD_ARCHIVE", "DeepColdArchiveStorageStat");
    const intelligent = recordAt(root, "IntelligentTieringStorageStats");
    if (intelligent) {
        const addIntelligent = (key: string, name: string, nodeName: string) => {
            const node = recordAt(intelligent, nodeName);
            const storageBytes = numberAt(node, "Storage");
            const objectCount = numberAt(node, "ObjectCount");
            if ((storageBytes ?? 0) > 0 || (objectCount ?? 0) > 0) {
                classes.push({key, name, storageBytes, objectCount});
            }
        };
        addIntelligent("intelligentFa", "INTELLIGENT_TIERING_FA", "HighFreqStorageStat");
        addIntelligent("intelligentIa", "INTELLIGENT_TIERING_IA", "LowFreqStorageStat");
        addIntelligent("intelligentArchive", "INTELLIGENT_TIERING_ARCHIVE", "ArchiveFrStorageStat");
    }
    const total = recordAt(root, "TotalStorageStat");
    return {
        storageBytes: numberAt(total, "Storage") ??
            classes.reduce((sum, item) => sum + (item.storageBytes ?? 0), 0),
        objectCount: numberAt(total, "ObjectCount") ??
            classes.reduce((sum, item) => sum + (item.objectCount ?? 0), 0),
        storageClasses: classes,
        notes: ["noteTosDelay"],
    };
}

export const volcanoTos: ProviderDefinition = {
    id: "volcanoTos",
    labelKey: "providerVolcanoTos",
    docsUrl: "https://www.volcengine.com/docs/TorchObjectStorage/GetBucketStat",
    endpointRequired: true,
    regionRequired: true,
    accountIdRequired: false,
    accessKeyLabelKey: "providerVolcanoTosToken",
    secretKeyRequired: true,
    bucketHintKey: "sourceBucketPlaceholder",
    async query({source, bucket, request}) {
        const endpoint = requireEndpoint(source);
        const region = requireRegion(source);
        const url = virtualHostBucketUrl(endpoint, bucket, "stat");
        const headers = await signAwsV4({
            method: "GET",
            url,
            headers: {"content-type": "application/json"},
            payload: "",
            service: "tos",
            region,
            accessKey: requireAccessKey(source),
            secretKey: requireSecretKey(source),
            algorithm: "TOS4-HMAC-SHA256",
            dateHeader: "x-tos-date",
            payloadHeader: "x-tos-content-sha256",
            keyPrefix: "",
            terminal: "request",
            authorizationStyle: "tos",
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
        return parseTosStat(response.body);
    },
};

export {parseTosStat};
