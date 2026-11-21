/**
 * Cloudflare R2：GraphQL Analytics。
 *
 * 单桶存储量取 `r2StorageAdaptiveGroups` 最新一条的 max(payloadSize+metadataSize)；
 * 请求数与带宽取最近 24 小时的合计（带宽字段是 bytesUpload / bytesDownload，
 * 不是 egress/ingress）。R2 的 GraphQL 是分析口径，不是计费口径。
 */
import {requestSection} from "../diagnostics";
import {asNumber, jsonPath} from "../xml";
import {requireAccessKey, requireAccountId, providerError} from "./helpers";
import type {BucketUsage, ProviderDefinition} from "./types";
import {ProviderError} from "./types";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

const QUERY = `query R2Usage($accountTag: string!, $bucketName: string!, $start: Time!, $dayStart: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      r2StorageAdaptiveGroups(
        limit: 1
        filter: {datetime_geq: $start, datetime_leq: $end, bucketName: $bucketName}
        orderBy: [datetime_DESC]
      ) {
        max { objectCount payloadSize metadataSize }
        dimensions { datetime }
      }
      r2OperationsAdaptiveGroups(
        limit: 10000
        filter: {datetime_geq: $dayStart, datetime_leq: $end, bucketName: $bucketName}
      ) {
        sum { requests }
      }
      r2BandwidthUsageAdaptiveGroups(
        limit: 1000
        filter: {datetime_geq: $dayStart, datetime_lt: $end, bucketName: $bucketName}
        orderBy: [datetimeHour_ASC]
      ) {
        sum { bytesUpload bytesDownload }
      }
    }
  }
}`;

function firstAccount(payload: unknown): unknown {
    const accounts = jsonPath(payload, "data", "viewer", "accounts");
    return Array.isArray(accounts) ? accounts[0] : undefined;
}

export function parseR2Usage(payload: unknown): BucketUsage {
    const account = firstAccount(payload);
    if (!account || typeof account !== "object") {
        return {notes: ["noteR2Range", "noteR2Daily"]};
    }
    const storage = jsonPath(account, "r2StorageAdaptiveGroups");
    const storageRow = Array.isArray(storage) ? storage[0] : undefined;
    const max = jsonPath(storageRow, "max");
    const payloadSize = asNumber(jsonPath(max, "payloadSize"));
    const metadataSize = asNumber(jsonPath(max, "metadataSize"));
    // 两个字段都没给时不能算成 0：那会把「还没有快照」画成真实的零字节
    const storageBytes = storageRow && (payloadSize !== undefined || metadataSize !== undefined)
        ? (payloadSize ?? 0) + (metadataSize ?? 0)
        : undefined;
    const objectCount = asNumber(jsonPath(max, "objectCount"));
    const datetime = jsonPath(storageRow, "dimensions", "datetime");
    const parsedTime = typeof datetime === "string" ? Date.parse(datetime) : Number.NaN;

    let requestCount = 0;
    let hasRequests = false;
    const operations = jsonPath(account, "r2OperationsAdaptiveGroups");
    if (Array.isArray(operations)) {
        for (const row of operations) {
            const value = asNumber(jsonPath(row, "sum", "requests"));
            if (value !== undefined) {
                requestCount += value;
                hasRequests = true;
            }
        }
    }

    let trafficInBytes = 0;
    let trafficOutBytes = 0;
    let hasTraffic = false;
    const bandwidth = jsonPath(account, "r2BandwidthUsageAdaptiveGroups");
    if (Array.isArray(bandwidth)) {
        for (const row of bandwidth) {
            const uploaded = asNumber(jsonPath(row, "sum", "bytesUpload"));
            const downloaded = asNumber(jsonPath(row, "sum", "bytesDownload"));
            if (uploaded !== undefined) {
                trafficInBytes += uploaded;
                hasTraffic = true;
            }
            if (downloaded !== undefined) {
                trafficOutBytes += downloaded;
                hasTraffic = true;
            }
        }
    }

    return {
        storageBytes,
        objectCount,
        requestCount: hasRequests ? requestCount : undefined,
        trafficInBytes: hasTraffic ? trafficInBytes : undefined,
        trafficOutBytes: hasTraffic ? trafficOutBytes : undefined,
        dataTime: Number.isFinite(parsedTime) ? parsedTime : undefined,
        notes: ["noteR2Range", "noteR2Daily"],
    };
}

export const cloudflareR2: ProviderDefinition = {
    id: "cloudflareR2",
    async query({source, bucket, request}) {
        const accountTag = requireAccountId(source);
        const end = new Date();
        const start = new Date(end.getTime() - 31 * 24 * 60 * 60 * 1000);
        const dayStart = new Date(end.getTime() - 24 * 60 * 60 * 1000);
        const body = JSON.stringify({
            query: QUERY,
            variables: {
                accountTag,
                bucketName: bucket,
                start: start.toISOString(),
                dayStart: dayStart.toISOString(),
                end: end.toISOString(),
            },
        });
        const response = await request({
            url: GRAPHQL_URL,
            method: "POST",
            headers: {
                Authorization: `Bearer ${requireAccessKey(source)}`,
            },
            body,
            contentType: "application/json",
        });
        let payload: unknown;
        try {
            payload = JSON.parse(response.body);
        } catch {
            throw new ProviderError(`Unexpected R2 response: not JSON\nResponse body:\n${response.body}` +
                requestSection(response));
        }
        if (response.status !== 200) {
            throw providerError(response);
        }
        const errors = jsonPath(payload, "errors");
        if (Array.isArray(errors) && errors.length > 0) {
            const message = errors.map((item) => jsonPath(item, "message")).filter((item) => typeof item === "string");
            throw new ProviderError(`${message.join("; ") || "Cloudflare GraphQL error"}\nResponse body:\n${response.body}` +
                requestSection(response));
        }
        return parseR2Usage(payload);
    },
};
