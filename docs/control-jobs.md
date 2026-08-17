# Control Jobs and Draining

所有会写入私有渠道配置或同步模型目录的管理操作都经过同一个内存 FIFO
控制作业队列。队列覆盖渠道新增/导入/编辑/删除、模型状态、稳定别名、模型同步、
runtime apply、revision rollback 和 revision prune；
同一时刻最多执行一个作业，后续请求等待前一个作业结束。队列满时返回
`429 control_queue_full`，不会偷偷丢弃或并发执行配置写入。

`GET /admin/api/status` 返回低敏的 `controlJobs`：当前作业、等待数量和最近作业的
类型、状态、时间以及分类错误码。作业 ID 不包含配置内容。失败状态只保留安全错误码和
HTTP 状态，不保存异常正文、URL、API key 或上游响应。

每个已完成作业还会向 `runtime/audit-events.jsonl` 写入一条有界白名单事件：job ID、
操作、成功/失败、revision、耗时和分类错误码。`GET /admin/api/audit-events` 只向已认证
管理员返回这些字段。审计写入失败时作业结果不受影响，状态会退化为 `memory-fallback`。

## Pending restart drain

当管理员把当前渠道停用、设为待测试或删除时，网关会立即把该渠道标记为“排空中”，
停止新的生产预约；已经取得渠道租约的请求仍继续到正常结束。禁用精确模型时只临时
抑制该模型候选，同一渠道的其他模型仍可使用。重新启用或恢复模型会解除当前进程的
临时抑制。

排空标记是内存状态，不写入 `runtime/control-state.json`。正式启动脚本提供
`POST /admin/api/runtime/apply`：它会生成并校验新 release，排空在途请求，停止旧的
CPA/HAProxy 子进程，等待新进程 readiness，然后切换父 Node 路由和 active release。
任何启动或切换失败都会重启旧 release，并恢复旧的父路由。没有运行时监督器的测试/只读
进程仍会报告 apply 不可用，此时按传统流程重启容器。

## Revision rollback

`GET /admin/api/revisions` 返回有限 manifest 历史，
`GET /admin/api/revisions/<revision>/diff` 返回结构化脱敏差异。URL 和 API key 只返回
`baseUrlChanged` / `apiKeyReplaced` 布尔标志，不返回值。

`POST /admin/api/revisions/<revision>/rollback` 必须携带与路径完全一致的
`confirmRevision`，并通过同源和 CSRF 检查。作业先校验目标快照 digest，再保存新的
`runtime-rollback` revision，随后复用 runtime apply 的排空、生成、readiness、reload 和
activate 流程。成功后才更新 loaded revision；任何运行时错误都会恢复回滚前私有快照，
而 runtime manager 负责恢复旧 release。损坏 revision 在写入私有配置前即被拒绝。

## Revision pruning

`GET /admin/api/status` 中的 `revisionStorage` 返回 revision 总数、有效/损坏数量、总字节数、
时间范围和保留 20/50/100 份时的预计可删除数量与字节数。它不会返回快照内容或服务器路径。

`POST /admin/api/revisions/prune` 只接受 20、50 或 100，并要求 `keep` 与 `confirmKeep`
完全一致，同时通过同源和 CSRF 检查。整理作业进入同一 FIFO；最新的有效 revision 尾部、
当前 loaded revision 和 pending revision 始终受保护，其余过旧或损坏的 revision 会被删除，
删除后不能从管理台恢复。整理只允许管理员显式发起，不在启动、部署验收或后台任务中自动执行。
