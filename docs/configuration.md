# Configuration Reference

## Structured providers

新配置优先把渠道私有字段放在 `config/providers.local.json`；`channels.local.env` 最终只保留
`GATEWAY_API_KEY`、`CPA_MANAGEMENT_KEY` 和 Cloudflare Tunnel 等进程级变量。providers 文件的
最小结构为：

```json
{
  "schemaVersion": 1,
  "providers": [
    {
      "id": "sample",
      "name": "Sample Channel",
      "baseUrl": "https://example.invalid/v1",
      "apiKey": "<private-api-key>",
      "protocol": "responses",
      "enabled": false,
      "priority": 100
    }
  ]
}
```

已有旧格式时，先在可信本地副本执行 `npm run migrate:providers -- --dry-run`，确认摘要后再执行
`npm run migrate:providers -- --apply`。迁移不会调用上游；它会创建私有备份并验证迁移前后的规范化
配置语义一致。`providers.local.json` 存在时，`channels.local.env` 不得再包含 `CHANNEL_*` 渠道字段。

## Legacy channel environment

以下格式仅用于迁移兼容。每个 `routes.local.json` 渠道 ID 对应以下私有变量：

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

## Admin UI

管理台状态同时返回 `loadedRevision`（当前进程已加载）和 `pendingRevision`（磁盘私有配置当前 revision）。两者不同表示配置已写入但必须重启；管理台会继续允许批量路由调整，但会禁用模型测活，避免用旧进程验证新配置。失败登录按来源地址做短时限速，会返回 `429 admin_login_rate_limited` 和 `Retry-After`；会话只保存在内存并主动清理过期条目。

`CPA_MANAGEMENT_KEY` 是独立于 `GATEWAY_API_KEY` 的本地管理密钥，长度至少 32 个字符；为空时 `/admin` 返回 404。启用后，管理员在同一公网端口访问 `/admin`，登录会建立仅存于内存的 HttpOnly/Secure/SameSite 会话。管理 API 的变更请求还需要匹配会话 CSRF token 和同源 `Origin`。

CPA 的 Codex 兼容头由 `gateway.json` 中的 `cpa.disableCodexCloaking` 控制。当前值为 `false`，因此 CPA 的 `codex-api-key` 适配路径会使用 CPA 内置的标准 Codex `User-Agent`/`Originator` 头，适用于只做浅层客户端兼容检查的上游。它不会伪造具体 Codex Desktop 版本，也不能证明请求来自真实客户端；`identity-confuse` 仍关闭。Responses 客户端直连同协议渠道时走网关的 native passthrough，保留该次真实请求的低敏头部。需要改变该策略时只改公开 `gateway.json`，重新生成并重启，不要把浏览器 Cookie、LocalStorage 或会话令牌写入任何 CPA 配置。

当前管理台提供渠道/模型状态、路由管理和任务型测活。已认证的渠道状态会显示经过配置校验的 Base URL（包含 origin 和固定 path），便于区分渠道；该字段不会进入公开模型 API、未登录响应或日志，管理 API 响应使用 `Cache-Control: no-store`。登录后“客户端连接”区域还会根据当前访问域名生成带 `/v1` 的 Base URL，并提供复制按钮；`GATEWAY_API_KEY` 默认仅显示掩码，显式点击“显示”或“复制 API key”时才通过带 CSRF 保护的已认证同源 `POST` 取回，不写入初始 HTML，显示后 30 秒自动恢复掩码。测活请求必须使用精确 `<channel>/<upstream-model-id>`，不接受逻辑模型 ID；它会取得与生产相同的每渠道租约，繁忙时返回 429 且不发出上游请求。结果只保留 `status`、HTTP 状态、协议、`native-passthrough` 或 `adapted` transport、延迟和正文长度。

管理 API 还提供私有配置变更：`POST /admin/api/channels` 新增渠道，`PATCH /admin/api/channels/<id>` 修改渠道，`DELETE /admin/api/channels/<id>` 删除已禁用且无别名引用的渠道，`PATCH /admin/api/models` 修改精确渠道模型状态，`PUT /admin/api/stable-aliases` 新增或移动稳定别名。模型状态请求体为 `{ "channel", "model", "status" }`；稳定别名请求体为 `{ "alias", "channel", "model" }`。禁用仍被 stable/pinned alias 引用的模型会返回 `409 model_has_aliases`。请求必须带会话 CSRF token 和同源 `Origin`；新增渠道的 API key 只写入服务器，不在变更响应中返回。成功响应为 `202`，包含脱敏的 `revision` 与 `restartRequired: true`；当前进程不会静默热切换，需按部署流程重启以应用新 revision。所有变更先备份到 `runtime/config-revisions/`，验证失败自动恢复。

配置写入和模型同步使用单一 FIFO 控制作业队列，`GET /admin/api/status` 的 `controlJobs` 返回当前作业、等待数量和最近低敏结果；队列满时返回 `429 control_queue_full`。停用、待测试或删除当前渠道会先进入排空状态，停止新的生产预约并等待在途租约释放；禁用模型会临时抑制当前进程的该候选。正式启动脚本中的 `POST /admin/api/runtime/apply` 会在排空后替换内部 CPA/HAProxy，执行 readiness，并在失败时恢复旧 release；成功后父 Node 路由和 `loadedRevision` 一起更新。没有运行时监督器的进程仍需重启应用。

`GET /admin/api/usage` 返回最近 24 小时真实业务请求的低敏聚合结果。统计口径如下：

- 完整返回 `2xx` 为成功；上游非 `2xx`、transport 错误、无可用候选和全部候选繁忙为失败；客户端主动断开为取消。
- 成功率为 `success / total`，因此取消也计入总请求数。
- 同时按逻辑模型、客户端请求入口、实际 `<channel>/<upstream-model>` 和渠道聚合；管理台任务型测活不计入。
- 原始低敏事件保存在 `runtime/usage-events.jsonl` 并定期压缩，只保留计算滚动窗口所需的短期记录。文件不包含提示词、响应正文、HTTP 请求头、密钥、用户标识、请求 ID 或错误正文。
- 私有配置路径不可用时使用进程内统计；磁盘写入失败时管理 API 报告 `storage: memory-fallback`，但统计故障不会改变业务请求结果。

完整字段、边界和测试契约见 [24 小时模型使用监控](usage-monitoring.md)。

渠道健康、冷却、candidate `misconfigured` 和最近测活摘要保存在
`runtime/control-state.json`。相同 release 内会恢复认证、余额和协议类阻断状态；
release digest 改变时清空调度阻断，仍存在模型的低敏测活摘要继续保留。文件损坏或
不可写时管理 API 报告 `controlState.storage: memory-fallback`，但不阻断业务请求。
字段白名单、24 小时时效和隐私契约见 [控制状态持久化](control-state.md)。

## Routes

从旧格式渠道文件补充渠道时，优先使用合并导入，避免覆盖现有管理密钥、Tunnel 配置、启用状态和审核过的路由：

```bash
npm run merge:legacy -- /absolute/path/to/legacy-channel.env
```

合并会保留现有渠道的模型目录和别名；新渠道以禁用、空模型目录加入，需先显式同步目录、完成任务型测活，再启用渠道。导入过程会在 `runtime/config-revisions/` 创建私有备份，失败会恢复原文件。

默认同步所有已启用渠道；要在不启用新渠道的情况下只同步指定目录，可把渠道 ID 作为位置参数：

```bash
npm run sync:models -- free3 free7-glm-5-2
```

模型级 `protocol` 可以覆盖渠道默认值。同一物理渠道的所有协议仍使用同一个 HAProxy listener，因此共享一个并发槽。

启用渠道的完整模型目录通过以下命令显式同步：

```bash
npm run sync:models
```

每个启用渠道的原始模型会同时形成两类公开 ID：

- `<upstream-model-id>`：逻辑模型。多个渠道提供完全相同的原始 ID 时自动聚合，调度器从健康且空闲的候选中选择。
- `<channel-id>/<upstream-model-id>`：精确模型。它固定到一个物理渠道，但仍必须取得该渠道的互斥租约。

原始 ID 保留上游大小写以及 `/`、`:`、`@` 等常见模型字符，因此 `free/Provider/Model-A:free` 是合法精确 ID。`coding-main` 等现有 `stableAliases` 继续兼容；当前配置格式中的 stable/pinned alias 仍固定到审核过的渠道与模型。

同步是显式运维动作，不在每次启动时自动执行，也不作为渠道测活。它只访问 `/models`，成功后备份并更新私有 routes；生成服务启动时仍只读取本地已验证配置，不依赖远程目录。上游目录不能证明模型支持哪种 API 或能力，新模型默认继承渠道协议，必要时必须在 routes 中覆盖并完成对应 canary。

每个模型至少包含：

```json
{
  "upstream": "example-coding-model",
  "protocol": "responses",
  "aliases": ["sample/example-coding-model"]
}
```

模型能力元数据用于路由和管理台审核。`kind` 支持 `generation`、`embedding`、`rerank`、`audio`、`image`、`video`、`ocr`、`moderation`；缺省时按模型 ID 做保守推断，无法判断时按 `generation` 处理。只有 `generation` 模型会进入公开 `/v1/models`、生产调度和 stable/pinned alias；其他类型仍保留在管理台模型目录中供审计，但不会执行固定诗词测活。

`streaming` 控制该模型接受的请求模式：`both`（默认）、`stream-only` 或 `non-stream-only`。客户端请求的 `stream: true` 会要求 `stream` 候选，省略或设置为 `false` 会要求 `non-stream` 候选；调度器会筛选支持该模式的健康渠道。如果渠道可用但没有任何候选支持请求模式，网关返回 `422 streaming_not_supported`，不会把流式请求静默改成非流式，也不会自动重放已发送的生成请求。网关会透传上游分块响应，流式客户端无需额外端口或单独别名。

`canaryEligible` 默认对生成模型为 `true`，对明显的非生成模型为 `false`。它只控制管理台/脚本的任务型测活资格，不改变生成模型的公开路由；需要暂时跳过固定任务验收时可以显式设为 `false`。稳定别名仍只能指向 `generation` 模型。

模型可设置 `status`：`active`（默认）、`stale` 或 `disabled`。`disabled` 用于明确淘汰或质量不达标的模型；它仍保留在私有 routes 和管理台审计数据中，但不会出现在公开模型目录、调度候选或生成的 CPA 模型配置中。目录同步会保留该决定，不会因为上游 `/models` 仍返回同一 ID 而自动恢复。

渠道和模型都可以设置整数 `priority`，数值越大越优先；模型级值覆盖渠道级值。未配置时为 `0`，同健康状态和优先级下按渠道 ID 稳定排序。

可选字段：

- `displayName`
- `maxContextLength`
- `inputModalities`
- `outputModalities`
- `thinkingLevels`

不要凭模型名称或 `/models` 返回结果推断能力。只有实际完成对应任务型验收后，才声明图片、工具、结构化输出、长上下文或 thinking 能力。

## Stable and pinned aliases

`stableAliases` 面向一般客户端切换，修改后客户端无需更换模型名。它是固定指针，不是自动故障转移：`coding-main` 或 `coding-backup` 指向的渠道不可用时会按该渠道返回错误，不会偷偷切到另一个渠道。需要跨渠道健康选择时使用逻辑模型 ID，或由管理员在验收后移动别名；因此两个别名不需要随每次请求频繁切换。

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

校验器拒绝把 `maxConnectionsPerChannel` 改成其他值。Node 调度器会在请求进入 HAProxy 前取得每渠道互斥租约；繁忙渠道不会再次收到新请求。HAProxy 为每个物理渠道生成一个 backend，并设置 `http-reuse never`、`alpn http/1.1`、`maxconn 1`、`maxqueue 8` 和 `retries 0`，仅作为绕过调度器时的最终防线。
