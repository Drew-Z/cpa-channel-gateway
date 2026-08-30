# CPA Channel Gateway

面向个人单租户的多渠道模型网关。它在一个固定 Node.js 容器中运行
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 与
[HAProxy](https://www.haproxy.org/)。公网只暴露 Node 控制网关；CPA 与所有
HAProxy listener 均绑定到容器回环地址。

## 解决的问题

- 聚合多个 OpenAI Chat Completions、OpenAI Responses 和 Claude Messages 兼容渠道，并把相同原始模型 ID 自动聚合成一个逻辑模型。
- 通过 `coding-main` 等稳定别名切换精确模型或逻辑模型，客户端配置保持不变。
- 稳定别名是可审计的固定指针：精确目标不自动故障切换；逻辑目标固定到一个审核过的候选组，并在组内按健康、空闲和优先级选择，别名本身不会自动漂移到其他组。
- 每个物理渠道共享一个 HAProxy backend，`maxconn 1`，所以该渠道的全部模型和协议合计最多只有一个在途请求。
- Node 为每个物理渠道持有一个互斥租约。渠道繁忙时会从所有模型的新请求候选中临时隐藏；没有其他空闲候选时立即返回 `429 all_candidates_busy`，不向上游排队或重复调用。
- HAProxy 仍以 `maxconn 1` 作为最终硬约束；CPA 和网关都不会自动重放已经发往上游的生成请求。
- 私有渠道 URL、密钥、激活配置、日志和二进制不会进入 Git。
- 私有配置按完整快照保存带 manifest 的 revision；成功应用后 manifest 会关联对应的内容寻址 release，清理时保护 active、previous 和所有有效 revision 引用，支持排空、readiness 验证和事务回滚。
- canary 使用真实小任务，不使用 `hi`、`你好` 等无意义提示词。
- 流式与非流式请求按模型能力筛选候选；不支持时返回 `422 streaming_not_supported`，不会静默降级或重放请求。
- 已同步并启用的 embedding 模型可通过精确渠道模型 ID 调用 `/v1/embeddings`；该请求直达配置上游，仍受渠道互斥锁和真实调用统计约束。
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
3. 执行 `npm run sync:models`，把启用渠道 `/models` 返回的目录同步到私有 routes。每个模型使用 `<渠道ID>/<原始模型ID>` 作为无冲突的公开 ID。新渠道默认进入“待测试”状态；生成模型完成任务型测活后再切换为生产启用，非生成模型只需确认目录和协议配置后通过真实业务调用观测。
4. 在 `routes.local.json` 审核模型协议和能力元数据。单个渠道可以按模型分别覆盖为 `openai-compatible`、`responses` 或 `claude`。
5. 按需显式配置 `logicalModels`，再配置精确或逻辑稳定别名；AI Daily 等受审批约束的用途只能使用带 `approvalRef` 的精确 `pinnedAliases`。
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

旧格式文件需要补充到现有配置时，使用合并模式：

```bash
npm run merge:legacy -- /absolute/path/to/channels.local.env
```

合并模式会保留现有网关密钥、管理密钥、Tunnel 配置、启用状态、模型路由和别名；新增渠道默认禁用，并在写入前备份到 `runtime/config-revisions/`。旧式 `chat/completion` 会归一化为 `openai-compatible`，误填到 Base URL 末尾的 `/chat/completions`、`/responses` 或 `/messages` 也会移除。初次导入发现已有私有配置时会拒绝覆盖；只有明确执行 `npm run replace:legacy -- <path>` 才会整体替换。所有模式都只在本地写入 Git 忽略文件，不会枚举模型或调用上游。

旧版 `channels.local.env` 已包含渠道 URL、密钥和协议时，可显式迁移到结构化的 `providers.local.json`：

```bash
npm run migrate:providers -- --dry-run
npm run migrate:providers -- --apply
```

迁移默认只做 dry-run；只有 `--apply` 才会写入。它会把 `channels.local.env` 中的渠道字段移出，保留网关、管理和 Tunnel 等进程级变量，并从 routes 中移除已迁移的渠道 `enabled/priority` 冗余字段。迁移前会创建私有备份，写入后会重新校验归一化配置语义；失败会恢复原文件。`providers.local.json` 与旧渠道 env 不能并存，避免两份私有配置静默覆盖。迁移结果只输出渠道 ID、数量和（apply 时的）备份路径等低敏摘要，不输出 URL、API key 或响应正文。

旧 routes schema 可先做只读预览，再显式升级到支持逻辑组的 v2；该操作不会调用上游、猜测模型等价关系或移动现有别名：

```bash
npm run migrate:routes
npm run migrate:routes -- --apply
```

## 翼龙面板

完整步骤见 [翼龙面板部署指南](docs/pterodactyl-deployment.md)。自有域名接入见 [Cloudflare Tunnel 部署](docs/cloudflare-tunnel.md)。公开仓库可直接通过 HTTPS 克隆，Git 用户名和 Access Token 均留空。私有渠道配置不通过 Git 分发，必须在安装后由操作者手工上传。

推荐填写：

| 设置 | 值 |
| --- | --- |
| Server Image | Nodejs 22 |
| Git Repo Address | `https://github.com/Drew-Z/cpa-channel-gateway.git` |
| Install Branch | `main` |
| User Uploaded Files | 关闭 |
| Auto Update | `1`；公开代码可自动拉取，私有配置仍需手工上传 |
| Git Username | 留空 |
| Git Access Token | 留空 |
| Additional Node Packages | 留空 |
| Main File | `startup.js` |
| Additional Arguments | 留空 |

将面板主 allocation 的端口作为环境变量 `SERVER_PORT`。只需要一个公网 allocation；第二个 allocation 不需要使用。

### 管理台

管理台是同一 Node 进程提供的 React/Vite 静态应用。生产部署使用仓库内的 `admin/dist/` 构建产物，不增加服务、数据库或公网端口；面板主文件使用 `startup.js`，对通用 Node egg 未传播的 `git pull` 失败执行严格门禁，再加载不依赖第三方 npm 包的生产 Node 进程。项目自己的启动器不会重复访问 npm registry；依赖安装、管理台构建和测试由 CI 完成。若面板 egg 在执行主文件前固定运行 `npm install`，仍需在面板模板层单独关闭。修改 `admin/src/` 后先执行 `npm run build:admin`，并把更新后的 `admin/dist/` 一并提交，翼龙 `AUTO_UPDATE=1` 重启后即可加载新界面。

管理台会区分当前进程已加载 revision 与磁盘待重启 revision；变更未重启时会禁用测活，避免旧进程误报。失败登录按来源地址短时限速；Cloudflare Tunnel 只有在本地回环连接上才会信任合法的 `CF-Connecting-IP`，来源桶最多保留 1024 个且不会因容量耗尽阻断正确管理密钥。过期会话会被主动清理。逻辑模型编辑器只从现有精确模型目录添加候选，支持候选启用状态和整数优先级；不同 upstream ID 不会被自动模糊合并。

`CPA_MANAGEMENT_KEY` 留空时 `/admin` 不开放。填写独立的 32 字符以上随机管理密钥并重启后，访问同一域名的 `/admin` 登录。管理密钥只通过登录表单提交；登录时会删除地址中意外出现的 `password` 查询参数，避免它继续留在当前浏览器历史项中。管理台的会话只保存在 Node 内存中，重启后失效；同时有效的会话最多保留 64 个，超出时淘汰最早建立的会话。现有渠道可以直接编辑名称、Base URL、默认协议和优先级，也可以只写替换 API key；默认协议只影响未单独指定协议的模型，旧密钥永不读取或回显，留空表示保持不变。模型下拉框同时用于测活和路由管理，不需要手写精确 ID。忙碌或已禁用模型不能测活，但仍可被选中管理；可以把 `coding-main`、`coding-backup` 指向精确模型或显式逻辑组，也可以禁用/恢复精确渠道模型。模型禁用、稳定别名移动和逻辑模型删除都需要二次确认；已有逻辑模型 ID 不支持伪装成重命名的编辑。禁用仍被 stable/pinned alias 或启用逻辑候选引用的模型会被拒绝，必须先移动引用。配置写入但尚未重启时，测活按钮会自动禁用，路由调整仍可继续批量完成。所有配置写入和模型同步都经过单一 FIFO 控制作业队列；目录同步、业务请求和诗词测活共享同一个物理渠道互斥租约，渠道忙碌时同步不会访问上游。渠道停用、待测试或删除会立即显示“排空中”，停止新预约但允许在途请求正常结束。管理台状态会显示当前作业、等待数量和低敏最近作业记录。待测试渠道会启动内网 HAProxy/CPA listener，但不会出现在公开 `/v1/models`，也不会被生产调度；只有管理员点击“设为生产”后才会加入统一模型出口。测活使用固定诗词任务、同一渠道互斥租约和相同协议路径，只保存状态摘要、transport、延迟与正文长度，不保存诗词正文。

管理台的 Changes 区域展示 loaded/pending revision、有限历史、结构化脱敏 diff 和最近审计结果。每次跨文件写入前会在 Git 忽略的 `runtime/config-transaction/` 保存完整旧快照；若进程在写入中途退出，下次加载会先自动恢复。Base URL 在 diff 中只显示“已变化”，API key 只显示“已替换”；快照原文不会进入 API 或 DOM。回滚必须先查看目标 revision，再二次确认；它与 runtime apply 共用同一 FIFO，排空在途请求、生成并验证 release，成功激活后才提交 loaded revision。损坏 revision、排空超时或 readiness 失败都会保留当前私有配置和运行时。审计写入 Git 忽略的 `runtime/audit-events.jsonl`，只含 job ID、操作、结果、revision、耗时和分类错误码。

Changes 还会显示 revision 历史占用量、有效/损坏数量以及保留 20/50/100 份时的预计可整理数量和空间，但不会暴露快照内容或服务器路径。历史整理只能由管理员手动发起，不会在启动或后台自动执行；请求必须同时提交相同的 `keep` 与 `confirmKeep`，并经过 CSRF、二次确认、FIFO 和低敏审计。当前 loaded/pending revision 始终受保护；其余被删除的旧快照不能从管理台恢复。

管理台的渠道列表会向已登录管理员显示经过校验的 Base URL，方便区分名称相近的渠道；公开模型 API、未登录响应和日志不会暴露该地址。健康状态会显示为“健康”“未测试”“降级”等中文状态。模型目录同步使用已有渠道下拉框，留空时同步生产渠道，也可显式选择待测试渠道，不需要手写渠道 ID；API 仍支持脚本传入精确渠道 ID。管理台会比较私有 env 与 routes：env 中已有、routes 尚未登记的渠道会出现在“渠道发现”，可一键导入为待测试，或导入后立即只读同步 `/models`；已经写入 routes 但当前进程尚未加载的渠道会显示“等待重启”。同步失败不会回滚已导入的待测试渠道，但不会把它加入生产调度。生成新配置后，正式启动脚本还提供“应用待重启配置”：排空请求、替换内部 CPA/HAProxy、检查 readiness，并在失败时恢复旧 release；没有运行时监督器时仍需重启容器。模型目录中已从上游消失、但仍被 stable/pinned alias 或逻辑候选引用的模型会标记为 `stale`，不会自动替换 `coding-backup`。渠道健康、冷却、candidate 配置错误和最近测活摘要写入 Git 忽略的 `runtime/control-state.json`，重启后按 release 和时效规则恢复；完整隐私与失效契约见 [控制状态持久化](docs/control-state.md)。管理台还展示滚动 24 小时真实业务请求统计，包括请求总数、成功/失败/取消数量、成功率、逻辑模型、请求入口和实际渠道模型，并在概览页按物理模型显示原生透传与适配转发次数。管理台测活不计入使用统计。统计事件写入 Git 忽略的 `runtime/usage-events.jsonl`，仅包含时间、模型路由、结果和 transport；不保存提示词、响应正文、请求头、密钥、用户标识或请求 ID。成功率按完整返回的 `2xx` 请求数除以全部请求数计算，容器重启后仍可从本地事件文件恢复。事件文件默认受 4 MiB 硬上限约束，超限时原子压缩并淘汰最旧记录。

登录后的“客户端连接”区域会根据当前访问域名生成带 `/v1` 的 Base URL，并提供复制按钮；`GATEWAY_API_KEY` 默认只显示掩码，只有显式点击“显示”或“复制 API key”时才通过带 CSRF 保护的已认证同源请求取回，显示后 30 秒自动恢复掩码。连接接口始终 `no-store`，不会把完整密钥写入初始 HTML、日志或公开 API。渠道 API key、管理密钥和 Tunnel Token 永不回显。控制作业与排空契约见 [控制作业与排空](docs/control-jobs.md)。

模型目录还记录 `kind`、`streaming` 和 `canaryEligible`。embedding、rerank、音频、图像、视频、OCR、审核等非生成模型不会进入生成模型的逻辑别名、stable/pinned alias 或诗词测活。当前已实现的 embedding 模型会以精确 `<渠道ID>/<原始模型ID>` 出现在公开 `/v1/models`，并标注 `kind=embedding` 与 `/v1/embeddings` endpoint；rerank、音频、图像等尚未实现对应业务端点，继续保留在管理台和同步结果中，避免被误用为聊天模型。所有非生成模型均通过对应业务调用和真实调用统计观察。流式请求保留客户端的 `stream` 语义并透传分块响应，非流式请求不会被强制改成流式。

调用 embedding 时使用 `/v1/models` 返回的精确 ID，不使用生成模型别名：

```json
POST /v1/embeddings
Authorization: Bearer <client-key>

{
  "model": "free/text-embedding-3-small",
  "input": ["待向量化文本"]
}
```

网关会把 `model` 替换为上游原始 ID，并按该渠道配置的 URL、模型协议和 API key 转发；embedding 不接受 `/v1/responses`、`/v1/chat/completions` 或 `/v1/messages` 调用。

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

同步器按渠道顺序请求只读 `/models`，不发送生成提示词。任何渠道请求失败或返回空目录时都不会改写 routes；成功时会先创建 `config/routes.local.pre-model-sync-*.json` 或 revision 备份，再原子更新 `routes.local.json`。已有的协议、上下文、模态、thinking 和额外 alias 会保留；新模型得到 `<渠道ID>/<原始模型ID>`，未被引用的下线模型会删除。仍被 stable/pinned alias 或逻辑候选引用的下线模型会保留并标记为 `stale`，待引用移走后在下次同步清理。模型可以在私有 routes 中标记为 `disabled`；该状态会在目录同步中保留，模型不会进入公开 `/v1/models`、生产调度或生成的 CPA 模型段。管理台同步支持显式指定待测试渠道，不会把它们加入公开目录。

上游 `/models` 可能同时列出生成、embedding、reranker 或语音模型。目录同步只证明“上游声明存在”，不证明它支持当前渠道默认协议；生成模型正式使用前仍要按能力执行任务型 canary，非生成模型不发送不兼容的诗词请求，改由对应协议的真实业务调用验证。

如果渠道已经写入 `channels.local.env` 但还没有 routes 条目，优先在管理台“渠道发现”中导入，不要重复填写 API key。完全新的渠道才使用“新增渠道”表单；导入或新增后都先保持待测试，完成任务型 canary 后再切换为生产启用。

## 模型替换

优先在 `/admin` 的“模型测活与路由”中选择精确模型并设置稳定别名；需要跨不同 upstream ID 聚合时，在“逻辑模型与候选”中显式建组、设置候选优先级，再把别名固定到该组。需要淘汰旧模型时，先移走 stable/pinned alias 和逻辑候选引用，再点击“禁用模型”。这些操作会创建私有 revision；完成一批调整后统一应用或重启即可生效。

也可以离线修改 `config/routes.local.json`：

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

重启容器使 CPA 使用新 release。需要同时恢复私有配置和运行时时，优先在管理台 Changes 中选择目标 revision 并确认回滚。

下列旧命令只切换 active/previous 运行时 release，不恢复 `config/*.local.*`，因此不能替代 Changes 回滚：

```bash
npm run rollback
```

执行旧命令后同样需要重启容器。私有 revision 和运行时 release 都可能包含密钥，只能保存在容器持久化目录中，不能提交或复制到公开日志。

## 任务型验收

管理台会从当前模型目录生成精确模型下拉框；优先从下拉框选择，不需要手写模型 ID。脚本或 API 调用仍可使用精确模型别名验收，再切换稳定别名：

```bash
GATEWAY_API_KEY='...' \
CANARY_MODEL='sample/example-coding-model' \
CANARY_PROTOCOL='responses' \
npm run canary
```

从容器外验收时再提供 `GATEWAY_BASE_URL='https://<网关地址>'`；脚本仍只记录低敏摘要，不输出响应正文。

默认任务是生成一首四句七言绝句。`CANARY_PROTOCOL` 接受 `responses`、`openai-compatible`（或等价的 `chat`）和 `claude`。管理台还允许对当前精确模型临时覆盖协议进行一次试测；覆盖只作用于本次请求，不会静默修改配置或在业务请求中自动 fallback。脚本和管理台只记录 HTTP 状态、模型名、协议、transport、正文长度及白名单诊断，不输出正文、密钥、上游地址或完整错误。canary 也是正式请求，必须取得与生产请求相同的渠道租约，并由操作者明确执行；项目不创建周期性模型探测。

当某个模型的协议设置可能有误时，在“模型”视图选择精确 `<channel>/<upstream-model>`，切换 `Chat Completions`、`Responses` 或 `Anthropic Messages` 后点击“按此协议测活”。成功结果只在 30 分钟内有效，并解锁“应用到当前模型”；应用要求二次确认，写入私有 revision 后仍需显式应用或重启。同一渠道可以包含不同协议的模型，管理台不会把一次试测结果批量应用到整个渠道。测活失败会区分无效 JSON、空正文、缺少 choices、推理-only、工具/拒答、结构化正文和协议/路径错误等原因。

对本地所有已发现生成模型做一次逐渠道串行验收时使用：

```bash
npm run audit:channel-models
```

该命令需要 `CPA_MANAGEMENT_KEY`，通过本地网关 `/admin/api/tests` 登录后逐渠道串行执行，因而与业务、同步共用同一物理渠道租约；不会绕过调度器直连上游。管理 API 使用固定诗词任务、协议专用请求体和 512 输出上限；输出写入 Git 忽略的 `runtime/model-audits/`，只包含渠道、模型、配置/试测协议、HTTP 状态、耗时、正文长度和错误分类。429 由网关按渠道冷却处理，不重试同一个生成请求。验收结果不会自动改写生产配置；确认结果后可显式应用：

审计因渠道冷却、忙碌或配置待应用而停止时，可在下次运行设置 `CANARY_AUDIT_RESUME=runtime/model-audits/audit-<timestamp>.json`。断点续测只跳过已经成功或得到确定性结果的模型；429、5xx、超时和传输错误会在新一轮中重新进入待测集合，未发出上游请求的模型不计失败。

```bash
npm run apply:channel-audit -- runtime/model-audits/audit-<timestamp>.json channel/model channel/model --confirm --enable-channel channel
```

两个可选的 `channel/model` 参数分别用于更新 `coding-main` 与 `coding-backup`，只有本次审计成功且显式批准的目标才会被接受。`--confirm` 必填；渠道只有通过 `--enable-channel <channel>` 才会进入生产，模型只有通过 `--disable-model <channel/model>` 才会因确定性失败被禁用。认证或付款阻断可以停用渠道；429、5xx、超时、传输错误和单次空正文只记录，不自动停用渠道或模型。应用会生成私有 revision，之后仍需通过管理台“应用待重启配置”或重启容器。

## 运维策略

- `401/403`：立即禁用渠道并检查凭据，不重试同渠道。
- `402`：标记余额不足并禁用，不切换同渠道模型。
- `429`：遵循 `Retry-After`，进入冷却；不要主动高频探测。
- `400/404/405/422`：优先检查协议和路径，不偷偷换模型。
- timeout/5xx：第一阶段不自动重试。确认幂等和错误分类后，才评估最多一次跨渠道回退。
- 同渠道存在真实流量时不执行 canary。
- AI Daily 只能使用获批的 pinned alias，不允许跟随 `coding-main` 动态漂移。
- 需要把不同客户端隔离到互不重叠的渠道集合时，在私有 `config/clients.local.json` 中配置分组和客户端。管理台“客户端”视图支持创建/轮换/停用/删除 key 与分配渠道；明文 key 只在创建或轮换响应中显示一次，文件和 revision 只保存哈希与末尾提示。例如：

  ```json
  {
    "schemaVersion": 1,
    "groups": [
      { "id": "enterprise-doc", "channels": ["free3", "free4"], "enabled": true },
      { "id": "ai-daily", "channels": ["free7"], "enabled": true }
    ],
    "clients": [
      { "id": "enterprise-doc-agent", "group": "enterprise-doc", "keyHash": "<sha256>", "enabled": true }
    ]
  }
  ```

  启用分组之间不能共享物理渠道；每个客户端的 `/v1/models`、逻辑模型候选、并发锁和故障回退都只在所属分组内生效。存在 `clients.local.json` 后，`GATEWAY_API_KEY` 仅供网关访问内部 CPA，不再是公网万能 key；删除该文件并重启即可回到兼容的单 key 模式。

## 安全

- 网关是单租户服务，必须使用长度至少 32 的随机 `GATEWAY_API_KEY`。
- Cloudflare Tunnel 默认关闭；Token 只存在于 `channels.local.env`，并通过子进程环境传递。cloudflared 固定版本、校验 SHA-256 且禁用自动更新。
- CPA Management API 默认关闭；确需开启时仍只允许 localhost。
- 不提交 `config/*.local.*`、`runtime/`、`auth/`、`logs/` 或 `bin/`。
- `runtime/config-revisions/` 保存完整私有快照及其已应用 release digest；`runtime/config-transaction/` 只在跨文件写入期间保存崩溃恢复快照；`runtime/audit-events.jsonl` 只保存白名单低敏字段，这些路径都必须保持 Git 忽略。
- 公开或发布前运行 `npm run audit:public`；该检查会扫描当前跟踪文件、完整可达 Git 历史以及本地私密值是否意外进入仓库，但不会输出私密值。
- CPA 当前启用 Codex 的标准兼容头（由 `cpa.disableCodexCloaking=false` 控制），用于适配通常只检查 `User-Agent`/`Originator` 的上游；这不是客户端真实性证明，也不会复制 Desktop 版本。身份混淆、Claude cloaking 和系统提示词替换仍保持关闭；Responses 同协议 native 路径继续保留真实客户端实际发送的低敏请求头。
- 启动时使用 CPA 的 `-local-model`，模型目录来自已审核的本地 routes 配置，不依赖远程模型目录服务。
- HAProxy 验证上游 TLS 证书并固定 HTTP/1.1，避免单连接多路复用绕过单并发约束。
- Responses 客户端与 Responses 渠道同协议时，Node 直接保留实际请求语义和经过审查的非敏感端到端请求头；模型、认证、目标地址及传输相关字段由网关替换。其他协议组合标记为 CPA `adapted` 路径。
- 客户端 `x-request-id` 只允许不超过 128 字符的安全标识；其他值会被内部 UUID 替换。上游 `Set-Cookie` 不会转发到网关域名。
- 上游基路径由 CPA 的协议专用本地 URL 保留；Claude 会归一化末尾 `/v1`，避免生成 `/v1/v1/messages`。
- 仓库不包含真实渠道名称以外的 URL、密钥、原始错误和响应正文。

## 验证

```bash
npm test
npm run check:admin-dist
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

### 部署验收脚本

容器已经通过面板环境变量持有管理密钥时，可在翼龙 Console 执行默认只读检查：

```bash
npm run verify:deployment
```

该命令检查 `/healthz`、内部 runtime supervisor、持久化 control state 和 loaded/pending
revision，不输出管理密钥、gateway key、Cookie、CSRF token、请求/响应正文或上游原始错误。
只有显式设置非敏感的精确模型 ID 时才会发送固定诗词任务：

```bash
DEPLOYMENT_CANARY_MODEL='channel/model' npm run verify:deployment
```

同时设置 `DEPLOYMENT_BUSINESS_MODEL='channel/model'` 时，会使用容器已有的
`GATEWAY_API_KEY` 各执行一次固定任务的非流式和流式请求，只输出状态、正文长度、
content type 和响应字节数。脚本默认不会应用配置；只有经过批准后显式设置
`DEPLOYMENT_APPLY=1`，才会在发现 pending revision 时调用 runtime apply。
