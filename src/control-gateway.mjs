import crypto from 'node:crypto'
import http from 'node:http'
import { buildCanaryRequest, extractCanaryContent, normalizeCanaryProtocol } from './canary.mjs'
import { ConfigMutationError, createPrivateConfigManager } from './config-manager.mjs'
import { createModelScheduler, GatewayRoutingError } from './scheduler.mjs'

const API_PATHS = new Set(['/v1/responses', '/v1/chat/completions', '/v1/messages'])
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const ADMIN_TEST_COOLDOWN_MS = 5_000
const CANARY_PROMPT = '请写一首四句七言绝句，主题是秋夜读书。只输出诗题和诗句。'

export function createControlGateway(config, { scheduler = createModelScheduler(config) } = {}) {
  const maxRequestBytes = config.gateway.control.maxRequestBytes
  const cpaPort = config.gateway.internal.cpaPort
  const sessions = new Map()
  const lastTests = new Map()
  const lastTestStarted = new Map()
  const configManager = createPrivateConfigManager(config)
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      const statusCode = error instanceof GatewayRoutingError || error instanceof ConfigMutationError ? error.statusCode : error.statusCode ?? 500
      const code = error instanceof GatewayRoutingError || error instanceof ConfigMutationError ? error.code : error.code ?? 'internal_error'
      sendJson(response, statusCode, { error: { code, message: publicErrorMessage(error, statusCode) } }, {
        ...(code === 'all_candidates_busy' ? { 'retry-after': String(config.gateway.control.busyRetryAfterSeconds) } : {})
      })
    })
  })
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://gateway.local')
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ready: true })
      return
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      await handleAdminRequest(request, response, url)
      return
    }
    if (!isAuthorized(request, config.gatewayKey)) {
      sendJson(response, 401, { error: { code: 'invalid_api_key', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, { object: 'list', data: scheduler.catalog.listPublicModels() })
      return
    }
    if (request.method !== 'POST' || !API_PATHS.has(url.pathname)) {
      sendJson(response, 404, { error: { code: 'not_found', message: 'Route not found' } })
      return
    }

    const body = await readJsonBody(request, maxRequestBytes)
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!requestedModel) throw publicError('invalid_request', 400, 'Request body must include a model')
    const selection = scheduler.reserve(requestedModel, {
      requestId: request.headers['x-request-id'],
      source: 'production'
    })
    const transport = url.pathname === '/v1/responses' && selection.candidate.protocol === 'responses'
      ? 'native-passthrough'
      : 'adapted'
    const outboundBody = {
      ...body,
      model: transport === 'native-passthrough'
        ? selection.candidate.upstreamModel
        : selection.candidate.directAlias
    }
    await proxyRequest({ request, response, url, outboundBody, selection, transport })
  }

  async function handleAdminRequest(request, response, url) {
    if (!config.managementKey) {
      sendJson(response, 404, { error: { code: 'admin_disabled', message: 'Admin access is disabled' } })
      return
    }
    if (['/admin', '/admin/'].includes(url.pathname) && request.method === 'GET') {
      const nonce = crypto.randomBytes(18).toString('base64')
      sendHtml(response, adminHtml(nonce), nonce)
      return
    }
    if (url.pathname === '/admin/api/session' && request.method === 'POST') {
      await loginAdmin(request, response)
      return
    }
    const session = requireAdminSession(request)
    if (url.pathname === '/admin/api/session' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, csrfToken: session.csrfToken })
      return
    }
    if (url.pathname === '/admin/api/session' && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      sessions.delete(session.token)
      sendJson(response, 200, { ok: true }, {
        'set-cookie': 'cpa_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
      })
      return
    }
    if (url.pathname === '/admin/api/status' && request.method === 'GET') {
      sendJson(response, 200, adminStatus())
      return
    }
    if (url.pathname === '/admin/api/models' && request.method === 'GET') {
      sendJson(response, 200, { data: adminModels() })
      return
    }
    if (url.pathname === '/admin/api/config' && request.method === 'GET') {
      sendJson(response, 200, configManager?.status() ?? { revision: null, restartRequired: false, writable: false })
      return
    }
    if (url.pathname === '/admin/api/channels' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, maxRequestBytes)
      sendJson(response, 202, configManager.createChannel(body))
      return
    }
    const channelRoute = /^\/admin\/api\/channels\/([a-z][a-z0-9-]{0,31})$/.exec(url.pathname)
    if (channelRoute && request.method === 'PATCH') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, maxRequestBytes)
      sendJson(response, 202, configManager.updateChannel(channelRoute[1], body))
      return
    }
    if (channelRoute && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      requireConfigManager()
      if (scheduler.reservations.isBusy(channelRoute[1])) throw publicError('channel_busy', 409, 'A busy channel cannot be deleted')
      sendJson(response, 202, configManager.deleteChannel(channelRoute[1]))
      return
    }
    if (url.pathname === '/admin/api/tests' && request.method === 'POST') {
      requireAdminMutation(request, session)
      const body = await readJsonBody(request, maxRequestBytes)
      sendJson(response, 200, await runAdminTest(body))
      return
    }
    sendJson(response, 404, { error: { code: 'not_found', message: 'Admin route not found' } })
  }

  async function loginAdmin(request, response) {
    if (!config.managementKey) {
      sendJson(response, 404, { error: { code: 'admin_disabled', message: 'Admin access is disabled' } })
      return
    }
    const body = await readJsonBody(request, maxRequestBytes)
    const provided = typeof body.key === 'string' ? body.key : ''
    if (!safeEqual(provided, config.managementKey)) {
      sendJson(response, 401, { error: { code: 'invalid_management_key', message: 'Invalid management key' } })
      return
    }
    const token = crypto.randomBytes(32).toString('base64url')
    const csrfToken = crypto.randomBytes(24).toString('base64url')
    sessions.set(token, { token, csrfToken, expiresAt: Date.now() + ADMIN_SESSION_TTL_MS })
    sendJson(response, 200, { ok: true, csrfToken }, {
      'set-cookie': `cpa_admin=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`
    })
  }

  async function runAdminTest(body) {
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!requestedModel) throw publicError('invalid_request', 400, 'Test body must include a model')
    const resolved = scheduler.catalog.resolve(requestedModel)
    if (!resolved) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${requestedModel}`)
    if (resolved.kind !== 'direct') throw publicError('exact_model_required', 400, 'Manual tests require an exact channel/model id')
    const previousStartedAt = lastTestStarted.get(requestedModel) ?? 0
    if (Date.now() - previousStartedAt < ADMIN_TEST_COOLDOWN_MS) {
      throw publicError('test_rate_limited', 429, 'This model was tested too recently')
    }
    const selection = scheduler.reserve(requestedModel, { source: 'manual-test' })
    lastTestStarted.set(requestedModel, Date.now())
    const startedAt = Date.now()
    const protocol = normalizeCanaryProtocol(selection.candidate.protocol)
    const requestShape = buildCanaryRequest(protocol, selection.candidate.upstreamModel, CANARY_PROMPT)
    const transport = protocol === 'responses' && selection.candidate.protocol === 'responses'
      ? 'native-passthrough'
      : 'adapted'
    const outboundBody = {
      ...requestShape.body,
      model: transport === 'native-passthrough' ? selection.candidate.upstreamModel : selection.candidate.directAlias
    }
    try {
      let result
      try {
        result = await dispatchPayload({
          url: new URL(requestShape.path, 'http://gateway.local'),
          outboundBody,
          selection,
          transport,
          incomingHeaders: canaryHeaders(protocol)
        })
      } catch {
        return rememberTest(requestedModel, {
          ok: false,
          status: 'failed',
          error: 'transport_error',
          statusCode: null,
          protocol: selection.candidate.protocol,
          transport,
          latencyMs: Date.now() - startedAt
        })
      }
      scheduler.recordOutcome(selection, result.statusCode, result.headers)
      if (result.statusCode < 200 || result.statusCode >= 300) {
        return rememberTest(requestedModel, {
          ok: false,
          status: 'failed',
          error: classifyCanaryError(result.statusCode),
          statusCode: result.statusCode,
          protocol: selection.candidate.protocol,
          transport,
          latencyMs: Date.now() - startedAt
        })
      }
      let parsed
      try { parsed = JSON.parse(result.body) } catch { parsed = null }
      const content = extractCanaryContent(protocol, parsed)
      if (typeof content !== 'string' || content.trim().length < 8) {
        return rememberTest(requestedModel, {
          ok: false,
          status: 'failed',
          error: 'empty_content',
          statusCode: result.statusCode,
          protocol: selection.candidate.protocol,
          transport,
          latencyMs: Date.now() - startedAt
        })
      }
      return rememberTest(requestedModel, {
        ok: true,
        status: 'success',
        statusCode: result.statusCode,
        protocol: selection.candidate.protocol,
        transport,
        latencyMs: Date.now() - startedAt,
        contentLength: content.trim().length
      })
    } finally {
      selection.release()
    }
  }

  function dispatchPayload({ url, outboundBody, selection, transport, incomingHeaders }) {
    const payload = Buffer.from(JSON.stringify(outboundBody))
    const native = transport === 'native-passthrough'
    const target = native
      ? {
          host: config.gateway.internal.host,
          port: selection.candidate.channel.listener,
          path: `${appendPath(selection.candidate.channel.upstream.pathname, url.pathname === '/v1/responses' ? '/responses' : url.pathname)}${url.search}`,
          authorization: `Bearer ${selection.candidate.channel.apiKey}`
        }
      : {
          host: config.gateway.internal.host,
          port: cpaPort,
          path: `${url.pathname}${url.search}`,
          authorization: `Bearer ${config.gatewayKey}`
        }
    return new Promise((resolve, reject) => {
      const upstreamRequest = http.request({
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: forwardHeaders(incomingHeaders, payload.length, target.authorization)
      }, upstreamResponse => {
        const chunks = []
        let size = 0
        upstreamResponse.on('data', chunk => {
          size += chunk.length
          if (size > maxRequestBytes) {
            upstreamResponse.destroy(new Error('Canary response is too large'))
            return
          }
          chunks.push(chunk)
        })
        upstreamResponse.once('error', reject)
        upstreamResponse.once('end', () => resolve({
          statusCode: upstreamResponse.statusCode ?? 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }))
      })
      upstreamRequest.setTimeout(config.gateway.timeouts.serverSeconds * 1000, () => upstreamRequest.destroy(new Error('Upstream request timed out')))
      upstreamRequest.once('error', error => {
        scheduler.recordTransportError(selection)
        reject(error)
      })
      upstreamRequest.end(payload)
    })
  }

  function adminStatus() {
    const snapshot = scheduler.snapshot()
    return {
      ready: true,
      configRevision: config.gateway.schemaVersion,
      reservations: snapshot.reservations,
      lastTests: Object.fromEntries(lastTests),
      channels: config.channels.map(channel => ({
        id: channel.id,
        name: channel.name,
        enabled: channel.enabled,
        modelCount: channel.models.length,
        busy: snapshot.reservations.some(item => item.channelId === channel.id),
        health: snapshot.channels[channel.id]?.health ?? 'unknown',
        cooldownUntil: snapshot.channels[channel.id]?.cooldownUntil ?? null
      }))
    }
  }

  function rememberTest(modelId, result) {
    const summary = { ...result, testedAt: new Date().toISOString() }
    lastTests.set(modelId, summary)
    return summary
  }

  function adminModels() {
    return [...scheduler.catalog.logicalModels.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, candidates]) => ({
        id,
        candidates: candidates.map(candidate => ({
          channel: candidate.channelId,
          upstreamModel: candidate.upstreamModel,
          directId: candidate.directAlias,
          protocol: candidate.protocol,
          priority: candidate.priority,
          busy: scheduler.reservations.isBusy(candidate.channelId),
          lastTest: lastTests.get(candidate.directAlias) ?? null
        }))
      }))
  }

  function proxyRequest({ request, response, url, outboundBody, selection, transport }) {
    return new Promise(resolve => {
      const payload = Buffer.from(JSON.stringify(outboundBody))
      const native = transport === 'native-passthrough'
      const target = native
        ? {
            host: config.gateway.internal.host,
            port: selection.candidate.channel.listener,
            path: `${appendPath(selection.candidate.channel.upstream.pathname, '/responses')}${url.search}`,
            authorization: `Bearer ${selection.candidate.channel.apiKey}`
          }
        : {
            host: config.gateway.internal.host,
            port: cpaPort,
            path: `${url.pathname}${url.search}`,
            authorization: `Bearer ${config.gatewayKey}`
          }
      const headers = forwardHeaders(request.headers, payload.length, target.authorization)
      let completed = false
      let clientClosed = false
      let upstreamRequest
      const finish = () => {
        if (completed) return
        completed = true
        selection.release()
        resolve()
      }
      const onClientClose = () => {
        if (response.writableEnded) return
        clientClosed = true
        upstreamRequest?.destroy()
        finish()
      }
      response.once('close', onClientClose)

      upstreamRequest = http.request({
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers
      }, upstreamResponse => {
        scheduler.recordOutcome(selection, upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        const responseHeaders = filteredResponseHeaders(upstreamResponse.headers)
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.once('end', finish)
        upstreamResponse.once('close', finish)
        upstreamResponse.once('error', error => {
          if (!clientClosed) response.destroy(error)
          finish()
        })
        upstreamResponse.pipe(response)
      })
      upstreamRequest.setTimeout(config.gateway.timeouts.serverSeconds * 1000, () => {
        const error = new Error('Upstream request timed out')
        error.code = 'ETIMEDOUT'
        upstreamRequest.destroy(error)
      })
      upstreamRequest.once('error', error => {
        if (!clientClosed) {
          scheduler.recordTransportError(selection)
          if (!response.headersSent) sendJson(response, 502, { error: { code: 'upstream_unavailable', message: 'Upstream request failed' } })
          else response.destroy(error)
        }
        finish()
      })
      upstreamRequest.end(payload)
    })
  }

  return {
    server,
    scheduler,
    listen({ host = config.gateway.public.host, port } = {}) {
      const listenPort = port ?? Number(process.env[config.gateway.public.portEnv] || process.env.SERVER_PORT || process.env.PORT || config.gateway.public.defaultPort)
      return new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListening); reject(error) }
        const onListening = () => { server.removeListener('error', onError); resolve(server.address()) }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(listenPort, host)
      })
    },
    close() {
      if (!server.listening) return Promise.resolve()
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }

  function requireAdminSession(request) {
    const token = parseCookie(request.headers.cookie).cpa_admin
    const session = token ? sessions.get(token) : null
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token)
      throw publicError('admin_unauthorized', 401, 'Admin session is missing or expired')
    }
    return session
  }

  function requireAdminMutation(request, session) {
    if (!sameOrigin(request)) throw publicError('invalid_origin', 403, 'Admin request origin is not allowed')
    const csrf = request.headers['x-csrf-token']
    if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) throw publicError('invalid_csrf', 403, 'CSRF validation failed')
  }

  function requireConfigManager() {
    if (!configManager) throw new ConfigMutationError('configuration_not_writable', 503, 'Private configuration paths are not available')
  }
}

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    request.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        request.resume()
        reject(publicError('request_too_large', 413, 'Request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    request.once('aborted', () => {
      if (settled) return
      settled = true
      reject(publicError('client_aborted', 400, 'Client aborted the request'))
    })
    request.once('error', reject)
    request.once('end', () => {
      if (settled) return
      settled = true
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('body must be an object')
        resolve(value)
      } catch {
        reject(publicError('invalid_json', 400, 'Request body must be valid JSON'))
      }
    })
  })
}

function forwardHeaders(incoming, contentLength, authorization) {
  const connectionTokens = String(incoming.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set([
    ...HOP_BY_HOP,
    ...connectionTokens,
    'authorization',
    'x-api-key',
    'api-key',
    'host',
    'content-length',
    'content-encoding',
    'content-md5',
    'digest',
    'cookie'
  ])
  const headers = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (value === undefined || blocked.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('cf-')) continue
    headers[lower] = value
  }
  headers.authorization = authorization
  headers['content-length'] = String(contentLength)
  headers['content-type'] = headers['content-type'] ?? 'application/json'
  return headers
}

function filteredResponseHeaders(incoming) {
  const connectionTokens = String(incoming.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set([...HOP_BY_HOP, ...connectionTokens])
  return Object.fromEntries(Object.entries(incoming).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())))
}

function appendPath(basePath, suffix) {
  const base = basePath === '/' ? '' : basePath.replace(/\/+$/, '')
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${base}${path}` || '/'
}

function isAuthorized(request, expected) {
  const authorization = request.headers.authorization ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
  const provided = bearer ?? request.headers['x-api-key']
  if (typeof provided !== 'string') return false
  return safeEqual(provided, expected)
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ''))
  const right = Buffer.from(String(rightValue ?? ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function parseCookie(value = '') {
  return Object.fromEntries(value.split(';').map(item => item.trim().split('='))
    .filter(([name, content]) => name && content)
    .map(([name, ...content]) => [name, content.join('=')]))
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    const host = String(request.headers.host ?? '').toLowerCase()
    return parsed.host.toLowerCase() === host && ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function canaryHeaders(protocol) {
  return protocol === 'claude'
    ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': 'cpa-channel-gateway/1.0' }
    : { 'content-type': 'application/json', 'user-agent': 'cpa-channel-gateway/1.0' }
}

function classifyCanaryError(statusCode) {
  if (statusCode === 401 || statusCode === 403) return 'authentication_failed'
  if (statusCode === 402) return 'payment_blocked'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode >= 500) return 'upstream_server_error'
  if ([400, 404, 405, 422].includes(statusCode)) return 'protocol_or_path_error'
  return 'unexpected_status'
}

function sendHtml(response, html, nonce) {
  if (response.headersSent || response.destroyed) return
  const body = Buffer.from(html)
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  })
  response.end(body)
}

function adminHtml(nonce) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CPA Channel Gateway</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;background:#f5f7fb;color:#152033;margin:0}main{max-width:1100px;margin:2rem auto;padding:0 1rem}section{background:#fff;border:1px solid #dce3ef;border-radius:12px;padding:1rem;margin:1rem 0;box-shadow:0 2px 10px #1520330d}h1{font-size:1.35rem}button{border:0;border-radius:8px;padding:.6rem .9rem;background:#2458d6;color:#fff;cursor:pointer}input{padding:.6rem;border:1px solid #b8c3d5;border-radius:8px;width:min(100%,28rem)}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e8edf4;padding:.55rem;font-size:.9rem}.muted{color:#637089}.error{color:#b42318}.ok{color:#067647}.busy{color:#b54708}</style></head>
<body><main><h1>CPA Channel Gateway 管理台</h1><section id="login"><p class="muted">管理密钥只用于建立内存会话，重启后自动失效。</p><input id="key" type="password" autocomplete="current-password" placeholder="CPA_MANAGEMENT_KEY"><button id="loginButton">登录</button><p id="loginError" class="error"></p></section>
<section id="app" hidden><p><button id="refreshButton">刷新状态</button> <span id="summary" class="muted"></span></p><div id="channels"></div><h2>模型测活</h2><p class="muted">固定任务：生成一首秋夜读书七言绝句；只保存状态摘要，不保存诗词正文。</p><input id="model" placeholder="精确模型 ID，例如 free/gpt-4o"><button id="testButton">测试模型</button><p id="testResult"></p><h2>模型目录</h2><div id="models"></div></section></main>
<script nonce="${nonce}">
let csrf='';
const $=id=>document.getElementById(id);
async function call(path, options={}){const r=await fetch(path,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...(options.headers||{})}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error?.message||'请求失败');return data}
async function login(){try{const data=await call('/admin/api/session',{method:'POST',body:JSON.stringify({key:$('key').value})});csrf=data.csrfToken;$('login').hidden=true;$('app').hidden=false;await refresh()}catch(e){$('loginError').textContent=e.message}}
async function refresh(){try{const [status,models]=await Promise.all([call('/admin/api/status'),call('/admin/api/models')]);$('summary').textContent='当前预约 '+status.reservations.length+' 个';$('channels').innerHTML='<h2>渠道</h2><table><tr><th>渠道</th><th>状态</th><th>模型数</th><th>健康</th></tr>'+status.channels.map(c=>'<tr><td>'+esc(c.name)+' ('+esc(c.id)+')</td><td class="'+(c.busy?'busy':'')+'">'+(c.busy?'busy':'idle')+'</td><td>'+c.modelCount+'</td><td>'+esc(c.health)+'</td></tr>').join('')+'</table>';$('models').innerHTML='<table><tr><th>公开 ID</th><th>候选</th></tr>'+models.data.map(m=>'<tr><td>'+esc(m.id)+'</td><td>'+m.candidates.map(c=>esc(c.channel)+'/'+esc(c.upstreamModel)+' ['+esc(c.protocol)+(c.busy?', busy':'')+']').join('<br>')+'</td></tr>').join('')+'</table>'}catch(e){$('summary').textContent=e.message}}
async function testModel(){try{const data=await call('/admin/api/tests',{method:'POST',headers:{'x-csrf-token':csrf,'origin':location.origin},body:JSON.stringify({model:$('model').value})});$('testResult').className=data.ok?'ok':'error';$('testResult').textContent=JSON.stringify(data)}catch(e){$('testResult').className='error';$('testResult').textContent=e.message}finally{await refresh()}}
function esc(v){return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
$('loginButton').onclick=login;$('refreshButton').onclick=refresh;$('testButton').onclick=testModel;
</script></body></html>`
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.headersSent || response.destroyed) return
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders
  })
  response.end(body)
}

function publicError(code, statusCode, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function publicErrorMessage(error, statusCode) {
  if (statusCode >= 500 && !(error instanceof GatewayRoutingError)) return 'Internal gateway error'
  return error.message
}
