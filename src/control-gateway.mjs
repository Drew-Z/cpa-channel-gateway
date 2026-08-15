import crypto from 'node:crypto'
import http from 'node:http'
import { buildCanaryRequest, extractCanaryContent, normalizeCanaryProtocol } from './canary.mjs'
import { ConfigMutationError, createPrivateConfigManager } from './config-manager.mjs'
import { createModelScheduler, GatewayRoutingError } from './scheduler.mjs'
import { createUsageMonitor } from './usage-monitor.mjs'

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

export function createControlGateway(config, {
  scheduler = createModelScheduler(config),
  usageMonitor = createUsageMonitor(config)
} = {}) {
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
    let selection
    try {
      selection = scheduler.reserve(requestedModel, {
        requestId: request.headers['x-request-id'],
        source: 'production'
      })
    } catch (error) {
      if (error instanceof GatewayRoutingError && ['all_candidates_busy', 'no_eligible_candidates'].includes(error.code)) {
        const resolved = scheduler.catalog.resolve(requestedModel)
        usageMonitor.record({
          requestedModel,
          upstreamModel: resolved?.candidates[0]?.upstreamModel,
          outcome: 'failure',
          transport: 'unassigned'
        })
      }
      throw error
    }
    const transport = url.pathname === '/v1/responses' && selection.candidate.protocol === 'responses'
      ? 'native-passthrough'
      : 'adapted'
    const outboundBody = {
      ...body,
      model: transport === 'native-passthrough'
        ? selection.candidate.upstreamModel
        : selection.candidate.directAlias
    }
    await proxyRequest({ request, response, url, outboundBody, selection, transport, requestedModel })
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
    if (url.pathname === '/admin/api/usage' && request.method === 'GET') {
      sendJson(response, 200, usageMonitor.snapshot({ hours: 24 }))
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

  function proxyRequest({ request, response, url, outboundBody, selection, transport, requestedModel }) {
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
      const finish = outcome => {
        if (completed) return
        completed = true
        usageMonitor.record({
          requestedModel,
          channelId: selection.candidate.channelId,
          upstreamModel: selection.candidate.upstreamModel,
          outcome,
          transport
        })
        selection.release()
        resolve()
      }
      const onClientClose = () => {
        if (response.writableEnded) return
        clientClosed = true
        upstreamRequest?.destroy()
        finish('cancelled')
      }
      response.once('close', onClientClose)

      upstreamRequest = http.request({
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers
      }, upstreamResponse => {
        const statusCode = upstreamResponse.statusCode ?? 502
        scheduler.recordOutcome(selection, statusCode, upstreamResponse.headers)
        const responseHeaders = filteredResponseHeaders(upstreamResponse.headers)
        response.writeHead(statusCode, responseHeaders)
        upstreamResponse.once('end', () => finish(statusCode >= 200 && statusCode < 300 ? 'success' : 'failure'))
        upstreamResponse.once('close', () => finish('failure'))
        upstreamResponse.once('error', error => {
          if (!clientClosed) response.destroy(error)
          finish('failure')
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
        finish('failure')
      })
      upstreamRequest.end(payload)
    })
  }

  return {
    server,
    scheduler,
    usageMonitor,
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
<style nonce="${nonce}">*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#f5f7fb;color:#152033;margin:0}main{max-width:1100px;margin:2rem auto;padding:0 1rem}section{background:#fff;border:1px solid #dce3ef;border-radius:8px;padding:1rem;margin:1rem 0;box-shadow:0 2px 10px #1520330d}h1{font-size:1.35rem}h2{font-size:1.05rem;margin:1.25rem 0 .7rem}h3{font-size:.95rem;margin:1rem 0 .5rem}button{border:0;border-radius:8px;padding:.6rem .9rem;background:#2458d6;color:#fff;cursor:pointer}button.secondary{background:#526078}button:disabled{opacity:.6;cursor:wait}input,select{padding:.6rem;border:1px solid #b8c3d5;border-radius:8px;width:100%;min-width:0;background:#fff;color:inherit}.toolbar{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:.65rem;align-items:end}.toolbar label{display:grid;gap:.25rem;font-size:.8rem;color:#637089}.toolbar button{width:100%}#channels,#models,#usage{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e8edf4;padding:.55rem;font-size:.9rem;white-space:nowrap}.muted{color:#637089}.error{color:#b42318}.ok{color:#067647}.busy{color:#b54708}</style></head>
<body><main><h1>CPA Channel Gateway 管理台</h1><section id="login"><p class="muted">管理密钥只用于建立内存会话，重启后自动失效。</p><input id="key" type="password" autocomplete="current-password" placeholder="CPA_MANAGEMENT_KEY"><button id="loginButton">登录</button><p id="loginError" class="error"></p></section>
<section id="app" hidden><p><button id="refreshButton">刷新状态</button> <button id="logoutButton" class="secondary">退出</button> <span id="summary" class="muted"></span></p><div id="channels"></div><h2>最近 24 小时</h2><p class="muted">仅统计真实业务请求；管理台模型测活不计入。成功率按成功请求数除以全部请求数计算。</p><div id="usage"></div><h2>新增渠道</h2><form id="addChannelForm" class="toolbar"><label>渠道 ID<input id="channelId" required pattern="[a-z][a-z0-9-]{0,31}" maxlength="32" autocomplete="off"></label><label>名称<input id="channelName" required maxlength="80"></label><label>Base URL<input id="channelUrl" required type="url" autocomplete="url"></label><label>API key<input id="channelKey" required type="password" minlength="8" autocomplete="new-password"></label><label>协议<select id="channelProtocol"><option value="responses">responses</option><option value="openai-compatible">openai-compatible</option><option value="claude">claude</option></select></label><label>优先级<input id="channelPriority" required type="number" step="1" value="0"></label><button id="addChannelButton" type="submit">新增禁用渠道</button></form><p id="channelResult"></p><h2>模型测活</h2><div class="toolbar"><label>精确模型 ID<input id="model" placeholder="例如 free/gpt-4o" autocomplete="off"></label><button id="testButton" type="button">测试模型</button></div><p id="testResult"></p><h2>模型目录</h2><div id="models"></div></section></main>
<script nonce="${nonce}">
let csrf='';
const $=id=>document.getElementById(id);
async function call(path, options={}){const method=(options.method||'GET').toUpperCase();const headers={'content-type':'application/json',...(options.headers||{})};if(!['GET','HEAD','OPTIONS'].includes(method)&&csrf)headers['x-csrf-token']=csrf;const r=await fetch(path,{...options,mode:'same-origin',credentials:'same-origin',headers});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error?.message||'请求失败');return data}
async function login(){try{const data=await call('/admin/api/session',{method:'POST',body:JSON.stringify({key:$('key').value})});csrf=data.csrfToken;$('login').hidden=true;$('app').hidden=false;await refresh()}catch(e){$('loginError').textContent=e.message}}
async function refresh(){try{const [status,models,usage]=await Promise.all([call('/admin/api/status'),call('/admin/api/models'),call('/admin/api/usage')]);$('summary').textContent='当前预约 '+status.reservations.length+' 个；24 小时请求 '+usage.summary.total+' 次';$('channels').innerHTML='<h2>渠道</h2><table><tr><th>渠道</th><th>状态</th><th>模型数</th><th>健康</th><th>操作</th></tr>'+status.channels.map(c=>'<tr><td>'+esc(c.name)+' ('+esc(c.id)+')</td><td class="'+(c.busy?'busy':'')+'">'+(c.busy?'busy':'idle')+'</td><td>'+c.modelCount+'</td><td>'+esc(c.health)+'</td><td><button class="toggleChannel" data-id="'+esc(c.id)+'" data-enabled="'+(!c.enabled)+'">'+(c.enabled?'停用':'启用')+'</button> '+(c.enabled||c.busy?'':'<button class="deleteChannel secondary" data-id="'+esc(c.id)+'">删除</button>')+'</td></tr>').join('')+'</table>';$('usage').innerHTML=usageHtml(usage);$('models').innerHTML='<table><tr><th>公开 ID</th><th>候选</th></tr>'+models.data.map(m=>'<tr><td>'+esc(m.id)+'</td><td>'+m.candidates.map(c=>esc(c.channel)+'/'+esc(c.upstreamModel)+' ['+esc(c.protocol)+(c.busy?', busy':'')+']').join('<br>')+'</td></tr>').join('')+'</table>'}catch(e){$('summary').textContent=e.message}}
function usageHtml(data){const s=data.summary;const overall='<table><tr><th>请求</th><th>成功</th><th>失败</th><th>取消</th><th>成功率</th><th>存储</th></tr><tr><td>'+s.total+'</td><td>'+s.success+'</td><td>'+s.failure+'</td><td>'+s.cancelled+'</td><td>'+rate(s.successRate)+'</td><td>'+esc(data.storage)+'</td></tr></table>';if(!s.total)return overall+'<p class="muted">最近 24 小时还没有真实业务请求。</p>';const logical=data.logicalModels.length?'<h3>逻辑模型</h3>'+statsTable(data.logicalModels):'';const requested=data.models.length?'<h3>请求入口</h3>'+statsTable(data.models):'';const physical=data.physicalModels.length?'<h3>实际渠道模型</h3>'+statsTable(data.physicalModels):'';return overall+logical+requested+physical}
function statsTable(items){return '<table><tr><th>模型</th><th>请求</th><th>成功</th><th>失败</th><th>取消</th><th>成功率</th><th>最后请求</th></tr>'+items.map(item=>'<tr><td>'+esc(item.id)+'</td><td>'+item.total+'</td><td>'+item.success+'</td><td>'+item.failure+'</td><td>'+item.cancelled+'</td><td>'+rate(item.successRate)+'</td><td>'+esc(item.lastSeenAt||'-')+'</td></tr>').join('')+'</table>'}
function rate(value){return value===null?'—':value.toFixed(2)+'%'}
async function addChannel(){const button=$('addChannelButton');if(!$('addChannelForm').reportValidity())return;button.disabled=true;try{const data=await call('/admin/api/channels',{method:'POST',body:JSON.stringify({id:$('channelId').value,name:$('channelName').value,baseUrl:$('channelUrl').value,apiKey:$('channelKey').value,protocol:$('channelProtocol').value,priority:Number($('channelPriority').value)})});$('channelResult').className='ok';$('channelResult').textContent='已写入 revision '+data.revision+'，请重启应用后生效';$('channelKey').value='';await refresh()}catch(e){$('channelResult').className='error';$('channelResult').textContent=e.message}finally{button.disabled=false}}
async function toggleChannel(id,enabled){try{const data=await call('/admin/api/channels/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({enabled})});$('channelResult').className='ok';$('channelResult').textContent='已写入 revision '+data.revision+'，请重启应用后生效';await refresh()}catch(e){$('channelResult').className='error';$('channelResult').textContent=e.message}}
async function deleteChannel(id){if(!confirm('确认删除 '+id+'？'))return;try{const data=await call('/admin/api/channels/'+encodeURIComponent(id),{method:'DELETE'});$('channelResult').className='ok';$('channelResult').textContent='已删除 revision '+data.revision+'，请重启应用后生效';await refresh()}catch(e){$('channelResult').className='error';$('channelResult').textContent=e.message}}
async function testModel(){try{const data=await call('/admin/api/tests',{method:'POST',body:JSON.stringify({model:$('model').value})});$('testResult').className=data.ok?'ok':'error';$('testResult').textContent=JSON.stringify(data)}catch(e){$('testResult').className='error';$('testResult').textContent=e.message}finally{await refresh()}}
async function logout(){try{await call('/admin/api/session',{method:'DELETE'})}finally{csrf='';$('app').hidden=true;$('login').hidden=false}}
function esc(v){return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
$('loginButton').onclick=login;$('refreshButton').onclick=refresh;$('logoutButton').onclick=logout;$('addChannelForm').onsubmit=e=>{e.preventDefault();addChannel()};$('testButton').onclick=testModel;$('channels').onclick=e=>{const toggle=e.target.closest('.toggleChannel');const remove=e.target.closest('.deleteChannel');if(toggle)toggleChannel(toggle.dataset.id,toggle.dataset.enabled==='true');if(remove)deleteChannel(remove.dataset.id)};
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
