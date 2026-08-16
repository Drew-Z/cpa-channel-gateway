# Control State Persistence

网关把需要跨进程重启保留的低敏控制状态写入 Git 忽略的
`runtime/control-state.json`。该文件只用于恢复调度判断和管理台最近测活摘要，
不属于可编辑的路由配置，也不会进入内容寻址 release。

## Persisted data

只允许保存以下字段：

- 渠道健康状态、更新时间和尚未到期的 `cooldownUntil`。
- 精确渠道模型的 `misconfigured` 状态和更新时间。
- 最近最多 1000 个精确模型的测活结果摘要：成功/失败、HTTP 状态、协议、
  transport、延迟、测试时间，以及成功时的正文长度或失败时的分类码。
- 当前 release digest 和状态文件更新时间。

提示词、响应正文、HTTP 请求头、上游 URL、任何密钥、Cookie、会话令牌、
用户标识和 request ID 都不在允许字段中。写入前会按字段白名单重新构造对象，
调用方附带的其他字段会被丢弃。

## Lifetime

| 状态 | 恢复规则 |
| --- | --- |
| `healthy` / `degraded` | 超过 24 小时按 `unknown` 处理 |
| `cooling` | `cooldownUntil` 到期后删除 |
| `auth-failed` / `payment-blocked` | 相同 release 内保留 |
| candidate `misconfigured` | 相同 release 内保留 |
| 最近测活摘要 | release 改变后仍保留，但只保留当前配置中仍存在的精确模型 |

release digest 改变表示已加载的路由或生成配置改变。此时旧的渠道和 candidate
调度状态全部清空，避免旧协议或旧凭据错误继续阻断新配置；低敏测活摘要可以继续
帮助管理员了解最近一次人工验收，但它不自动证明新 release 可用。

## Failure behavior

状态文件使用临时文件和 rename 更新；目录权限请求为 `0700`，文件权限请求为
`0600`。文件损坏或路径不可写时，网关继续使用进程内状态并在管理 API 中报告
`controlState.storage: memory-fallback`。管理台会显示持久化退化提示。存储故障不得
改变业务请求、人工测活或渠道互斥结果；容器重启后内存状态会丢失。

`memory` 表示当前配置没有私有 routes 路径，通常只应出现在测试或只读示例环境；
正式部署应显示 `persistent`。不要手工把该文件复制到另一套配置，也不要提交到 Git。
