# S3 Bucket Usage

[简体中文](README.zh-CN.md)

View bucket usage of S3-compatible object storage inside SiYuan: storage size, object count, traffic and request counts, with per-storage-class details.

![Preview](https://gcore.jsdelivr.net/gh/wmy2981/s3-usage-siyuan@dev/assets/preview.png)

## Features

- One dialog for all configured accounts; switch between usage and data-source management without stacking windows.
- Eight providers with their official bucket-usage interfaces:

  | Provider | Interface | Storage | Objects | Traffic | Requests |
  | --- | --- | --- | --- | --- | --- |
  | Alibaba Cloud OSS | `GetBucketStat` (`GET /?stat`) | ✅ | ✅ | — | — |
  | Tencent Cloud COS | Cloud Monitor `GetMonitorData` (`QCE/COS`) | ✅ | ✅ | ✅ | ✅ |
  | Huawei Cloud OBS | `GetBucketStorageInfo` (`GET /?storageinfo`) | ✅ | ✅ | — | — |
  | Volcano Engine TOS | `GetBucketStat` (`GET /?stat`) | ✅ | ✅ | — | — |
  | Qiniu Kodo | `/v6/space`, `/v6/count` and siblings | ✅ | ✅ | — | — |
  | MinIO / S3-compatible | Admin API `datausageinfo` | ✅ | ✅ | — | — |
  | Cloudflare R2 | GraphQL Analytics (`r2*AdaptiveGroups`) | ✅ | ✅ | ✅ (24 h) | ✅ (24 h) |
  | AWS S3 | CloudWatch `GetMetricStatistics` metrics | ✅ | ✅ | — | — |

- Generic and per-storage-class numbers; unavailable metrics are shown as `—` instead of `0`.
- Multiple buckets per account, one card per bucket.
- Credentials encrypted with the SiYuan **data repo key** before being written to the plugin directory; the ciphertext follows workspace sync, so another device with the same repo key can decrypt it.
- Optional “Use the SiYuan S3 sync configuration” mode: credentials are read live from SiYuan settings and never stored by the plugin.
- Bilingual UI (English / Simplified Chinese), desktop and mobile.

## Requirements

- SiYuan 3.1.20 or later.
- Administrator role: queries go through the kernel’s `/api/network/forwardProxy`, which is not available to publish-service visitors.
- Network access from the SiYuan kernel to the provider endpoints.

## Setup

1. Enable the plugin and click the cloud-chart icon in the top bar, or run the command **View S3 bucket usage**.
2. Click the gear icon in the top right to open **Data sources**, then click **+** to add one.
3. Choose a provider, fill in the endpoint / region / bucket names, and enter the credentials.
   - Multiple buckets: one per line, or comma-separated.
   - For Tencent COS the bucket name normally ends with `-APPID`; the APPID is parsed automatically, or you can fill in **Account ID**.
   - For Cloudflare R2, **Account ID** is required and the API token goes into **Access Key**; the token needs **Account → Account Analytics → Read**.
4. Save. The first query starts immediately.
5. To reuse the S3 configuration already saved in SiYuan, click the download icon (**Import SiYuan S3 sync configuration**) or tick **Use the SiYuan S3 sync configuration** in the editor.

### Credential encryption

Manual credentials are encrypted with AES-256-GCM. The encryption key is derived with HKDF-SHA256 from the SiYuan data repo key (`window.siyuan.config.repo.key`). Only the ciphertext is stored in `data/storage/petal/s3-usage-siyuan/`; the plaintext exists in memory only.

- If no data repo key has been initialized, manual credentials cannot be saved. Initialize or import one in **Settings → Data repo key**, or use the SiYuan S3 sync configuration.
- If the repo key is reset or replaced, old ciphertext cannot be decrypted. Re-enter the credentials; the plugin will not silently fall back to plaintext.
- On an insecure origin (for example `http://192.168.x.x:6806`), WebCrypto is unavailable, so manual credentials cannot be saved or decrypted there. Use the desktop client or `http://127.0.0.1:6806`.

## What it does not do

- **No billing or cost data.** Only usage endpoints are queried. The provider’s billing statement remains authoritative.
- **No real-time guarantee.** Every provider’s usage data is delayed or snapshot-based:
  - OSS / TOS: delay may exceed one hour.
  - COS: about two hours.
  - OBS: background statistics, may be delayed.
  - Qiniu: about five minutes.
  - MinIO: the last completed scanner snapshot.
  - R2: Analytics covers at most 31 days; request/traffic values are the last 24 hours.
  - AWS S3: CloudWatch publishes bucket size once per day.
- **No bucket auto-discovery.** Enter bucket names manually; this avoids requiring `ListAllMyBuckets` on every key.
- Traffic/request metrics are only available where the provider exposes them; see the table above.

## Build

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify:package
```

`npm run build` writes `dist/` and `package.zip`. The zip contains `plugin.json`, `index.js`, `index.css`, `icon.png`, `preview.png`, both READMEs, `LICENSE` and `i18n/`.

To regenerate images after editing `assets/icon.svg` or `assets/preview.html`:

```bash
npm run render:icon
npm run render:preview   # needs: npx playwright install chromium
```

## License

[MIT](LICENSE)
