# S3 桶用量

[English](README.md)

在思源里查看 S3 兼容对象存储的桶用量：存储量、对象数、流量、请求数，以及各存储类型的明细。

![预览](https://gcore.jsdelivr.net/gh/wmy2981/s3-usage-siyuan@dev/assets/preview.png)

## 功能

- 一个对话框管理所有账号；用量与数据源管理在同一个窗口里切换，不再叠加第二层弹窗。
- 接入八家服务商的官方桶用量接口：

  | 服务商 | 接口 | 存储量 | 对象数 | 流量 | 请求数 |
  | --- | --- | --- | --- | --- | --- |
  | 阿里云 OSS | `GetBucketStat` + 云监控 `DescribeMetricList` | ✅ | ✅ | ✅（24 小时） | ✅（24 小时） |
  | 腾讯云 COS | 云监控 `GetMonitorData`（`QCE/COS`） | ✅ | ✅ | ✅（24 小时） | ✅（24 小时） |
  | 华为云 OBS | `GetBucketStorageInfo` + 云监控 CES `ShowMetricData` | ✅ | ✅ | ✅（24 小时，需项目 ID） | ✅（24 小时，需项目 ID） |
  | 火山引擎 TOS | `GetBucketStat` + 云监控 `GetMetricData` | ✅ | ✅ | ✅（24 小时，按带宽积分） | ✅（24 小时，按 QPS 积分） |
  | 七牛云 Kodo | `/v6/space`、`/v6/count` + `/v6/blob_io`、`/v6/rs_put` | ✅ | ✅ | ✅（24 小时，仅流出） | ✅（24 小时，GET + PUT） |
  | MinIO / 自建 S3 | Admin API `datausageinfo` + Prometheus 桶指标 | ✅ | ✅ | ✅（自启动累计） | ✅（自启动累计） |
  | Cloudflare R2 | GraphQL Analytics（`r2*AdaptiveGroups`） | ✅ | ✅ | ✅（24 小时） | ✅（24 小时） |
  | AWS S3 | CloudWatch `GetMetricStatistics` | ✅ | ✅ | ✅（24 小时，需启用请求指标） | ✅（24 小时，需启用请求指标） |

- 总览与存储类型明细同时展示；接口不提供的指标显示 `—`，不会用 0 冒充。
- 数据源页可以设置单次查询超时与自动刷新间隔；每张卡片显示更新时间，过期后自动变灰。
- 编辑数据源时可以显式清除已保存的手动凭据，数据源配置本身保留。
- 一个账号可以配置多个桶，每个桶一张卡片。
- 手动填写的凭据用 **思源数据仓库密钥** 派生密钥后以 AES-256-GCM 加密，再写入插件目录；密文随工作空间同步，换设备只要仓库密钥相同就能解开。
- 可选「使用思源 S3 同步配置」：凭据从思源设置实时读取，插件不保存任何密钥。
- 中英双语，桌面端与移动端都能用。

## 要求

- 思源 3.1.20 或更高版本。
- 管理员角色：查询经内核 `/api/network/forwardProxy` 发出，发布服务访客不可用。
- 思源内核能访问各服务商的 Endpoint。

## 使用

1. 启用插件，点击本插件在顶栏的按钮，或执行命令 **查看 S3 桶用量**。
2. 点右上角的齿轮图标进入 **数据源**，再点 **+** 添加数据源。
3. 选择服务商，填写 Endpoint / 地域 / 桶名与凭据。
   - 多个桶：每行一个，或用逗号分隔。
   - 腾讯云 COS 的桶名通常以 `-APPID` 结尾，插件会自动解析 APPID；也可以单独填 **Account ID**。
   - Cloudflare R2 必须填 **Account ID**，API Token 填在 **Access Key**；Token 需要 **Account → Account Analytics → Read** 权限。
   - 华为云 OBS 建议填 **项目 ID**（控制台「我的凭证 → API 凭证 → 项目列表」），否则只显示存储量与对象数；云监控需要 CES 只读权限。
   - 火山引擎 TOS 需要云监控读权限；AWS S3 的流量与请求数要先在桶上启用 CloudWatch 请求指标。
   - 阿里云 OSS 的流量与请求数走云监控，凭据需要 `cms:QueryMetricList`（`AliyunCloudMonitorReadOnlyAccess` 即可）。
   - MinIO 的流量与请求数来自 Prometheus 指标端点，需要 `admin:Prometheus` 权限（或把指标端点设为公开）。
4. 保存后立即开始查询。
5. 想复用思源里已经保存的 S3 配置，点工具栏的下载图标（**导入思源 S3 同步配置**），或在编辑表单里勾选 **使用思源 S3 同步配置**。

### 凭据加密

手动凭据用 AES-256-GCM 加密；加密密钥由思源数据仓库密钥（`window.siyuan.config.repo.key`）经 HKDF-SHA256 派生。插件目录 `data/storage/petal/s3-usage-siyuan/` 里只有密文，明文只在内存中出现。

- 没有初始化数据仓库密钥时无法保存手动凭据：请先在 **设置 → 数据仓库密钥** 中初始化或导入，或改用思源 S3 同步配置。
- 数据仓库密钥被重置/更换后，旧密文解不开。重新填写即可，插件不会静默退回明文。
- 通过 `http://192.168.x.x:6806` 这类非安全上下文打开时没有 WebCrypto，无法保存或解密手动凭据；请用桌面端或 `http://127.0.0.1:6806`。

## 不做什么

- **不接账单/费用接口。** 只查用量；计费口径以各服务商账单为准。
- **不承诺实时。** 各家用量都有延迟或来自快照：
  - OSS / TOS：延时可能超过 1 小时。
  - COS：约 2 小时。
  - OBS：后台统计，可能有延时。
  - 七牛：约 5 分钟。
  - MinIO：最近一次扫描完成的快照。
  - R2：Analytics 最多覆盖 31 天；请求/流量为最近 24 小时合计。
  - AWS S3：CloudWatch 每天发布一次桶大小。
- **不自动列举桶。** 桶名手动填写，避免要求每把密钥都有 `ListAllMyBuckets` 权限。
- **流量/请求数是监控口径，不是账单口径。** 除 MinIO 外统一取最近 24 小时：
  - OSS / COS / AWS：对监控数据点求和。
  - TOS：带宽与 QPS 都是速率，按周期积分成总量，与控制台可能有差异。
  - OBS：流量本身是周期内总量，请求数由每秒速率积分。
  - 七牛：请求数为 GET + PUT 次数之和；没有公网流入流量指标。
  - MinIO：指标是自服务启动以来的累计值，不是 24 小时窗口。
  - 监控接口调用失败（例如缺权限）时，卡片保留存储量与对象数，并在说明里给出原因。

## 构建

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run verify:package
```

`npm run build` 生成 `dist/` 与 `package.zip`。包内包含 `plugin.json`、`index.js`、`index.css`、`icon.png`、`preview.png`、两份 README、`LICENSE` 与 `i18n/`。

修改 `assets/icon.svg` 或 `assets/preview.html` 后重新生成图片：

```bash
npm run render:icon
npm run render:preview   # 需要先执行 npx playwright install chromium
```

## 许可证

[MIT](LICENSE)
