# CPA Channel Gateway

面向个人单租户的多渠道模型网关。它在一个固定 Node.js 容器中运行
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 与
[HAProxy](https://www.haproxy.org/)，只向公网暴露 CPA 聚合端口。

## 解决的问题

- 聚合多个 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 兼容渠道。
- 通过 `coding-main` 等稳定别名切换渠道/模型，客户端配置保持不变。
- 每个物理渠道共享一个 HAProxy backend，`maxconn 1`，所以该渠道的全部模型和协议合计最多只有一个在途请求。
- 每渠道最多排队 8 个请求，等待上限 120 秒；HAProxy 和 CPA 默认不自动重放生成请求。
- 私有渠道 URL、密钥、激活配置、日志和二进制不会进入 Git。
- 配置生成按内容寻址，支持原子激活和一次回滚。
- canary 使用真实小任务，不使用 `hi`、`你好` 等无意义提示词。

## 运行拓扑

```text
Codex / Claude Code / AI Daily
              |
        public allocation
              |
         CLIProxyAPI
              |
  127.0.0.1:19001..190NN
              |
           HAProxy
   one queue per physical channel
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
3. 在 `routes.local.json` 声明已经验收的模型。单个渠道可以按模型分别声明 `openai-compatible`、`responses` 或 `claude`。
4. 配置稳定别名；AI Daily 等受审批约束的用途只能使用带 `approvalRef` 的 `pinnedAliases`。
5. 验证并生成：

   ```bash
   npm run check
   npm test
   npm run generate
   npm run activate
   ```

已有旧格式 env 时可执行：

```bash
npm run import:legacy -- /absolute/path/to/grok-4.5-channel.local.env
```

导入器只在本地写入 Git 忽略文件，所有渠道默认禁用，不会枚举模型或调用上游。

## 翼龙面板

推荐填写：

| 设置 | 值 |
| --- | --- |
| Server Image | Nodejs 22 |
| Git Repo Address | 本仓库 SSH/HTTPS 地址 |
| Install Branch | `main` |
| User Uploaded Files | 关闭 |
| Auto Update | 关闭；升级必须审核固定版本后手动执行 |
| Additional Node Packages | 留空 |
| Main File | `index.js` |
| Additional Arguments | 留空 |

将面板主 allocation 的端口作为环境变量 `SERVER_PORT`；当前截图中主端口为 `24674`。第二个 allocation 不需要使用。

首次启动会：

1. 按容器架构下载固定 CPA 发布包并核对仓库内 SHA-256。
2. 下载固定 HAProxy 源码与无 root 的构建依赖，核对 SHA-256 后编译并缓存。
3. 校验私有配置，生成内容寻址 release。
4. 执行 `haproxy -c` 与 CPA 二进制预检。
5. 先启动 HAProxy 并等待全部内部 listener 就绪，再启动 CPA 并等待公网端口就绪；任一进程退出时终止整个服务，让面板明确重启。

二进制缓存在 `bin/`。修改 `config/gateway.json` 中的固定版本和校验和后，下一次启动会自动重新安装。

## 模型替换

只修改 `config/routes.local.json`：

```json
{
  "alias": "coding-main",
  "channel": "free3",
  "model": "grok-4.6"
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
CANARY_MODEL='free3/grok-4.6' \
npm run canary
```

默认任务是生成一首四句七言绝句。脚本只记录 HTTP 状态、模型名和正文长度，不输出正文、密钥、上游地址或完整错误。canary 也是正式请求，必须遵守渠道授权、进入相同 HAProxy 队列，并由操作者明确执行；项目不创建周期性模型探测。

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
- CPA Management API 默认关闭；确需开启时仍只允许 localhost。
- 不提交 `config/*.local.*`、`runtime/`、`auth/`、`logs/` 或 `bin/`。
- 默认关闭 CPA 的 Claude/Codex cloaking、身份混淆和系统提示词替换；真实客户端信息可以由客户端正常发送。
- HAProxy 验证上游 TLS 证书并固定 HTTP/1.1，避免单连接多路复用绕过单并发约束。
- 上游基路径由 CPA 的协议专用本地 URL 保留；Claude 会归一化末尾 `/v1`，避免生成 `/v1/v1/messages`。
- 仓库不包含真实渠道名称以外的 URL、密钥、原始错误和响应正文。

## 验证

```bash
npm test
npm run check
node --check index.js
```

Linux 部署前还应执行：

```bash
npm run install:runtime
./bin/haproxy -c -f runtime/releases/<digest>/haproxy/haproxy.cfg
```

`install:runtime` 只下载/构建运行时，不请求任何模型。
