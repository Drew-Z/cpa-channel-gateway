# CPA Channel Gateway

面向个人单租户的多渠道模型网关。它在一个固定 Node.js 容器中运行
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 与
[HAProxy](https://www.haproxy.org/)。公网只暴露 Node 控制网关；CPA 与所有
HAProxy listener 均绑定到容器回环地址。

## 解决的问题

- 聚合多个 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 兼容渠道，并把相同原始模型 ID 自动聚合成一个逻辑模型。
- 通过 `coding-main` 等稳定别名切换渠道/模型，客户端配置保持不变。
- 每个物理渠道共享一个 HAProxy backend，`maxconn 1`，所以该渠道的全部模型和协议合计最多只有一个在途请求。
- Node 为每个物理渠道持有一个互斥租约。渠道繁忙时会从所有模型的新请求候选中临时隐藏；没有其他空闲候选时立即返回 `429 all_candidates_busy`，不向上游排队或重复调用。
- HAProxy 仍以 `maxconn 1` 作为最终硬约束；CPA 和网关都不会自动重放已经发往上游的生成请求。
- 私有渠道 URL、密钥、激活配置、日志和二进制不会进入 Git。
- 配置生成按内容寻址，支持原子激活和一次回滚。
- canary 使用真实小任务，不使用 `hi`、`你好` 等无意义提示词。
- 开启 `CPA_MANAGEMENT_KEY` 后，可在同一公网端口的 `/admin` 使用管理台查看渠道状态、逻辑模型候选和执行精确渠道模型测活。

## 运行拓扑

```text
Codex / Claude Code / AI Daily
              |
Cloudflare Tunnel or direct allocation
              |
      Node control gateway
       /v1/*     /healthz
          |          |
 native Responses   CPA adapted transport
          |          |
       HAProxy 127.0.0.1:19001..190NN
       one active request per physical channel
              |
        upstream channels
```

翼龙面板只需要一个公网 allocation。内部 listener 绑定 `127.0.0.1`，不占面板的端口配额，也无法从公网直接访问。

## 首次配置

1. 复制私有配置模板：

   ```bash
   cp config/channels.example.env config/channels.local.env
   cp config/routes.example.json config/routes.local.json
   ```

2. 在 `channels.local.env` 填写每个渠道的 URL、密钥、默认协议和启用状态。
   使用自有 HTTPS 域名时，再填写私密的 Cloudflare Tunnel Token；未配置时保持关闭。
3. 执行 `npm run sync:models`，把启用渠道 `/models` 返回的目录同步到私有 routes。每个模型使用 `<渠道ID>/<原始模型ID>` 作为无冲突的公开 ID。
4. 在 `routes.local.json` 审核模型协议和能力元数据。单个渠道可以按模型分别覆盖为 `openai-compatible`、`responses` 或 `claude`。
5. 配置稳定别名；AI Daily 等受审批约束的用途只能使用带 `approvalRef` 的 `pinnedAliases`。
6. 验证并生成：

   ```bash
   npm run check
   npm test
   npm run generate
   npm run activate
   ```

已有旧格式 env 时可执行：

```bash
npm run import:legacy -- /absolute/path/to/channels.local.env
```

导入器只在本地写入 Git 忽略文件，所有渠道默认禁用，不会枚举模型或调用上游。

## 翼龙面板

完整步骤见 [翼龙面板部署指南](docs/pterodactyl-deployment.md)。自有域名接入见 [Cloudflare Tunnel 部署](docs/cloudflare-tunnel.md)。公开仓库可直接通过 HTTPS 克隆，Git 用户名和 Access Token 均留空。私有渠道配置不通过 Git 分发，必须在安装后由操作者手工上传。

推荐填写：

| 设置 | 值 |
| --- | --- |
| Server Image | Nodejs 22 |
| Git Repo Address | `https://github.com/Drew-Z/cpa-channel-gateway.git` |
| Install Branch | `main` |
| User Uploaded Files | 关闭 |
| Auto Update | 关闭；升级必须审核固定版本后手动执行 |
| Git Username | 留空 |
| Git Access Token | 留空 |
| Additional Node Packages | 留空 |
| Main File | `index.js` |
| Additional Arguments | 留空 |

将面板主 allocation 的端口作为环境变量 `SERVER_PORT`。只需要一个公网 allocation；第二个 allocation 不需要使用。

### 管理台

`CPA_MANAGEMENT_KEY` 留空时 `/admin` 不开放。填写独立的 32 字符以上随机管理密钥并重启后，访问同一域名的 `/admin` 登录。管理台的会话只保存在 Node 内存中，重启后失效；测活必须填写精确的 `<channel>/<upstream-model-id>`，避免逻辑模型候选变化造成误判。测活使用固定诗词任务、同一渠道互斥租约和相同协议路径，只保存状态摘要、transport、延迟与正文长度，不保存诗词正文。

首次启动会：

1. 按容器架构下载固定 CPA 和 cloudflared 发布包并核对仓库内 SHA-256。
2. 下载固定 HAProxy 源码与无 root 的构建依赖，核对 SHA-256 后编译并缓存。
3. 校验私有配置，生成内容寻址 release。
4. 执行 `haproxy -c` 与 CPA 二进制预检；启用 Tunnel 时再预检 cloudflared。
5. 先启动 HAProxy 与内网 CPA，再由 Node 监听公网 allocation；启用 Tunnel 时最后启动 cloudflared 并等待本地 readiness。任一必需进程退出时终止整个服务，让面板明确重启。

二进制缓存在 `bin/`。修改 `config/gateway.json` 中的固定版本和校验和后，下一次启动会自动重新安装。

## 模型目录同步

渠道模型发生变化时，显式执行：

```bash
npm run sync:models
npm run check
```

同步器按渠道顺序请求只读 `/models`，不发送生成提示词。任何启用渠道请求失败或返回空目录时都不会改写 routes；成功时会先创建 `config/routes.local.pre-model-sync-*.json` 备份，再原子更新 `routes.local.json`。已有的协议、上下文、模态、thinking 和额外 alias 会保留；新模型得到 `<渠道ID>/<原始模型ID>`，未被引用的下线模型会删除。仍被 stable/pinned alias 引用的下线模型会暂时保留，待别名切走后在下次同步清理。

上游 `/models` 可能同时列出生成、embedding、reranker 或语音模型。目录同步只证明“上游声明存在”，不证明它支持当前渠道默认协议；正式使用前仍要按能力执行任务型 canary。

## 模型替换

只修改 `config/routes.local.json`：

```json
{
  "alias": "coding-main",
  "channel": "sample",
  "model": "example-coding-model"
}
```

然后执行：

```bash
npm run check
npm run activate
```

重启容器使 CPA 使用新 release。需要回退时：

```bash
npm run rollback
```

回滚后同样重启容器。运行时 release 含密钥，只能保存在容器持久化目录中。

## 任务型验收

先用精确模型别名验收，再切换稳定别名：

```bash
GATEWAY_API_KEY='...' \
CANARY_MODEL='sample/example-coding-model' \
CANARY_PROTOCOL='responses' \
npm run canary
```

从容器外验收时再提供 `GATEWAY_BASE_URL='https://<网关地址>'`；脚本仍只记录低敏摘要，不输出响应正文。

默认任务是生成一首四句七言绝句。`CANARY_PROTOCOL` 接受 `responses`、`openai-compatible`（或等价的 `chat`）和 `claude`。脚本只记录 HTTP 状态、模型名和正文长度，不输出正文、密钥、上游地址或完整错误。canary 也是正式请求，必须取得与生产请求相同的渠道租约，并由操作者明确执行；项目不创建周期性模型探测。

## 运维策略

- `401/403`：立即禁用渠道并检查凭据，不重试同渠道。
- `402`：标记余额不足并禁用，不切换同渠道模型。
- `429`：遵循 `Retry-After`，进入冷却；不要主动高频探测。
- `400/404/405/422`：优先检查协议和路径，不偷偷换模型。
- timeout/5xx：第一阶段不自动重试。确认幂等和错误分类后，才评估最多一次跨渠道回退。
- 同渠道存在真实流量时不执行 canary。
- AI Daily 只能使用获批的 pinned alias，不允许跟随 `coding-main` 动态漂移。

## 安全

- 网关是单租户服务，必须使用长度至少 32 的随机 `GATEWAY_API_KEY`。
- Cloudflare Tunnel 默认关闭；Token 只存在于 `channels.local.env`，并通过子进程环境传递。cloudflared 固定版本、校验 SHA-256 且禁用自动更新。
- CPA Management API 默认关闭；确需开启时仍只允许 localhost。
- 不提交 `config/*.local.*`、`runtime/`、`auth/`、`logs/` 或 `bin/`。
- 公开或发布前运行 `npm run audit:public`；该检查会扫描当前跟踪文件、完整可达 Git 历史以及本地私密值是否意外进入仓库，但不会输出私密值。
- 默认关闭 CPA 的 Claude/Codex cloaking、身份混淆和系统提示词替换；真实客户端信息可以由客户端正常发送。
- 启动时使用 CPA 的 `-local-model`，模型目录来自已审核的本地 routes 配置，不依赖远程模型目录服务。
- HAProxy 验证上游 TLS 证书并固定 HTTP/1.1，避免单连接多路复用绕过单并发约束。
- Responses 客户端与 Responses 渠道同协议时，Node 直接保留实际请求语义和经过审查的非敏感端到端请求头；模型、认证、目标地址及传输相关字段由网关替换。其他协议组合标记为 CPA `adapted` 路径。
- 上游基路径由 CPA 的协议专用本地 URL 保留；Claude 会归一化末尾 `/v1`，避免生成 `/v1/v1/messages`。
- 仓库不包含真实渠道名称以外的 URL、密钥、原始错误和响应正文。

## 验证

```bash
npm test
npm run check
npm run audit:public
node --check index.js
```

Linux 部署前还应执行：

```bash
npm run install:runtime
./bin/haproxy -c -f runtime/releases/<digest>/haproxy/haproxy.cfg
```

`install:runtime` 只下载/构建运行时，不请求任何模型。
