/**
 * 服务商适配器的公共契约。
 *
 * 每个适配器只负责「一次 HTTP 请求 + 解析成统一用量」，签名、Endpoint 拼接和错误文案
 * 都留在各自的文件里；界面层不认识任何厂商字段。
 */
import type {DataSource, ProviderId} from "../config";

export interface ForwardRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** 请求体原文；GET 时为空。 */
    body?: string;
    /** 必须与签名时使用的 Content-Type 完全一致（内核会原样写到请求上）。 */
    contentType: string;
}

/** 出错的请求上下文；只在需要展示诊断时才格式化成文本。 */
export interface ForwardDiagnostics {
    request: ForwardRequest;
    timeoutMs: number;
}

export interface ForwardResponse {
    status: number;
    body: string;
    headers: Record<string, string[]> | null;
    /** 请求上下文引用，不预先格式化；成功路径不产生额外开销。 */
    diagnostics?: ForwardDiagnostics;
}

export type RequestFn = (request: ForwardRequest) => Promise<ForwardResponse>;

export interface QueryContext {
    source: DataSource;
    bucket: string;
    timeoutMs: number;
    request: RequestFn;
}

/** 一个存储类型的明细。key 用于翻译，name 是服务商原文兜底。 */
export interface StorageClassUsage {
    key: string;
    name: string;
    storageBytes?: number;
    objectCount?: number;
}

/** 统一用量。未提供的字段保持 undefined，界面显示破折号。 */
export interface BucketUsage {
    storageBytes?: number;
    objectCount?: number;
    multipartCount?: number;
    trafficInBytes?: number;
    trafficOutBytes?: number;
    requestCount?: number;
    storageClasses?: StorageClassUsage[];
    /** 服务商统计时间（毫秒）；接口没给时为 undefined。 */
    dataTime?: number;
    /** 界面上的附加说明，例如「数据延迟约 2 小时」；成功时也可能有，保持灰色。 */
    notes?: string[];
    /** 真正失败的提示，例如监控接口报错；界面统一标红。 */
    errors?: string[];
}

export interface ProviderDefinition {
    id: ProviderId;
    /** i18n key，例如 provider.aliyunOss */
    labelKey: string;
    endpointRequired: boolean;
    regionRequired: boolean;
    accountIdRequired: boolean;
    accessKeyLabelKey: string;
    secretKeyRequired: boolean;
    bucketHintKey: string;
    query(ctx: QueryContext): Promise<BucketUsage>;
}

/** 服务商返回的可读错误；界面只展示 message，不展示请求头。 */
export class ProviderError extends Error {
    readonly code: string;

    constructor(message: string, code = "") {
        super(message);
        this.name = "ProviderError";
        this.code = code;
    }
}
