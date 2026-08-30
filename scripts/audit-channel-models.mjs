#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../src/config.mjs'

const root = process.cwd()
const auditDir = path.join(root, 'runtime', 'model-audits')
const loaded = loadConfig(root, { allowEmptyEnabledChannels: true })
if (!loaded.managementKey) throw new Error('CPA_MANAGEMENT_KEY is required for gateway-backed channel audit')
const gatewayOrigin = new URL(process.env.GATEWAY_BASE_URL || `http://127.0.0.1:${Number(process.env.SERVER_PORT || process.env.PORT || loaded.gateway.public.defaultPort)}`).origin
const adminSession = await loginAdmin(gatewayOrigin, loaded.managementKey)
const resumePath = process.env.CANARY_AUDIT_RESUME
const resumed = resumePath ? loadResumeReport(resumePath) : null
const results = resumed?.results.filter(isTerminalAuditResult) ?? []
const completed = new Set(results.map(item => `${item.channel}\0${item.model}\0${item.protocol}`))

for (const channel of loaded.channels.filter(item => item.runtimeEnabled || item.staged)) {
  for (const model of channel.models.filter(item => item.canaryEligible && item.status !== 'disabled')) {
    const configuredProtocol = model.protocol ?? channel.protocol
    if (completed.has(`${channel.id}\0${model.upstream}\0${configuredProtocol}`)) continue
    const startedAt = Date.now()
    try {
      const tested = await testModel(gatewayOrigin, adminSession, `${channel.id}/${model.upstream}`)
      record({
        channel: channel.id,
        model: model.upstream,
        protocol: tested.protocol ?? model.protocol ?? channel.protocol,
        configuredProtocol: tested.configuredProtocol ?? model.protocol ?? channel.protocol,
        statusCode: tested.statusCode ?? null,
        latencyMs: tested.latencyMs ?? Date.now() - startedAt,
        contentLength: tested.contentLength ?? 0,
        ok: tested.ok === true,
        ...(tested.error ? { error: tested.error } : {}),
        ...(tested.diagnostics ? { diagnostics: tested.diagnostics } : {})
      })
    } catch (error) {
      if (['channel_cooling', 'all_candidates_busy', 'candidate_unavailable', 'restart_required'].includes(error?.code)) {
        console.log(JSON.stringify({ channel: channel.id, model: model.upstream, skipped: true, reason: error.code }))
        break
      }
      record({
        channel: channel.id,
        model: model.upstream,
        protocol: model.protocol ?? channel.protocol,
        configuredProtocol: model.protocol ?? channel.protocol,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        contentLength: 0,
        ok: false,
        error: error?.code ?? 'transport_error'
      })
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
  ...(resumePath ? { resumed: true } : {}),
  results
}
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 })
const output = path.join(auditDir, `audit-${new Date().toISOString().replaceAll(/[-:.]/g, '').replace('T', 'T').replace('Z', 'Z')}.json`)
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ file: path.relative(root, output).replaceAll('\\', '/'), ...report.totals, successfulChannels }, null, 2))

async function loginAdmin(origin, managementKey) {
  const response = await fetch(`${origin}/admin/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ key: managementKey })
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.message ?? `Admin login failed: HTTP ${response.status}`)
  const cookie = String(response.headers.get('set-cookie') ?? '').split(';', 1)[0]
  if (!cookie) throw new Error('Admin login did not return a session cookie')
  if (!data.csrfToken) throw new Error('Admin login did not return a CSRF token')
  return { cookie, csrfToken: data.csrfToken }
}

async function testModel(origin, session, model) {
  const response = await fetch(`${origin}/admin/api/tests`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      cookie: session.cookie,
      'x-csrf-token': session.csrfToken
    },
    body: JSON.stringify({ model })
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error?.message ?? `Gateway canary failed: HTTP ${response.status}`)
    error.code = data.error?.code ?? 'gateway_canary_error'
    throw error
  }
  return data
}

function record(item) {
  results.push(item)
  if (isTerminalAuditResult(item)) completed.add(`${item.channel}\0${item.model}\0${item.protocol}`)
  console.log(JSON.stringify({ channel: item.channel, model: item.model, ok: item.ok, statusCode: item.statusCode, latencyMs: item.latencyMs, ...(item.error ? { error: item.error } : {}) }))
}

function loadResumeReport(filePath) {
  const report = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'))
  if (!report || !Array.isArray(report.results)) throw new Error('CANARY_AUDIT_RESUME must reference a valid audit report')
  return report
}

function isTerminalAuditResult(item) {
  return item?.ok === true || [
    'authentication_failed',
    'payment_blocked',
    'protocol_or_path_error',
    'invalid_json',
    'empty_body',
    'empty_content',
    'missing_choices',
    'content_null',
    'reasoning_only',
    'structured_content_unsupported',
    'refusal_or_tool_call',
    'short_content'
  ].includes(item?.error)
}
