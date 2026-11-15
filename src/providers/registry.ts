/** 服务商注册表：界面按 id 取适配器，未知 id 一律抛错而不是静默当 MinIO。 */
import type {ProviderId} from "../config";
import {aliyunOss} from "./aliyun-oss";
import {awsS3} from "./aws-s3";
import {cloudflareR2} from "./cloudflare-r2";
import {huaweiObs} from "./huawei-obs";
import {minio} from "./minio";
import {qiniuKodo} from "./qiniu-kodo";
import {tencentCos} from "./tencent-cos";
import {volcanoTos} from "./volcano-tos";
import type {ProviderDefinition} from "./types";

export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
    aliyunOss,
    tencentCos,
    huaweiObs,
    volcanoTos,
    qiniuKodo,
    minio,
    cloudflareR2,
    awsS3,
};

export function providerFor(id: ProviderId): ProviderDefinition {
    const provider = PROVIDERS[id];
    if (!provider) {
        throw new Error(`Unknown provider: ${id}`);
    }
    return provider;
}
