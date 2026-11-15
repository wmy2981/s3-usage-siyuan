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
  sign/                 AWS V4、TC3、OSS V1/V4、通用 HMAC 工具
  providers/            八家服务商适配器与注册表
  ui/                   对话框、数据源表单、DOM 工具
  i18n/                 en.json / zh-CN.json
tests/                  纯函数测试，不依赖思源实例
```

## 关键约束

- 入口必须是 CommonJS；`siyuan` 在 Vite 中保持 external。
- 不使用 `fs`、`require("electron")` 等 Node API；持久化只用 `Plugin.loadData/saveData`。
- 手动凭据不得明文落盘。加密不可用时保存直接失败；旧密文解不开时保留密文并提示重填，不回退明文。
- `saveData` 后必须 `loadData` 读回校验（`settings-store.ts`）。
- 所有 UI 颜色/边框/字体使用 `--b3-*` 变量；对话框容器与滚动正文常驻 `will-change: transform`，打开时禁止程序性聚焦输入框。
- 预览图必须用思源本体 CSS 渲染：`assets/preview.html` 只放与 `ui/*.ts` 一致的 DOM，样式由 `scripts/render-preview.mjs` 从本机安装的思源注入（`SIYUAN_RESOURCES` 可覆盖路径），不要手写近似样式。
- `plugin.json` 的 `name`、仓库名、安装目录名保持一致；`dev` 分支不发布，CD 只由 `main` 触发。

## 服务商实现备注

- 阿里云 OSS：默认 OSS4-HMAC-SHA256（2025-09-01 后新建桶不再支持 V1）；403 时回退 V1。V4 的 CanonicalRequest 有 6 段，Canonical URI 带桶名，空值子资源写 `stat`（不补 `=`）。
- 腾讯云 COS：云监控 Region 固定 `ap-guangzhou`；存储类单位 MB，换算成字节；`x-tc-action` 参与签名时值转小写。
- 华为云 OBS：原生 V2 签名（HMAC-SHA1，Authorization 标签 `OBS`）；转发层会写 Content-Type，因此按 `application/json` 参与签名。
- 火山引擎 TOS：TOS4-HMAC-SHA256；密钥派生起点是裸 SK；`?stat` 的 CanonicalQueryString 是 `stat=`。
- 七牛云：HMAC-SHA1 管理签名，签名串包含方法、原始 query、Host、Content-Type、`X-Qiniu-Date` 和末尾两个换行；URL-safe base64 保留 `=`。
- MinIO：Admin API `datausageinfo`，字段以 `bucketsUsageInfo` 为准，兼容旧 `bucketsSizes`；返回的是最近一次扫描快照。
- Cloudflare R2：GraphQL `r2StorageAdaptiveGroups` / `r2OperationsAdaptiveGroups` / `r2BandwidthUsageAdaptiveGroups`；带宽字段是 `bytesUpload` / `bytesDownload`，请求与流量取最近 24 小时合计。
- AWS S3：CloudWatch `BucketSizeBytes` 按 StorageType 逐类查询后求和；`NumberOfObjects` 用 `AllStorageTypes`；每日粒度。

## 本地端到端验证（临时实例）

默认只做静态验证。需要真实运行时，必须使用独立的临时工作空间与临时用户目录，显式指定空闲端口和授权码；不得连接维护者已有实例：

```bash
siyuan serve --workspace "<临时工作空间>" --home-dir "<临时用户目录>" --port 16806 --accessAuthCode "<随机授权码>"
```

把 `package.zip` 解压到 `<临时工作空间>/data/plugins/s3-usage-siyuan/`，通过 `/api/petal/setPetalEnabled` 启用，再用独立浏览器 profile 访问 `http://127.0.0.1:16806`。验证结束后只终止本次启动的进程，并清理自己创建的临时目录。

## 已知限制

- 只查询用量，不接账单/费用接口。
- 不自动列举桶；桶名手动填写。
- 服务商数据均有延迟，不能当计费口径。
- MinIO 需要 admin 级凭据（`admin:DataUsageInfo`）。
- Cloudflare R2 的 Analytics 不是计费口径，且不统计小于 100 KiB 的传输。
