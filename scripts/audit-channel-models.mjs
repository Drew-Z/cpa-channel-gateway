#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { loadConfig } from '../src/config.mjs'
import { extractCanaryContent } from '../src/canary.mjs'

const root = process.cwd()
const prompt = '请写一首四句七言绝句，主题是秋夜读书。只输出诗题和诗句。'
const timeoutMs = Number(process.env.CANARY_TIMEOUT_MS || 30_000)
const auditDir = path.join(root, 'runtime', 'model-audits')
const loaded = loadConfig(root, { allowEmptyEnabledChannels: true })
const results = []
const channelCooldowns = new Map()

for (const channel of loaded.channels.filter(item => item.runtimeEnabled || item.models.some(model => model.canaryEligible))) {
  for (const model of channel.models.filter(item => item.canaryEligible && item.status !== 'disabled')) {
    const availableAt = channelCooldowns.get(channel.id) ?? 0
    if (availableAt > Date.now()) await wait(availableAt - Date.now())
    const startedAt = Date.now()
    const protocol = normalizeProtocol(model.protocol || channel.protocol)
    try {
      const response = await sendCanary(channel, model.upstream, protocol)
      const latencyMs = Date.now() - startedAt
      const statusCode = response.statusCode
      const retryAfterMs = statusCode === 429 ? parseRetryAfter(response.headers['retry-after']) : 0
      if (retryAfterMs > 0) channelCooldowns.set(channel.id, Date.now() + retryAfterMs)
      let contentLength = 0
      let error = null
      if (statusCode >= 200 && statusCode < 300) {
        try {
          const parsed = JSON.parse(response.body)
          const content = extractCanaryContent(protocol, parsed)
          contentLength = typeof content === 'string' ? content.trim().length : 0
          if (contentLength < 8) error = 'empty_content'
        } catch {
          error = 'invalid_json'
        }
      } else {
        error = classify(statusCode)
      }
      record(summary(channel, model, protocol, statusCode, latencyMs, contentLength, error))
    } catch (error) {
      record(summary(channel, model, protocol, null, Date.now() - startedAt, 0, classifyTransport(error)))
    }
  }
}

const successfulChannels = [...new Set(results.filter(item => item.ok).map(item => item.channel))].sort()
const report = {
  schemaVersion: 1,
  testedAt: new Date().toISOString(),
  promptType: 'fixed-poem',
  totals: {
    tested: results.length,
    success: results.filter(item => item.ok).length,
    failure: results.filter(item => !item.ok).length
  },
  successfulChannels,
  results
}
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 })
const output = path.join(auditDir, `audit-${new Date().toISOString().replaceAll(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}.json`)
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ file: path.relative(root, output).replaceAll('\\', '/'), ...report.totals, successfulChannels }, null, 2))

function normalizeProtocol(value) {
  if (value === 'responses') return 'responses'
  if (value === 'claude') return 'claude'
  return 'chat'
}

function sendCanary(channel, model, protocol) {
  const target = new URL(channel.upstream)
  const requestPath = protocol === 'responses' ? '/v1/responses' : protocol === 'claude' ? '/v1/messages' : '/v1/chat/completions'
  const body = protocol === 'responses'
    ? { model, input: prompt, stream: false, max_output_tokens: 256 }
    : { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 256 }
  const payload = Buffer.from(JSON.stringify(body))
  const headers = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'user-agent': 'cpa-channel-gateway-canary/1.0'
  }
  if (protocol === 'claude') {
    headers['x-api-key'] = channel.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${channel.apiKey}`
  }
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    let timer
    const req = transport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: appendPath(target.pathname, requestPath),
      method: 'POST',
      headers
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size <= 4 * 1024 * 1024) chunks.push(chunk)
      })
      response.once('end', () => { clearTimeout(timer); resolve({ statusCode: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }) })
      response.once('error', error => { clearTimeout(timer); reject(error) })
    })
    timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    req.once('error', error => { clearTimeout(timer); reject(error) })
    req.end(payload)
  })
}

function appendPath(base, suffix) {
  const left = base === '/' ? '' : base.replace(/\/+$/, '')
  const right = left.endsWith('/v1') && suffix.startsWith('/v1/') ? suffix.slice(3) : suffix
  return `${left}${right}`
}

function parseRetryAfter(value) {
  const raw = Array.isArray(value) ? value[0] : value
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 300_000)
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? Math.min(Math.max(0, timestamp - Date.now()), 300_000) : 0
}

function classify(statusCode) {
  if (statusCode === 401 || statusCode === 403) return 'authentication_failed'
  if (statusCode === 402) return 'payment_blocked'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode >= 500) return 'upstream_server_error'
  if ([400, 404, 405, 422].includes(statusCode)) return 'protocol_or_path_error'
  return 'unexpected_status'
}

function classifyTransport(error) {
  return error?.code === 'ETIMEDOUT' || error?.message === 'timeout' ? 'timeout' : 'transport_error'
}

function summary(channel, model, protocol, statusCode, latencyMs, contentLength, error) {
  return {
    channel: channel.id,
    model: model.upstream,
    protocol,
    statusCode,
    latencyMs,
    contentLength,
    ok: !error,
    ...(error ? { error } : {})
  }
}

function record(item) {
  results.push(item)
  console.log(JSON.stringify({ channel: item.channel, model: item.model, ok: item.ok, statusCode: item.statusCode, latencyMs: item.latencyMs, ...(item.error ? { error: item.error } : {}) }))
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
