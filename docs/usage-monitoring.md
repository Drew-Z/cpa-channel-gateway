# 24 小时模型使用监控契约

## 1. Scope / Trigger

当需要查看单租户网关的模型使用量、渠道成功率或近期故障时，使用控制网关内的滚动使用监控。监控只统计真实业务请求，不把 CPA/HAProxy 原始文本日志当作数据源，也不主动发送任何测活请求。

## 2. Signatures

### 管理 API

```text
GET /admin/api/usage
```

请求必须先通过 `/admin/api/session` 建立管理会话；该读取接口不需要 CSRF，但仍需要 HttpOnly 会话 Cookie。

### 事件存储

```text
runtime/usage-events.jsonl
```

默认文件上限为 4 MiB，可通过 `gateway.json` 的 `usage.maxBytes` 调整为正整数。每次追加前会检查预算；超限时只保留最新的完整事件并使用同目录临时文件原子替换，因此不会产生超出预算的持久文件。

该路径属于 Git 忽略的运行时目录。每条事件只允许以下字段：

```json
{
  "v": 2,
  "at": 1776216000000,
  "requestedModel": "coding-main",
  "channelId": "free",
  "logicalModelId": "coding-pool",
  "upstreamModel": "provider-model-a",
  "outcome": "success",
  "transport": "native-passthrough"
}
```

`logicalModelId` 是 catalog 已解析的逻辑组 ID；旧 v1 事件在读取时回退到 `upstreamModel`，因此升级不会丢失现有统计。`outcome` 只能是 `success`、`failure` 或 `cancelled`；`transport` 只能是 `native-passthrough`、`adapted` 或 `unassigned`。

## 3. Contracts

### 统计响应

```json
{
  "windowHours": 24,
  "from": "2026-08-14T12:00:00.000Z",
  "to": "2026-08-15T12:00:00.000Z",
  "storage": "persistent",
  "summary": {
    "total": 10,
    "success": 7,
    "failure": 2,
    "cancelled": 1,
    "successRate": 70,
    "nativePassthrough": 7,
    "adapted": 3,
    "lastSeenAt": "2026-08-15T11:59:00.000Z"
  },
  "logicalModels": [],
  "models": [],
  "physicalModels": [],
  "channels": []
}
```

- `logicalModels` 按 catalog 已解析的逻辑组 ID 聚合；自动同名组仍使用原始模型 ID，显式跨 ID 组使用操作者定义的组 ID。
- `models` 按客户端请求入口聚合，例如稳定别名、逻辑 ID 或精确渠道 ID。
- `physicalModels` 按 `<channelId>/<upstreamModel>` 聚合，反映真实渠道表现。
- `channels` 按物理渠道聚合。
- 每个聚合项包含 `id`、`total`、`success`、`failure`、`cancelled`、`successRate`、两个 transport 计数和 `lastSeenAt`。
- `successRate` 是 `success / total * 100`，保留两位小数；没有请求时为 `null`。
- `storage` 为 `persistent`、`memory-fallback` 或 `memory`。统计写盘失败时只能切换为内存统计，不能改变业务请求结果。

### 统计口径

- 上游完整返回 `2xx` 计为成功。
- 上游非 `2xx`、transport 错误、无可用候选和全部候选繁忙计为失败。
- 客户端在上游完成前主动断开计为取消。
- 未知模型、缺少模型字段、无效 JSON、无效网关密钥和管理台测活不计入使用事件。
- 事件保留略长于 24 小时，用于重启后恢复滚动窗口；压缩后最多保留 50,000 条事件，并受 `usage.maxBytes` 字节上限约束。

### 隐私边界

事件和响应不得包含提示词、响应正文、请求头、Authorization、API key、用户标识、Cookie、请求 ID、上游错误正文、IP、provider endpoint 或未限制的错误文本。

## 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 管理会话缺失或过期 | `401 admin_unauthorized` |
| 没有有效模型候选但模型 ID 已知 | 返回原有调度错误，并记录一条无渠道归属的 `failure` |
| 未知模型 ID | 返回 `404 model_not_found`，不记录使用事件 |
| 上游返回 `2xx` 并完整结束 | 记录 `success` |
| 上游返回非 `2xx` 或连接失败 | 记录 `failure`，业务响应仍按原有代理错误处理 |
| 客户端提前关闭连接 | 记录 `cancelled`，释放渠道租约 |
| 事件文件不存在 | 创建私有运行时文件；在此之前使用可恢复的内存快照 |
| 事件文件损坏、不可写或压缩失败 | 丢弃无效行并切换 `memory-fallback`，不阻断业务请求 |
| 统计读取窗口不是 1–24 的整数 | API 固定回退到 24 小时窗口 |

## 5. Good / Base / Bad Cases

- Good：同一逻辑模型由 `free` 和 `free2` 提供时，`logicalModels` 合并总量，`physicalModels` 分别显示两个渠道的成功率。
- Good：全部候选繁忙时，请求模型的失败数增加，但没有虚构某个渠道的上游调用。
- Base：新部署没有 `runtime/usage-events.jsonl` 时，管理台显示 0 请求，第一次真实请求后再创建文件。
- Bad：把管理台诗词测活计入真实使用量，导致渠道成功率被测活污染。
- Bad：把 `requestedModel` 当作唯一模型维度，导致稳定别名、逻辑 ID 和精确 ID 无法合并。
- Bad：把原始请求/响应 JSON 或上游错误正文写入 JSONL，以便“以后排查”。

## 6. Tests Required

- `test/usage-monitor.test.mjs`
  - 断言 24 小时边界、成功/失败/取消计数和两位成功率。
  - 断言同一逻辑模型跨两个渠道合并，物理渠道模型仍分开。
  - 断言重启重新加载事件、损坏行被清理、敏感测试字段不会落盘。
  - 断言不可写路径回退到 `memory-fallback` 且不影响 `record` 调用结果。
- `test/control-gateway.test.mjs`
  - 断言正常代理、全部候选繁忙和客户端断开分别形成成功、失败和取消事件。
  - 断言管理台测活不计入 `/admin/api/usage`。
  - 断言未知模型返回 404 且不会新增统计。
  - 断言管理页面包含使用统计入口，且仍使用 CSP nonce、同源 fetch 和 CSRF。
- 提交前运行 `npm test`、`npm run check`、`npm run audit:public`、`node --check src/usage-monitor.mjs`、`node --check src/control-gateway.mjs` 和 `git diff --check`。

## 7. Wrong vs Correct

### Wrong

```js
logs.push({
  prompt: request.body,
  response: upstreamBody,
  model: request.headers.authorization
})
```

### Correct

```js
usageMonitor.record({
  requestedModel,
  channelId: candidate.channelId,
  logicalModelId: selection.resolved.logicalModelId,
  upstreamModel: candidate.upstreamModel,
  outcome: 'success',
  transport: 'native-passthrough'
})
```

统计模块只负责低敏事件、滚动聚合和故障回退；诊断上游正文、凭据或请求内容必须通过受控的人工排查流程完成，不能扩展使用日志字段。
