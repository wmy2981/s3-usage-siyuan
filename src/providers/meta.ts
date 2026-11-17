/** 服务商在设置表单里的字段要求；与具体查询实现分开，界面不需要认识签名。 */
import type {ProviderId} from "../config";

export interface ProviderMeta {
    id: ProviderId;
    labelKey: string;
    /** 面向用户的操作文档（如何获取凭据），不要填 API 参考。 */
    docsUrl: string;
    endpointRequired: boolean;
    regionRequired: boolean;
    accountIdRequired: boolean;
    /** 需要 Account ID 之外的额外信息时（华为云用项目 ID），显示但不强制。 */
    accountIdOptional?: boolean;
    /** 覆盖 Account ID 一栏的标题；缺省用 sourceAccountId。 */
    accountIdLabelKey?: string;
    /** Account ID 一栏的说明文字。 */
    accountIdHintKey?: string;
    accessKeyLabelKey: string;
    secretKeyLabelKey: string;
    secretKeyRequired: boolean;
    bucketHintKey: string;
}

export const PROVIDER_ORDER: ProviderId[] = [
    "aliyunOss",
    "tencentCos",
    "huaweiObs",
    "volcanoTos",
    "qiniuKodo",
    "minio",
    "cloudflareR2",
    "awsS3",
];

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
    aliyunOss: {
        id: "aliyunOss",
        labelKey: "providerAliyunOss",
        docsUrl: "https://help.aliyun.com/zh/ram/user-guide/create-an-accesskey-pair",
        endpointRequired: true,
        regionRequired: true,
        accountIdRequired: false,
        accessKeyLabelKey: "providerAliyunOssToken",
        secretKeyLabelKey: "providerAliyunOssSecret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    tencentCos: {
        id: "tencentCos",
        labelKey: "providerTencentCos",
        docsUrl: "https://cloud.tencent.com/document/product/598/40488",
        endpointRequired: false,
        regionRequired: true,
        accountIdRequired: false,
        accessKeyLabelKey: "providerTencentCosToken",
        secretKeyLabelKey: "providerTencentCosSecret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    huaweiObs: {
        id: "huaweiObs",
        labelKey: "providerHuaweiObs",
        docsUrl: "https://support.huaweicloud.com/usermanual-ca/ca_01_0003.html",
        endpointRequired: true,
        regionRequired: false,
        accountIdRequired: false,
        accountIdOptional: true,
        accountIdLabelKey: "sourceHuaweiProjectId",
        accountIdHintKey: "sourceHuaweiProjectIdHint",
        accessKeyLabelKey: "providerHuaweiObsToken",
        secretKeyLabelKey: "providerHuaweiObsSecret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    volcanoTos: {
        id: "volcanoTos",
        labelKey: "providerVolcanoTos",
        docsUrl: "https://www.volcengine.com/docs/iam/api-access-key-management",
        endpointRequired: true,
        regionRequired: true,
        accountIdRequired: false,
        accessKeyLabelKey: "providerVolcanoTosToken",
        secretKeyLabelKey: "providerVolcanoTosSecret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    qiniuKodo: {
        id: "qiniuKodo",
        labelKey: "providerQiniuKodo",
        docsUrl: "https://developer.qiniu.com/kodo/kb/7450/the-third-party-plug-in-key-parameters",
        endpointRequired: false,
        regionRequired: false,
        accountIdRequired: false,
        accessKeyLabelKey: "providerQiniuKodoToken",
        secretKeyLabelKey: "providerQiniuKodoSecret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    minio: {
        id: "minio",
        labelKey: "providerMinio",
        docsUrl: "https://docs.min.io/aistor/administration/iam",
        endpointRequired: true,
        regionRequired: false,
        accountIdRequired: false,
        accessKeyLabelKey: "providerMinioToken",
        secretKeyLabelKey: "providerMinioSecret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    cloudflareR2: {
        id: "cloudflareR2",
        labelKey: "providerCloudflareR2",
        docsUrl: "https://developers.cloudflare.com/r2/api/tokens/",
        endpointRequired: false,
        regionRequired: false,
        accountIdRequired: true,
        accessKeyLabelKey: "providerCloudflareR2Token",
        secretKeyLabelKey: "providerCloudflareR2Secret",
        secretKeyRequired: false,
        bucketHintKey: "sourceBucketPlaceholder",
    },
    awsS3: {
        id: "awsS3",
        labelKey: "providerAwsS3",
        docsUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
        endpointRequired: false,
        regionRequired: true,
        accountIdRequired: false,
        accessKeyLabelKey: "providerAwsS3Token",
        secretKeyLabelKey: "providerAwsS3Secret",
        secretKeyRequired: true,
        bucketHintKey: "sourceBucketPlaceholder",
    },
};
