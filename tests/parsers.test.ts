import {describe, expect, it} from "vitest";
import {parseOssStat} from "../src/providers/aliyun-oss";
import {parseObsStorageInfo} from "../src/providers/huawei-obs";
import {parseTosStat} from "../src/providers/volcano-tos";
import {latestCosPoint} from "../src/providers/tencent-cos";
import {latestQiniuValue} from "../src/providers/qiniu-kodo";
import {parseMinioUsage} from "../src/providers/minio";
import {parseAwsDatapoints} from "../src/providers/aws-s3";
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
});
