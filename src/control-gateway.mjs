import crypto from 'node:crypto'
import http from 'node:http'
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

export function createControlGateway(config, { scheduler = createModelScheduler(config) } = {}) {
  const maxRequestBytes = config.gateway.control.maxRequestBytes
  const cpaPort = config.gateway.internal.cpaPort
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      const statusCode = error instanceof GatewayRoutingError ? error.statusCode : error.statusCode ?? 500
      const code = error instanceof GatewayRoutingError ? error.code : error.code ?? 'internal_error'
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
  return `${base}${suffix}` || '/'
}

function isAuthorized(request, expected) {
  const authorization = request.headers.authorization ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
  const provided = bearer ?? request.headers['x-api-key']
  if (typeof provided !== 'string') return false
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.headersSent || response.destroyed) return
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
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
