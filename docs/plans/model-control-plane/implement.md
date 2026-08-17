# Model Control Plane Implementation Plan

## Current Status

Router MVP is implemented in the working tree:

- exact upstream IDs are automatically grouped into logical public models;
- logical, stable, pinned, and direct model IDs resolve through one scheduler;
- one in-memory reservation covers every model and protocol on a physical channel;
- busy candidates are skipped, and an all-busy result returns `429 all_candidates_busy` without another upstream request;
- same-protocol Responses traffic uses reviewed native passthrough, while other combinations use the internal CPA `adapted` transport;
- CPA now listens only on the internal loopback port and Node owns the single public port;
- cancellation, streaming lifetime, authentication replacement, header filtering, and no-replay behavior have integration coverage.

Persistent health state and redacted canary summaries now live in the Git-ignored `runtime/control-state.json`; stale transient health and cooldown entries are discarded on restore, while release-scoped failures are retained only for the same configuration digest. Configuration writes and model synchronization now share a low-sensitivity FIFO control-job queue, and pending channel/model changes drain new reservations without interrupting existing leases. The production start script now owns an injectable CPA/HAProxy child supervisor with readiness checks, old-release restoration, and a CSRF-protected runtime apply entrypoint; deployment rehearsal and audit history remain in later phases below.

Stage 1 已在 `b7634e6` 完成并部署：`loadConfig` 同时兼容旧
`channels.local.env` 和结构化 `providers.local.json`；每次配置变更保存带父链和内容 digest
的完整私有 revision；有界 audit JSONL、已认证的 revision list/diff/rollback API 与 Changes
管理界面均已接入。rollback 与 apply 共用 FIFO，并在运行时失败时恢复原私有快照。公开
`/healthz` 和新版 `/admin` 标记已通过；认证后的持久化状态、revision 一致性、精确 canary
以及流式/非流式请求仍是进入 Stage 2 部署前的生产验收门槛。

The first admin slice is now also implemented: same-port `/admin`, in-memory HttpOnly admin sessions, CSRF/origin checks for tests, logical-model candidate status, exact-candidate poetry canaries with redacted summaries, revisioned stable-alias moves, persistent model enable/disable controls, and the serialized runtime apply path. Logical grouping edits remain later-phase work.

The authenticated connection helper exposes the current `/v1` Base URL and a masked gateway client key. Full gateway-key retrieval is a separate same-origin `POST` protected by the session CSRF token; it is never included in initial HTML and is automatically re-masked in the UI. Channel credentials remain write-only.

The private configuration slice now supports atomic, revisioned channel create/update/delete operations. New channels start disabled, deletion requires a disabled channel with no stable/pinned alias references, failed validation restores both private files, and every successful mutation reports that a restart is required.

运维导入也支持安全合并：`npm run merge:legacy -- <legacy-env>` 只更新旧格式文件中的渠道字段，保留现有密钥、Tunnel、启用状态、模型目录和别名，并将新增渠道置为禁用；写入前会创建私有 revision 备份。`npm run sync:models -- <channel-id>...` 可在不启用渠道的情况下显式同步指定模型目录，便于先目录发现、再任务型测活、最后启用。

## Remaining Roadmap (2026-08-17)

后续工作按依赖顺序推进。每一阶段独立提交、独立回滚；在前一阶段的验收证据完整前，
不提前开始依赖它的下一阶段。现有单公网端口、单渠道互斥、无自动重放、无周期探测、
固定诗词测活和私密字段不落 Git/日志的约束保持不变。

### Stage 0: Production Rehearsal Gate (partially complete)

目标是证明当前 `b7634e6` 基线在真实翼龙容器中成立，而不是把公开健康检查等同于完整验收。

本地可丢弃夹具已经直接覆盖正常切换、同 digest revision 提交、active pointer 提交失败
恢复旧 release，以及排空超时不触碰当前运行时；真实翼龙环境的下列验证仍是部署门槛。

- 已通过 `AUTO_UPDATE=1` 重启容器；Console 显示 Online，公开 `/healthz` 返回 200，且部署的
  `/admin` 已包含 Changes、revision、audit 和 rollback 控件。控制台为 canvas，未从 DOM
  提取提交号；新版页面标记用于证明代码已加载。
- 在管理台确认 `runtime.available=true`、`controlState.storage=persistent`、运行 revision
  与磁盘 revision 一致；该项需要操作者手工建立管理会话后继续，只读取低敏状态。
- 选择一个已启用的精确渠道模型执行固定诗词 canary；只核对状态、transport、延迟和
  正文长度，不查看或保存正文。
- 对同一可用模型各执行一个流式和非流式真实小任务，确认流式生命周期持有租约、
  非流式不会被强制改成流式。
- 验证同 digest apply 不重启内部进程但会提交 loaded revision；再验证一次正常的有变更
  apply。生产环境的故障注入或私有配置改动必须单独取得批准；失败回滚先在可丢弃夹具中
  演练。

验收证据：Console 的低敏 ready/apply 结果、管理台状态、一次精确 canary 摘要、流式和
非流式请求结果。任何 Cookie、密钥、请求正文、响应正文和上游原始错误都不进入记录。

### Stage 1: Structured Private Revisions, Audit, and Rollback (complete)

目标是让变更历史真正可检查、可解释、可恢复，而不是只有备份目录。

- 引入 `config/providers.local.json` 存放渠道 URL、API key、协议、启用状态和优先级；
  `channels.local.env` 最终只保留网关、管理和 Tunnel 等进程级密钥。迁移必须显式执行、
  先备份、支持 dry-run，并在过渡期兼容旧 env，不在输出中展示私密值。
- 每个 `runtime/config-revisions/<revision>/` 增加 manifest：父 revision、时间、操作类型、
  受影响的渠道/模型 ID、内容 digest 和验证结果。URL 只记录“已变化”，API key 只记录
  “已替换”，不保存值。
- 新增有界的 `runtime/audit-events.jsonl`，只记录 job ID、操作类型、结果、revision、
  耗时和分类错误码；不记录请求体、提示词、正文、Header、URL、密钥或会话标识。
- 提供已认证的 revision 列表、结构化脱敏 diff 和 rollback API。rollback 必须进入同一
  FIFO 队列，排空租约，生成并验证 release，成功激活后才更新 loaded revision；失败时
  恢复当前配置和运行时。
- 管理台增加 Changes 视图，展示当前/待应用 revision、脱敏 diff、历史和显式确认的回滚。

验收条件：迁移前后生成配置语义一致；损坏 revision、并发 apply/rollback、排空超时和
readiness 失败均保留原运行配置；公开审计扫描证明历史、API 和 UI 中没有私密值。

### Stage 2: Explicit Logical Models and Candidate Priority (local complete; production acceptance pending)

目标是完成 PRD 中“不同上游 ID 由操作者显式合并”的能力，同时保留现有精确路由。

- 增加版本化 `logicalModels` 配置：logical ID、enabled、候选 channel/upstream-model、
  候选 enabled 和 priority。相同 upstream ID 仍可自动成组；不同 ID 永不模糊推断。
- 提供 schema v1 到新 schema 的确定性迁移和回滚；旧 `<channel>/<model>` 直接 ID 保持
  可用，现有 exact stable/pinned alias 不被静默改写。
- stable alias 可显式指向逻辑模型或精确候选；pinned alias 继续只允许精确、带审批引用
  的目标。`coding-main`/`coding-backup` 仍是固定指针，不根据健康状态自动漂移。
- 增加逻辑组 CRUD、候选优先级/启用状态和 alias 目标 API，全部走原子验证与 FIFO 作业。
- 管理台 Models/Routing 视图支持建组、拆组、排序、冲突检查和精确 canary。

验收条件：两个不同 ID 的候选可组成一个逻辑模型；直接 ID、固定 alias 和 pinned alias
兼容；禁用/忙碌候选不会绕过渠道互斥；无效或循环引用不会写入私有配置。

本地实现已完成 2A–2D 的代码与 fixture 验收：schema v1 保持兼容，v2 支持显式逻辑组、
候选开关/优先级、stable logical target、原子 CRUD、revision diff、同步引用保留和管理台
编辑器；真实 usage 事件按解析后的逻辑组 ID 聚合，不同 upstream ID 不再被拆开。桌面与
390px 移动视口通过 Edge CDP 检查，无横向溢出、控件重叠或脚本异常。当前私有 routes
仍保持 schema v1，`migrate:routes` 只执行过 dry-run；部署重启、认证后状态核对和真实小任务
验收仍待完成，未经操作者批准不执行 `--apply`、不创建生产逻辑组、不移动生产 alias。

执行切片：

1. **2A 配置契约与纯路由**：新增向后兼容的版本化 `logicalModels` 结构、确定性 v1 读取/
   v2 写入规则、显式候选优先级与 stable logical target；先覆盖 config、catalog、scheduler
   和 revision diff，不提供自动迁移或改写现有私有 routes。
2. **2B 原子变更与 API**：增加逻辑组 create/update/delete、候选启用/排序和 stable alias
   目标 API；全部经过现有 revision store 与 FIFO，model sync、model disable 和 channel delete
   必须检查逻辑组引用。
3. **2C 管理台工作流**：在当前内联管理台先提供可用的逻辑组编辑、候选排序和冲突提示；
   React/Vite 迁移仍留在 Stage 4，避免同时改变 API 与前端框架。
4. **2D 验收与部署**：fixture 覆盖不同 upstream ID 合组、busy alternate、streaming 筛选、
   直接 ID 兼容、非法引用和 revision rollback；本地全套门槛通过后再重启翼龙并执行一次
   低敏真实验收。

### Stage 3: Evidence-Based Scheduling and Conservative Circuit Breaking

目标是补齐设计稿中的同优先级决胜项和故障状态机，但不引入自动重放或额外探测流量。

详细状态、排序、持久化、half-open 和验收契约见
[Stage 3 Evidence Scheduling and Circuit Breaker Plan](stage3-evidence-scheduling.md)。

- 在 `runtime/control-state.json` 中持久化有界、脱敏的候选结果统计：成功/失败计数、
  连续瞬态失败数和 EWMA 延迟；不保存 request ID、正文或 Header。
- 候选排序固定为：健康状态、operator priority、最小样本门槛后的成功率、EWMA 延迟、
  channel ID。所有时间与衰减规则使用可注入时钟并做确定性测试。
- timeout/5xx 达到保守阈值后进入 open cooldown；冷却结束后的下一次真实或人工请求作为
  half-open，不生成后台探测。成功关闭 circuit，失败重新打开。
- 管理台只展示低敏统计和“为何选择/排除候选”的分类原因，避免把评分解释成模型能力排名。

验收条件：排序测试覆盖样本不足、并列、过期统计、进程重启和 half-open；已经发出的
生成请求始终只执行一次；只有一个候选时也不会因统计异常形成永久锁死。

本地实现已完成 3A–3D：候选证据 reducer、v1 到 v2 状态迁移、保守熔断/half-open、
流式完整生命周期终态记录、无重放集成覆盖，以及管理台低敏证据和排除原因码均已接入。
当前本地门禁为 `npm test` 135/135、`npm run check` 和 `npm run audit:public` 通过；真实翼龙
环境的重启、认证后低敏状态读取、一次精确诗词 canary，以及流式/非流式小任务仍待生产验收。

### Stage 4: WebUI MVP on Stable APIs

API 契约稳定后再把当前内联页面迁移到 Vite + React + TypeScript；构建产物仍由同一个
Node 进程在 `/admin` 提供，不增加服务、数据库或公网端口。

- 建立 Overview、Channels、Models、Routing、Changes 五个工作视图。
- 使用紧凑表格、明确状态、`lucide-react` 图标和可访问的确认对话框；保留 Base URL/
  gateway key 快捷复制、30 秒重新掩码以及渠道密钥只写不读。
- 对 busy、cooling、disabled、draining、test/apply/rollback running、成功和失败提供完整状态。
- 使用 Playwright 在桌面和移动视口验证布局、交互、无重叠、键盘操作、CSP 和浏览器控制台。

验收条件：日常渠道、模型、路由、变更和回滚操作无需手改文件；页面首屏不是营销页，
无嵌套卡片和密钥泄露；构建后仍保持单端口部署。

### Stage 5: Protocol Matrix and Operational Closeout

- 用 fixture upstream 完整覆盖 Responses SSE/JSON、Chat Completions 流式/非流式、Claude
  Messages、认证替换、Header 过滤、客户端断开、超时和畸形响应。
- 真实环境按“请求 profile”而不是穷举所有模型执行一次固定任务 canary，确认 native 与
  adapted 标签准确；不创建周期性探测。
- 增加 release 保留策略，只清理未被 active/previous/revision 引用的旧 release；增加
  usage/audit 文件压缩与容量上限。
- 增加 apply 耗时、排空超时、队列深度和子进程异常退出等低敏运维指标，并更新部署、
  迁移、恢复和故障处理文档。

最终门槛：`npm test`、`npm run check`、`npm run audit:public`、语法检查、桌面/移动截图、
一次真实精确 canary、流式与非流式请求、正常 apply 和可证明的失败回滚全部通过。

### Explicit Non-Goals

- 不自动切换 `coding-main`/`coding-backup`；需要多候选调度时使用 logical model ID。
- 不重放已发送的生成请求，不做周期测活，不伪造 Codex/Claude 私有身份。
- 不做模糊模型等价推断、多租户、计费、配额或数据库迁移。

## Historical Build Phases

以下内容保留最初的构建顺序和验收依据；当前剩余工作的执行顺序以上面的 Remaining
Roadmap 为准。

### Phase 1: Contracts and Pure Logic

- Add versioned schemas for private providers, logical models, candidates, and redacted health state.
- Add migration from current channel environment entries to `providers.local.json` without logging secrets.
- Extract protocol-to-path and response-text handling from canary code for reuse.
- Implement and test logical model resolution, candidate filtering, deterministic ordering, and direct-route compatibility.
- Implement and test the per-channel semaphore, busy exclusion, cancellation, streaming release, and immediate `429 all_candidates_busy` behavior.

Validation:

```bash
npm test
npm run check
npm run audit:public
```

### Phase 2: Public Control Gateway

- Move CPA from the public allocation to a fixed internal listener.
- Add the Node public server for gateway authentication, `/v1/models`, request parsing, model rewrite, and response streaming.
- Add a native Responses transport that forwards same-protocol incoming client requests directly through the selected channel's HAProxy listener.
- Add a tested header policy that replaces authentication/target framing, strips sensitive and hop-by-hop headers, and preserves actual remaining client end-to-end headers.
- Add reviewed `responses-native`, `openai-chat`, and `claude-messages` request profiles with honest gateway identification for server-generated traffic.
- Forward requests requiring protocol adaptation to internal CPA and label them `adapted`.
- Keep HAProxy `maxconn 1` and no-retry configuration unchanged.
- Add passive outcome classification and circuit/cooldown state updates.
- Add integration tests with fake CPA and delayed streaming responses proving channel-wide serialization.

Critical tests:

- same channel, different models never overlap;
- same logical model, two idle channels follows ordering;
- preferred channel busy causes use of an idle alternate;
- direct model IDs cannot bypass the channel semaphore;
- a busy channel is excluded for all of its models;
- all candidates busy returns `429` without forwarding or queueing;
- aborted clients release reservations;
- streaming holds reservations until close;
- generation requests are not replayed after upstream dispatch.
- native requests preserve the actual client request envelope except for model, auth, target, and transport framing;
- adapted requests can never be reported as `native-passthrough`.

### Phase 3: Admin API and Configuration Jobs

- Add admin session, CSRF, origin checks, rate limits, and redacted error handling.
- Add channel CRUD with disable/drain/delete lifecycle.
- Add model sync jobs using the existing model-sync module.
- Add server-side API canary jobs using the fixed poetry task and non-queueing semaphore acquisition.
- Record request profile, transport, latency, status, and redacted error class without persisting generated text or header values.
- Add logical grouping, candidate priority, alias editing, validation, apply, and rollback endpoints.
- Add private revision backups and redacted audit events.
- Refactor child supervision so internal CPA/HAProxy can be replaced without restarting the public parent.

### Phase 4: WebUI

- Use Vite, React, TypeScript, the project's own compact design tokens, and `lucide-react` icons.
- Build Overview, Channels, Models, Routing, and Changes views.
- Add explicit busy, cooling, disabled, test-running, apply-running, success, and error states.
- Keep secrets write-only and response bodies absent from the UI.
- Verify desktop and mobile layout with Playwright screenshots; this is an operator tool, so favor dense tables and predictable controls over promotional cards.

### Phase 5: Protocol-Fidelity Validation

- Preserve the one-port Pterodactyl deployment and existing Cloudflare Tunnel origin.
- Add migration and rollback documentation.
- Add fixture upstreams that capture request shape in memory and assert native header/body preservation without writing sensitive values.
- Verify Responses SSE and non-SSE behavior, Chat Completions, Claude Messages, authentication replacement, and hop-by-hop header stripping.
- Run the meaningful poetry canary through each enabled request profile and confirm that adapted requests are labeled correctly.
- Keep CPA identity confusion, Claude cloaking, and system-prompt substitution disabled in generated configuration tests; the documented Codex compatibility-header switch is explicitly covered by the generated configuration test.

## Delivery Slices

1. **Router MVP**: logical models, channel semaphore, busy-aware selection, no WebUI.
2. **Operations MVP**: admin API, manual model tests, model sync, apply/rollback.
3. **WebUI MVP**: all routine operations without editing files manually.
4. **Protocol fidelity**: native client passthrough, reviewed server canary profiles, and transport-label verification.

Each slice must pass unit tests, integration tests, `npm run check`, `npm run audit:public`, and a real one-request canary before deployment.

## Rollback Points

- Router MVP can fall back to the current topology where CPA owns the public port.
- Private config migration retains the original ignored env/routes files and writes timestamped backups.
- Every apply retains the previous content-addressed internal release.
- Protocol profiles are versioned configuration; rollback restores the previous generated release and profile revision.

## Decisions Required Before Implementation

- Later decision: whether an explicitly opt-in, pre-response cross-channel retry is worth the duplicate-generation risk. It is excluded from MVP by default.
