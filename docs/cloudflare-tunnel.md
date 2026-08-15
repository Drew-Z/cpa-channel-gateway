# Cloudflare Tunnel 部署

本方案通过容器内的 `cloudflared` 主动连接 Cloudflare，绕过 HidenCloud 的 HTTP 反向代理。公网只使用 Cloudflare 管理的 HTTPS 域名；Node 控制网关仍是唯一公网入口，CPA、HAProxy 与渠道端口只在容器回环地址上监听。

官方参考：

- [创建 remotely-managed Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
- [Error 524 与 Proxy Read Timeout](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)

## 1. 创建 Tunnel

1. 打开 Cloudflare Dashboard 的 **Zero Trust > Networks > Connectors > Cloudflare Tunnels**。
2. 选择 **Create a tunnel**，名称建议使用 `cpa-channel-gateway`。
3. 选择 `cloudflared` connector，并保留页面生成的 Tunnel Token。
4. 不要在聊天、截图、Git、翼龙启动参数或公开日志中展示 Token。

仓库会下载固定版本的 Linux ARM64/AMD64 `cloudflared` 并验证 SHA-256，因此不需要执行 Dashboard 提供的系统安装命令。

## 2. 添加 Published application

在 Tunnel 的 **Routes** 中添加 **Published application**：

| 字段 | 值 |
| --- | --- |
| Hostname | `anyway.biau.de5.net` |
| Path | 留空 |
| Service type | `HTTP` |
| Service URL | `http://127.0.0.1:24674` |

`24674` 必须与翼龙主 allocation 注入的 `SERVER_PORT` 一致。不要把服务地址写成 HidenCloud 公网域名，也不要在 Cloudflare Access 前置浏览器登录；Codex、Claude Code 等 API 客户端使用网关 Bearer key 鉴权。

## 3. 启用私密配置

只在 `config/channels.local.env` 中设置：

```dotenv
CLOUDFLARE_TUNNEL_ENABLED=true
CLOUDFLARE_TUNNEL_TOKEN=<dashboard-token>
```

覆盖上传到 `/home/container/config/channels.local.env` 后重启翼龙服务。Token 不进入内容寻址 release、CPA 配置或公开 Git 历史，只通过 `TUNNEL_TOKEN` 环境变量传给 cloudflared 子进程。

成功启动时，控制台应出现 cloudflared 已注册连接的日志，并最终输出：

```json
{"ready":true,"port":24674,"release":"...","cloudflareTunnel":true}
```

启动器会检查 cloudflared 的本地 `/ready` 端点。Tunnel 未连接、Token 无效或 cloudflared 异常退出时，整个服务会退出，让翼龙明确重启，而不是留下只有本地端口可用的半失效状态。

## 4. 验收与迁移

先验证不触发模型生成的目录请求：

```bash
curl -fsS -H 'Authorization: Bearer <gateway-key>' \
  'https://anyway.biau.de5.net/v1/models'
```

再按渠道逐个执行有实际语义的 canary。确认主、备用路由和流式行为后，更新客户端 Base URL，最后删除 HidenCloud 的旧 HTTP/HTTPS 反向代理。

Cloudflare Free/Pro 代理对 origin 未及时返回数据的请求仍有 Proxy Read Timeout；官方当前文档给出的默认值是 125 秒。Tunnel 改善域名、TLS 和对 HidenCloud openresty 的依赖，但不能把长时间无响应的非流式请求变成无限等待。编码模型应优先使用能够及时返回响应头并持续输出数据的 SSE 路由。

## 5. 回退

把私密配置改回：

```dotenv
CLOUDFLARE_TUNNEL_ENABLED=false
CLOUDFLARE_TUNNEL_TOKEN=
```

重新上传并重启即可回到 CPA+HAProxy 模式。确认回退后，再在 Cloudflare Dashboard 中禁用或删除 Published application/Tunnel；不要先删 Tunnel 再让启用状态的容器反复崩溃重启。
