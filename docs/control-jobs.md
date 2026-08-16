# Control Jobs and Draining

所有会写入私有渠道配置或同步模型目录的管理操作都经过同一个内存 FIFO
控制作业队列。队列覆盖渠道新增/导入/编辑/删除、模型状态、稳定别名和模型同步；
同一时刻最多执行一个作业，后续请求等待前一个作业结束。队列满时返回
`429 control_queue_full`，不会偷偷丢弃或并发执行配置写入。

`GET /admin/api/status` 返回低敏的 `controlJobs`：当前作业、等待数量和最近作业的
类型、状态、时间以及分类错误码。作业 ID 不包含配置内容。失败状态只保留安全错误码和
HTTP 状态，不保存异常正文、URL、API key 或上游响应。

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
