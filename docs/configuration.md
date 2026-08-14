# Configuration Reference

## Channel environment

每个 `routes.local.json` 渠道 ID 对应以下私有变量：

```text
CHANNEL_<ID>_NAME
CHANNEL_<ID>_BASE_URL
CHANNEL_<ID>_API_KEY
CHANNEL_<ID>_PROTOCOL
CHANNEL_<ID>_ENABLED
```

`<ID>` 使用大写并把 `-` 替换为 `_`。`BASE_URL` 可以包含 `/v1` 等固定路径，但不能包含查询参数、片段或 URL 内嵌凭据。

生成器会把该固定路径放入 CPA 的 localhost `base-url`，HAProxy 原样转发路径。由于 CPA 的 Claude executor 自身追加 `/v1/messages`，Claude 渠道末尾的一个 `/v1` 会被移除后再交给 CPA；Responses 和 Chat Completions 则保留完整路径。这样三种协议都只得到一个 `/v1`。

渠道协议是模型未显式声明时的默认值。支持：

- `openai-compatible`：Chat Completions 上游。
- `responses`：OpenAI Responses/Codex 兼容上游。
- `claude`：Anthropic Messages 兼容上游。

## Cloudflare Tunnel environment

Tunnel 默认关闭。使用 dashboard 管理的 Cloudflare Tunnel 时，只在 `channels.local.env` 中配置：

```text
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_TUNNEL_TOKEN=<private-token>
```

启用时 Token 必填且至少 32 个字符；关闭时可以留空。校验摘要、生成 release、日志和 Git 均不得输出 Token。Tunnel 的 hostname 与 `http://127.0.0.1:<SERVER_PORT>` route 由 Cloudflare Dashboard 管理，不写入渠道路由文件。

## Routes

模型级 `protocol` 可以覆盖渠道默认值。同一物理渠道的所有协议仍使用同一个 HAProxy listener，因此共享一个并发槽。

启用渠道的完整模型目录通过以下命令显式同步：

```bash
npm run sync:models
```

公开模型 ID 使用 `<channel-id>/<upstream-model-id>`。后半段保留上游原始大小写以及 `/`、`:`、`@` 等常见模型字符，因此 `free/Provider/Model-A:free` 是合法 ID。这个命名空间是确定具体物理渠道所必需的，不是可漂移别名；`coding-main` 等 `stableAliases` 才是面向客户端的可切换逻辑别名。

同步是显式运维动作，不在每次启动时自动执行，也不作为渠道测活。它只访问 `/models`，成功后备份并更新私有 routes；生成服务启动时仍只读取本地已验证配置，不依赖远程目录。上游目录不能证明模型支持哪种 API 或能力，新模型默认继承渠道协议，必要时必须在 routes 中覆盖并完成对应 canary。

每个模型至少包含：

```json
{
  "upstream": "example-coding-model",
  "protocol": "responses",
  "aliases": ["sample/example-coding-model"]
}
```

可选字段：

- `displayName`
- `maxContextLength`
- `inputModalities`
- `outputModalities`
- `thinkingLevels`

不要凭模型名称或 `/models` 返回结果推断能力。只有实际完成对应任务型验收后，才声明图片、工具、结构化输出、长上下文或 thinking 能力。

## Stable and pinned aliases

`stableAliases` 面向一般客户端切换，修改后客户端无需更换模型名。

`pinnedAliases` 面向 AI Daily 等受审批工作流，必须包含非空 `approvalRef`。网关不会替审批系统判断某个配置是否已获批准；它只防止 pinned alias 在配置中变成无来源的浮动路由。

## Queue invariant

`gateway.json` 强制：

```json
{
  "maxConnectionsPerChannel": 1,
  "maxQueuedPerChannel": 8,
  "timeoutSeconds": 120
}
```

校验器拒绝把 `maxConnectionsPerChannel` 改成其他值。HAProxy 为每个物理渠道生成一个 backend，并设置 `http-reuse never`、`alpn http/1.1`、`maxconn 1`、`maxqueue 8` 和 `retries 0`。
