# 翼龙面板部署指南

本文面向单租户、2 核 3 GB 的翼龙面板容器。仓库只暴露 Node 控制网关端口，CPA 和 HAProxy 的渠道 listener 均绑定到 `127.0.0.1`，因此只需要一个公网 allocation。

## 1. 创建或重装服务器

在面板的重装/启动参数中填写：

| 字段 | 值 |
| --- | --- |
| Server Image | `Nodejs 22` |
| Git Repo Address | `https://github.com/Drew-Z/cpa-channel-gateway.git` |
| Install Branch | `main` |
| User Uploaded Files | 关闭 |
| Auto Update | `1` |
| Git Username | 留空 |
| Git Access Token | 留空 |
| Additional Node Packages | 留空 |
| Uninstall Node Packages | 留空 |
| Main File | `index.js` |
| Additional Arguments | 留空 |

仓库公开后不需要 GitHub 凭据。不要把渠道 API key 填入 Git Username、Git Access Token、Additional Arguments 或可公开的面板描述。

管理台使用仓库内随版本发布的 Vite 构建产物 `admin/dist/`。它由 `index.js` 启动的同一个 Node 进程在 `/admin` 和 `/admin/assets/*` 提供，不需要额外端口、服务或数据库。发布新版本时不要只上传 `admin/src/`；`admin/dist/` 也必须随 Git 提交一起更新。常规本地验证命令为：

```bash
npm ci
npm run build:admin
npm test
```

翼龙面板的主文件仍保持 `index.js`，不会单独启动 Vite 开发服务器。`AUTO_UPDATE=1` 拉取新提交并重启后，静态管理台和 Node API 会同时更新。

已验证镜像是翼龙的 `Nodejs 22`（Debian 13、非 root 用户）。面板可以切换镜像，但当前运行时安装器还要求 Linux `x64`/`arm64`、Node.js 22 以上、Debian APT 源以及 `apt-get`、`dpkg-deb`、`tar`、`make` 和 C 编译工具链；不满足这些条件的镜像不能视为兼容。

## 2. 设置端口

只保留主 allocation 给网关使用，并确认面板把该端口注入 `SERVER_PORT`。第二个 allocation 不需要配置给本项目，也不要暴露 `19001` 及后续端口；这些端口只用于容器内的 HAProxy listener。

仓库中的本地默认端口只是开发回退值，翼龙部署以面板分配的 `SERVER_PORT` 为准。

## 3. 等待安装

首次启动会下载并校验 CPA 与 cloudflared 发布包，然后下载 HAProxy 源码并在 2 核容器内编译。已验证环境通常需要约 4 至 6 分钟；以后按组件复用 `bin/` 缓存，只新增 cloudflared 时不会重新编译版本未变的 HAProxy。

如果服务器安装后自动启动，而私有配置尚未上传，运行时安装完成后出现以下错误是预期行为：

```text
Missing private configuration: config/routes.local.json
```

这不表示公开仓库安装失败。等待首次运行时安装结束后停止服务器，再上传下一节的两个文件。

## 4. 手工上传私有配置

通过面板文件管理器或 SFTP，把你本地准备好的私有配置上传到以下绝对路径：

```text
/home/container/config/channels.local.env
/home/container/config/routes.local.json
```

如果已经完成 providers 迁移，再额外上传：

```text
/home/container/config/providers.local.json
```

只上传这两个（旧格式）或三个（providers 格式）私有配置，不要替换仓库中的 `config/gateway.json`。上传前确认文件名没有被浏览器或系统追加 `.txt`，并确认 `channels.local.env` 中的 `GATEWAY_API_KEY` 至少 32 个字符。使用 Cloudflare Tunnel 时，Token 也只写在这个本地 env 文件中；完整步骤见 [Cloudflare Tunnel 部署](cloudflare-tunnel.md)。

这些文件已被 `config/*.local.*` 忽略，不会被 Git 更新跟踪。仍应只在可信设备和面板连接中传输，并避免在控制台、工单或截图中展示其内容。

## 5. 启动并验收

上传完成后启动服务器。成功时控制台会输出一个不含密钥的 ready 记录：

```json
{"ready":true,"port":12345,"release":"...","cloudflareTunnel":false}
```

其中端口应等于面板的主 allocation。随后在可信客户端中把 Base URL 指向：

```text
http(s)://<服务器地址>:<主 allocation 端口>/v1
```

客户端 API key 使用 `channels.local.env` 中的 `GATEWAY_API_KEY`，模型名使用 `routes.local.json` 中配置的稳定别名，例如 `coding-main`。

如果面板另外提供容器终端，可以先执行不调用上游的检查：

```bash
npm run check
npm run status
```

更新到包含部署验收脚本的版本后，优先执行一次默认只读验收：

```bash
npm run verify:deployment
```

该检查会验证 `/healthz`、runtime supervisor、持久化 control state 以及 loaded/pending
revision；它不会输出管理密钥、gateway key、Cookie、CSRF token、请求体、响应正文或上游原始错误。
管理台 Overview 的 runtime 区域还会显示有界的 apply 次数、最近结果、耗时、排空等待和
异常子进程退出计数；这些指标不包含 URL、命令行、请求内容或错误正文。release 清理只
删除未被 active/previous 指针或有效 revision manifest 引用、且超出保留尾部的目录。
只有明确指定精确模型时才会发送一次固定诗词任务：

```bash
DEPLOYMENT_CANARY_MODEL='channel/model' npm run verify:deployment
```

如需同时确认正式业务路径的流式和非流式语义，指定同一个精确模型：

```bash
DEPLOYMENT_BUSINESS_MODEL='channel/model' npm run verify:deployment
```

此命令只使用容器已有的 `GATEWAY_API_KEY`，输出状态、延迟、正文长度、content type 和响应字节数，
不会打印密钥或正文。发现 pending revision 时默认只报告并退出；只有已经明确批准应用配置时，才设置
`DEPLOYMENT_APPLY=1` 再执行一次。不要在翼龙控制台或工单中粘贴任何密钥。

普通翼龙控制台通常连接的是正在运行的 Node 进程，并不是 shell；不要把上述命令直接发送给应用控制台。没有终端权限时，可以在自己的电脑上检查模型目录，这不会生成模型回答：

```bash
curl -fsS -H 'Authorization: Bearer <gateway-key>' \
  'http(s)://<服务器地址>:<主 allocation 端口>/v1/models'
```

需要确认真实渠道时，再由操作者在自己的电脑、项目仓库目录中明确执行一次任务型 canary。它会产生真实上游请求，不应作为周期性测活：

```bash
GATEWAY_BASE_URL='http(s)://<服务器地址>:<主 allocation 端口>' \
GATEWAY_API_KEY='<gateway-key>' \
CANARY_MODEL='<精确模型别名>' \
npm run canary
```

## 6. 更新和回退

保持 Auto Update 为 `1`。公开代码可由面板自动拉取，但私有配置不会从 Git 更新；更新前仍应备份两个或三个 `config/*.local.*` 文件，并在代码更新后重启容器使新进程加载。固定 CPA/HAProxy/cloudflared 版本改变时只重新安装对应运行时组件。

只替换渠道或模型时，优先在管理台完成渠道发现、模型同步、测活和路由调整；这些操作会保存私有 revision，并保持待测试渠道与生产调度隔离。不要在自动启动流程中周期性同步模型目录。管理台不可用时，才在可信本地副本中执行 `npm run sync:models`，审核并重新上传 `config/routes.local.json`。如果面板提供容器终端，再执行：

```bash
npm run check
npm run activate
```

没有终端权限时，直接重启服务器；启动流程会根据最新私有配置生成并激活 release。新版本管理台的 Changes 区域会保存完整私有 revision，并可在明确确认后同时回滚私有配置和运行时；回滚会自动排空、检查 readiness，失败时恢复原配置和 release。

旧的 `npm run rollback` 只切换 active/previous release，不恢复 `config/*.local.*`。只有在管理台 rollback 不可用且操作者明确理解这一区别时才使用它，并在之后重启。`runtime/config-revisions/` 含完整私有快照，`runtime/audit-events.jsonl` 含低敏作业历史；两者都不得下载到公开工单、日志或仓库。

## 7. 常见故障

- `Missing private configuration`：两个本地配置尚未上传、路径不对或文件名被追加后缀。
- `Configuration validation failed`：渠道 ID、环境变量前缀、模型路由、稳定别名或密钥长度不一致。
- `No Debian APT source list found`：所选 Server Image 不是当前安装器支持的 Debian 系镜像，请切回已验证的 Nodejs 22。
- `Listener ... did not become ready`：检查 HAProxy 编译/配置输出以及内部端口是否被其他进程占用，不要把内部端口添加为公网 allocation。
- `Cloudflare Tunnel is enabled but bin/cloudflared is missing`：重新启动以触发固定运行时安装，并检查 GitHub Release 下载是否被容器网络阻断。
- `HTTP readiness endpoint ... did not return 2xx`：Tunnel Token 无效、cloudflared 尚未建立到 Cloudflare 的活跃连接，或容器无法通过出站网络连接 Cloudflare；先在 Dashboard 检查 Tunnel connector 状态和 cloudflared 日志。Published application route 不是 `/ready` 返回 2xx 的必要条件，但仍需在验收公网域名之前配置。
- CPA 启动后立刻退出：先看控制台中的 HAProxy/CPA 预检错误；不要通过启用自动重试来掩盖配置问题。
