import {describe, expect, it} from "vitest";
import {parseCmsDatapoints, parseOssStat} from "../src/providers/aliyun-oss";
import {parseCesDatapoints, parseObsStorageInfo} from "../src/providers/huawei-obs";
import {parseTosStat, parseVolcanoPoints} from "../src/providers/volcano-tos";
import {latestCosPoint, summedCosPoint} from "../src/providers/tencent-cos";
import {latestQiniuValue, sumQiniuSeries} from "../src/providers/qiniu-kodo";
import {parseMinioMetrics, parseMinioUsage} from "../src/providers/minio";
import {parseAwsDatapoints, parseAwsSeries, parseListMetricsFilters} from "../src/providers/aws-s3";
import {parseR2Usage} from "../src/providers/cloudflare-r2";

describe("provider parsers", () => {
    it("parses OSS BucketStat", () => {
        const usage = parseOssStat(`<?xml version="1.0"?>
<BucketStat>
  <Storage>1600</Storage>
  <ObjectCount>230</ObjectCount>
  <MultipartUploadCount>40</MultipartUploadCount>
  <LastModifiedTime>1643341269</LastModifiedTime>
  <StandardStorage>430</StandardStorage>
  <StandardObjectCount>66</StandardObjectCount>
  <InfrequentAccessStorage>2359296</InfrequentAccessStorage>
  <InfrequentAccessObjectCount>54</InfrequentAccessObjectCount>
  <DeepColdArchiveStorage>10</DeepColdArchiveStorage>
  <DeepColdArchiveObjectCount>1</DeepColdArchiveObjectCount>
</BucketStat>`);
        expect(usage.storageBytes).toBe(1600);
        expect(usage.objectCount).toBe(230);
        expect(usage.multipartCount).toBe(40);
        expect(usage.dataTime).toBe(1643341269000);
        expect(usage.storageClasses?.map((item) => item.key)).toEqual(["standard", "ia", "deepArchive"]);
    });

    it("parses OBS GetBucketStorageInfo", () => {
        const usage = parseObsStorageInfo(`<?xml version="1.0" encoding="UTF-8"?>
<GetBucketStorageInfoResult xmlns="http://obs.cn-north-4.myhuaweicloud.com/doc/2015-06-30/">
  <Size>25490</Size>
  <ObjectNumber>24</ObjectNumber>
  <StandardSize>25490</StandardSize>
  <StandardObjectNumber>24</StandardObjectNumber>
</GetBucketStorageInfoResult>`);
        expect(usage.storageBytes).toBe(25490);
        expect(usage.objectCount).toBe(24);
        expect(usage.storageClasses).toHaveLength(1);
    });

    it("parses TOS BucketStat", () => {
        const usage = parseTosStat(`<?xml version="1.0" encoding="UTF-8"?>
<BucketStat>
  <TotalStorageStat><Storage>43087225856</Storage><ChargeStorage>43087225856</ChargeStorage><ObjectCount>10553469</ObjectCount></TotalStorageStat>
  <StandardStorageStat><Storage>43087225856</Storage><ChargeStorage>43087225856</ChargeStorage><ObjectCount>10553469</ObjectCount></StandardStorageStat>
  <IAStorageStat><Storage>0</Storage><ChargeStorage>0</ChargeStorage><ObjectCount>0</ObjectCount></IAStorageStat>
</BucketStat>`);
        expect(usage.storageBytes).toBe(43087225856);
        expect(usage.objectCount).toBe(10553469);
        expect(usage.storageClasses?.[0].name).toBe("STANDARD");
    });

    it("takes the latest COS datapoint", () => {
        const point = latestCosPoint({
            Response: {
                DataPoints: [{
                    Timestamps: [1767225600, 1767229200],
                    Values: [10, 20],
                }],
            },
        });
        expect(point).toEqual({timestamp: 1767229200, value: 20});
        expect(latestCosPoint({Response: {DataPoints: []}})).toEqual({});
    });

    it("takes the latest Qiniu value", () => {
        expect(latestQiniuValue('{"times":[1767225600,1767229200],"datas":[100,200]}'))
            .toEqual({timestamp: 1767229200, value: 200});
        expect(latestQiniuValue('{"times":[],"datas":[]}')).toEqual({});
    });

    it("parses MinIO datausageinfo", () => {
        const usage = parseMinioUsage(JSON.stringify({
            lastUpdate: "2026-06-18T09:23:54.518950731Z",
            bucketsUsageInfo: {
                photos: {size: 85899345920, objectsCount: 15100, versionsCount: 15200},
            },
        }), "photos");
        expect(usage.storageBytes).toBe(85899345920);
        expect(usage.objectCount).toBe(15100);
        expect(usage.dataTime).toBe(Date.parse("2026-06-18T09:23:54.518Z"));
    });

    it("parses AWS CloudWatch datapoints", () => {
        const point = parseAwsDatapoints(`<?xml version="1.0" encoding="UTF-8"?>
<GetMetricStatisticsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/">
  <GetMetricStatisticsResult>
    <Datapoints>
      <member><Timestamp>2026-11-13T00:00:00Z</Timestamp><Average>100</Average><Unit>Bytes</Unit></member>
      <member><Timestamp>2026-11-14T00:00:00Z</Timestamp><Average>200</Average><Unit>Bytes</Unit></member>
    </Datapoints>
    <Label>BucketSizeBytes</Label>
  </GetMetricStatisticsResult>
</GetMetricStatisticsResponse>`);
        expect(point.value).toBe(200);
        expect(point.timestamp).toBe(Date.parse("2026-11-14T00:00:00Z"));
    });

    it("parses R2 GraphQL rows", () => {
        const usage = parseR2Usage({
            data: {
                viewer: {
                    accounts: [{
                        r2StorageAdaptiveGroups: [{
                            max: {objectCount: 10, payloadSize: 1000, metadataSize: 24},
                            dimensions: {datetime: "2026-11-15T00:00:00Z"},
                        }],
                        r2OperationsAdaptiveGroups: [
                            {sum: {requests: 3}},
                            {sum: {requests: 4}},
                        ],
                        r2BandwidthUsageAdaptiveGroups: [
                            {sum: {bytesUpload: 10, bytesDownload: 20}},
                            {sum: {bytesUpload: 1, bytesDownload: 2}},
                        ],
                    }],
                },
            },
        });
        expect(usage.storageBytes).toBe(1024);
        expect(usage.objectCount).toBe(10);
        expect(usage.requestCount).toBe(7);
        expect(usage.trafficInBytes).toBe(11);
        expect(usage.trafficOutBytes).toBe(22);
        expect(usage.dataTime).toBe(Date.parse("2026-11-15T00:00:00Z"));
    });

    it("leaves R2 storage undefined when the snapshot has no sizes", () => {
        const usage = parseR2Usage({
            data: {
                viewer: {
                    accounts: [{
                        r2StorageAdaptiveGroups: [{
                            max: {objectCount: 0, payloadSize: null, metadataSize: null},
                            dimensions: {datetime: "not-a-date"},
                        }],
                    }],
                },
            },
        });
        expect(usage.storageBytes).toBeUndefined();
        expect(usage.objectCount).toBe(0);
        expect(usage.dataTime).toBeUndefined();
        // 只有一个字段有值时按 0 补另一半，仍然是「有值」
        expect(parseR2Usage({
            data: {viewer: {accounts: [{
                r2StorageAdaptiveGroups: [{max: {payloadSize: 100}, dimensions: {datetime: "2026-11-15T00:00:00Z"}}],
            }]}},
        }).storageBytes).toBe(100);
    });

    it("parses CloudMonitor Datapoints JSON string", () => {
        const payload = {
            Success: true,
            Datapoints: JSON.stringify([
                {timestamp: 1767225600000, Average: 10},
                {timestamp: 1767225660000, Average: 5},
            ]),
        };
        expect(parseCmsDatapoints(payload)).toEqual([10, 5]);
        expect(parseCmsDatapoints({Success: true, Datapoints: ""})).toEqual([]);
        // null 不能当成 0，否则会把「没有数据」画成真实的零
        expect(parseCmsDatapoints({Datapoints: JSON.stringify([{Average: null, Sum: 7}])})).toEqual([7]);
    });

    it("parses CES datapoints by statistic field", () => {
        const payload = {
            datapoints: [
                {sum: 1024, average: 17, timestamp: 1},
                {sum: 2048, average: 34, timestamp: 2},
            ],
        };
        expect(parseCesDatapoints(payload, "sum")).toEqual([1024, 2048]);
        expect(parseCesDatapoints(payload, "average")).toEqual([17, 34]);
    });

    it("parses Volcengine cloud monitor points", () => {
        expect(parseVolcanoPoints({
            Result: {
                Data: {
                    MetricDataResults: [
                        {DataPoints: [{Value: 1.5, Timestamp: 1}, {Value: 2, Timestamp: 2}]},
                    ],
                },
            },
        })).toEqual([1.5, 2]);
    });

    it("sums COS datapoints for the monitoring window", () => {
        expect(summedCosPoint({
            Response: {DataPoints: [{Timestamps: [1, 2], Values: [10, 5]}, {Timestamps: [3], Values: [1]}]},
        })).toEqual({value: 16, timestamp: 3});
        expect(summedCosPoint({Response: {DataPoints: []}})).toEqual({});
    });

    it("sums Qiniu blob_io series in both response shapes", () => {
        expect(sumQiniuSeries(
            '[{"time":"2026-11-14T00:00:00+08:00","values":{"flow":10}},' +
            '{"time":"2026-11-14T01:00:00+08:00","values":{"flow":5}}]',
            "flow",
        )).toBe(15);
        expect(sumQiniuSeries('{"times":[1,2],"datas":[10,5]}', "flow")).toBe(15);
    });

    it("parses MinIO Prometheus bucket metrics", () => {
        const body = [
            "# HELP minio_bucket_traffic_received_bytes Total bytes received",
            'minio_bucket_traffic_received_bytes{bucket="photos",server="n:9000"} 1024',
            'minio_bucket_traffic_sent_bytes{bucket="photos",server="n:9000"} 2048',
            'minio_bucket_traffic_sent_bytes{bucket="other",server="n:9000"} 999',
            'minio_bucket_requests_total{bucket="photos",api="PutObject",server="n:9000"} 3',
            'minio_bucket_requests_total{bucket="photos",api="GetObject",server="n:9000"} 4',
        ].join("\n");
        const metrics = parseMinioMetrics(body, "photos");
        expect(metrics.trafficInBytes).toBe(1024);
        expect(metrics.trafficOutBytes).toBe(2048);
        expect(metrics.requestCount).toBe(7);
        expect(parseMinioMetrics(body, "missing")).toEqual({});
        // 没有 bucket 标签的样本属于集群级汇总：只允许 v3 单桶端点把它算进本桶
        const cluster = 'minio_bucket_traffic_received_bytes 4096\nminio_bucket_requests_total{api="Put"} 9';
        expect(parseMinioMetrics(cluster, "photos")).toEqual({});
        expect(parseMinioMetrics(cluster, "photos", true).trafficInBytes).toBe(4096);
    });

    it("parses AWS request metric series and FilterId dimensions", () => {
        expect(parseListMetricsFilters(`<?xml version="1.0" encoding="UTF-8"?>
<ListMetricsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/">
  <ListMetricsResult>
    <Metrics>
      <member>
        <Namespace>AWS/S3</Namespace>
        <MetricName>AllRequests</MetricName>
        <Dimensions>
          <member><Name>BucketName</Name><Value>demo</Value></member>
          <member><Name>FilterId</Name><Value>EntireBucket</Value></member>
        </Dimensions>
      </member>
    </Metrics>
  </ListMetricsResult>
</ListMetricsResponse>`)).toEqual(["EntireBucket"]);
        expect(parseListMetricsFilters("<ListMetricsResponse><ListMetricsResult><Metrics/></ListMetricsResult></ListMetricsResponse>"))
            .toEqual([]);

        const series = parseAwsSeries(`<?xml version="1.0" encoding="UTF-8"?>
<GetMetricStatisticsResponse xmlns="http://monitoring.amazonaws.com/doc/2010-08-01/">
  <GetMetricStatisticsResult>
    <Datapoints>
      <member><Timestamp>2026-11-14T00:00:00Z</Timestamp><Sum>5</Sum></member>
      <member><Timestamp>2026-11-14T01:00:00Z</Timestamp><Sum>7</Sum></member>
    </Datapoints>
  </GetMetricStatisticsResult>
</GetMetricStatisticsResponse>`, "Sum");
        expect(series.map((point) => point.value)).toEqual([5, 7]);
    });
});
