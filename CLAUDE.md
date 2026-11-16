# 项目实现说明

## 定位

`s3-usage-siyuan` 是一个思源前端插件：在对话框里查看 S3 兼容对象存储的桶用量。没有内核插件（`kernel.js`），所有网络请求经内核 `/api/network/forwardProxy` 发出。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run typecheck` | 只做 TypeScript 类型检查 |
| `npm test` | Vitest 单元测试（纯函数、签名、解析、加密） |
| `npm run build` | Vite 生产构建 + `scripts/build-package.mjs` 生成 `dist/` 与 `package.zip` |
| `npm run verify:package` | 校验 zip 必需文件、扁平布局与图片体积 |
| `npm run render:icon` | `assets/icon.svg` → `assets/icon.png` |
| `npm run render:preview` | `assets/preview.html` + 本机思源的 CSS → `assets/preview.png`（需要 Chromium 与本机安装的思源） |

`npm run dev` 是 watch 构建，只用于本地开发；验证时不要启动。

## 结构

```text
src/
  index.ts              插件入口：顶栏、命令、对话框生命周期
  config.ts             数据源模型、归一化、思源同步配置读取
  secret.ts             数据仓库密钥 → HKDF → AES-GCM 信封
  settings-store.ts     配置读写、逐条解封、写后读回校验
  net.ts                forwardProxy 传输与错误归类
  query.ts              数据源 → 适配器的查询编排
  format.ts             字节/数量/时间格式化
  sign/                 AWS V4、TC3、OSS V1/V4、阿里云 RPC、华为 SDK-HMAC-SHA256、MinIO JWT、通用 HMAC 工具
  providers/            八家服务商适配器与注册表
  ui/                   对话框、数据源表单、DOM 工具
  i18n/                 en.json / zh-CN.json
tests/                  纯函数测试，不依赖思源实例
```

## 关键约束

- 入口必须是 CommonJS；`siyuan` 在 Vite 中保持 external。
- 不使用 `fs`、`require("electron")` 等 Node API；持久化只用 `Plugin.loadData/saveData`。
- 手动凭据不得明文落盘。加密不可用时保存直接失败；旧密文解不开时保留密文并提示重填，不回退明文。
- 「从思源导入」是独立的一条数据源，全局最多一条：落盘只有 `siyuan.name`，服务商/桶名/地域/凭据每次渲染与查询都从 `window.siyuan.config.sync.s3` 现读；导入入口只在数据源页右上角，导入后只能改名或移除。
- `saveData` 后必须 `loadData` 读回校验（`settings-store.ts`）。
- 所有 UI 颜色/边框/字体使用 `--b3-*` 变量；错误文案统一取 `.s3u` 上的 `--s3u-error`（等于 `var(--b3-theme-error)`）。对话框容器与滚动正文常驻 `will-change: transform`，打开时禁止程序性聚焦输入框。
- `fieldRow` 的行容器必须是 `div`，只有标签文字用 `<label for>` 关联控件：整行 `<label>` 会让点空白也聚焦输入框、弹出键盘或展开下拉。
- 连接检查（设置页一键测试与表单内测试）都走 `testOneSource`：检查该源的全部桶，超时取 `testTimeoutSeconds`（默认 5 秒），与查询超时分开。
- 预览图必须用思源本体 CSS 渲染：`assets/preview.html` 只放与 `ui/*.ts` 一致的 DOM，样式由 `scripts/render-preview.mjs` 从本机安装的思源注入（`SIYUAN_RESOURCES` 可覆盖路径），不要手写近似样式。
- `plugin.json` 的 `name`、仓库名、安装目录名保持一致；`dev` 分支不发布，CD 只由 `main` 触发。

## 服务商实现备注

- 阿里云 OSS：默认 OSS4-HMAC-SHA256（2025-09-01 后新建桶不再支持 V1）；403 时回退 V1。V4 的 CanonicalRequest 有 6 段，Canonical URI 带桶名，空值子资源写 `stat`（不补 `=`）。流量/请求数走云监控 `DescribeMetricList`（RPC 签名，`acs_oss_dashboard`，Period=60，24 小时求和）。
- 腾讯云 COS：云监控 Region 固定 `ap-guangzhou`；存储类单位 MB，换算成字节；`x-tc-action` 参与签名时值转小写。流量/请求数取最近 24 小时求和，存储量仍取最新点。
- 华为云 OBS：原生 V2 签名（HMAC-SHA1，Authorization 标签 `OBS`）；转发层会写 Content-Type，因此按 `application/json` 参与签名。流量/请求数走 CES `ShowMetricData`（SDK-HMAC-SHA256，CanonicalURI 签名时必须补结尾 `/`），URL 需要项目 ID（填在 Account ID）；请求数由 `request_count_per_second` 乘周期积分。
- 火山引擎 TOS：TOS4-HMAC-SHA256；密钥派生起点是裸 SK；`?stat` 的 CanonicalQueryString 是 `stat=`。流量/请求数走云监控 `GetMetricData`（service 为 `cloudmonitor`，维度 `ResourceID` 即桶名），带宽与 QPS 为速率，按 1h 周期积分。
- 七牛云：HMAC-SHA1 管理签名，签名串包含方法、原始 query、Host、Content-Type、`X-Qiniu-Date` 和末尾两个换行；URL-safe base64 保留 `=`。`blob_io` / `rs_put` 返回 `[{time, values}]` 数组，与 `space`/`count` 的 `times`/`datas` 不同。
- MinIO：Admin API `datausageinfo`，字段以 `bucketsUsageInfo` 为准，兼容旧 `bucketsSizes`；返回的是最近一次扫描快照。流量/请求数来自 Prometheus 桶指标（`/minio/v2/metrics/bucket`，v3 为 `/minio/metrics/v3/bucket/api/<bucket>`），认证是 HS512 JWT（claims `exp/sub/iss=prometheus`，密钥为 Secret Key），数值是自进程启动以来的累计值。
- Cloudflare R2：GraphQL `r2StorageAdaptiveGroups` / `r2OperationsAdaptiveGroups` / `r2BandwidthUsageAdaptiveGroups`；带宽字段是 `bytesUpload` / `bytesDownload`，请求与流量取最近 24 小时合计。
- AWS S3：CloudWatch `BucketSizeBytes` 按 StorageType 逐类查询后求和；`NumberOfObjects` 用 `AllStorageTypes`；每日粒度。请求指标（`AllRequests` / `BytesUploaded` / `BytesDownloaded`）必须先 `ListMetrics` 拿到 `FilterId`，维度是 `BucketName + FilterId`，用 `Sum` 统计最近 24 小时；未启用时返回空数据点。

## 本地端到端验证（临时实例）

必须用户显式要求才进行此环节。默认只做静态验证。需要真实运行时，必须使用独立的临时工作空间与临时用户目录，显式指定空闲端口和授权码；不得连接维护者已有实例：

```bash
siyuan serve --workspace "<临时工作空间>" --home-dir "<临时用户目录>" --port 16806 --accessAuthCode "<随机授权码>"
```

把 `package.zip` 解压到 `<临时工作空间>/data/plugins/s3-usage-siyuan/`，通过 `/api/petal/setPetalEnabled` 启用，再用独立浏览器 profile 访问 `http://127.0.0.1:16806`。验证结束后只终止本次启动的进程，并清理自己创建的临时目录。

## 已知限制

- 只查询用量，不接账单/费用接口。
- 不自动列举桶；桶名手动填写。
- 服务商数据均有延迟，不能当计费口径。
- 流量/请求数除 MinIO 外统一取最近 24 小时；监控接口失败时保留存储量与对象数，原因写进 `errors`（界面标红），「数据延迟」这类说明留在 `notes`（灰色）。
- MinIO 需要 admin 级凭据（`admin:DataUsageInfo` 与 `admin:Prometheus`），且指标是自启动累计值。
- 华为云 OBS 需要项目 ID（填在 Account ID）才会查询流量/请求数；AWS S3 需要先为桶启用 CloudWatch 请求指标。
- Cloudflare R2 的 Analytics 不是计费口径，且不统计小于 100 KiB 的传输。
