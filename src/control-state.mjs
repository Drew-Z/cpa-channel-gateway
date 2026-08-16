import fs from 'node:fs'
import path from 'node:path'

const VERSION = 1
const DEFAULT_HEALTH_STALE_MS = 24 * 60 * 60 * 1000
const MAX_LAST_TESTS = 1_000
const CHANNEL_HEALTH = new Set(['healthy', 'degraded', 'auth-failed', 'payment-blocked', 'cooling'])
const CANDIDATE_HEALTH = new Set(['misconfigured'])
const TEST_STATUS = new Set(['success', 'failed'])
const TEST_PROTOCOLS = new Set(['responses', 'openai-compatible', 'claude'])
const TEST_TRANSPORTS = new Set(['native-passthrough', 'adapted'])

export function createControlState(config, {
  filePath = defaultFilePath(config),
  now = () => Date.now(),
  healthStaleMs = DEFAULT_HEALTH_STALE_MS
} = {}) {
  const configRevision = typeof config.digest === 'string' ? config.digest : null
  const validChannels = new Set(config.channels?.map(channel => channel.id) ?? [])
  const validCandidates = new Set((config.channels ?? []).flatMap(channel => (channel.models ?? []).map(model => (
    `${channel.id}\0${model.upstream}\0${model.protocol ?? channel.protocol}`
  ))))
  const validModels = new Set((config.channels ?? []).flatMap(channel => (channel.models ?? []).map(model => `${channel.id}/${model.upstream}`)))
  let writable = Boolean(filePath)
  let state = emptyState(configRevision, now())

  if (filePath && fs.existsSync(filePath)) load()

  return {
    schedulerState() {
      return cloneSchedulerState(state)
    },
    lastTests() {
      return structuredClone(state.lastTests)
    },
    replaceSchedulerState(input) {
      state.channels = normalizeChannels(input?.channels, { now: now(), healthStaleMs, validChannels })
      state.candidates = normalizeCandidates(input?.candidates, validCandidates)
      persist()
      return true
    },
    rememberTest(modelId, input) {
      const normalized = normalizeLastTest(modelId, input, validModels)
      if (!normalized) return false
      state.lastTests[modelId] = normalized
      const entries = Object.entries(state.lastTests)
        .sort((left, right) => Date.parse(right[1].testedAt) - Date.parse(left[1].testedAt))
        .slice(0, MAX_LAST_TESTS)
      state.lastTests = Object.fromEntries(entries)
      persist()
      return true
    },
    status() {
      return {
        storage: !filePath ? 'memory' : writable ? 'persistent' : 'memory-fallback',
        configRevision: state.configRevision,
        updatedAt: state.updatedAt
      }
    }
  }

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed?.v !== VERSION) throw new Error('Unsupported control state version')
      const timestamp = now()
      state = {
        v: VERSION,
        configRevision,
        updatedAt: validIsoTimestamp(parsed.updatedAt) ?? new Date(timestamp).toISOString(),
        channels: parsed.configRevision === configRevision
          ? normalizeChannels(parsed.channels, { now: timestamp, healthStaleMs, validChannels })
          : {},
        candidates: parsed.configRevision === configRevision
          ? normalizeCandidates(parsed.candidates, validCandidates)
          : {},
        lastTests: normalizeLastTests(parsed.lastTests, validModels)
      }
      if (parsed.configRevision !== configRevision || JSON.stringify(parsed) !== JSON.stringify(state)) persist()
    } catch {
      state = emptyState(configRevision, now())
      writable = false
    }
  }

  function persist() {
    state.updatedAt = new Date(now()).toISOString()
    if (!filePath || !writable) return
    const temporary = `${filePath}.tmp-${process.pid}`
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      fs.renameSync(temporary, filePath)
    } catch {
      writable = false
      try { fs.rmSync(temporary, { force: true }) } catch {}
    }
  }
}

function emptyState(configRevision, timestamp) {
  return {
    v: VERSION,
    configRevision,
    updatedAt: new Date(timestamp).toISOString(),
    channels: {},
    candidates: {},
    lastTests: {}
  }
}

function normalizeChannels(input, { now, healthStaleMs, validChannels }) {
  const result = []
  for (const [channelId, value] of Object.entries(objectValue(input))) {
    if (!validChannels.has(channelId) || !value || !CHANNEL_HEALTH.has(value.health)) continue
    const updatedAt = nonNegativeInteger(value.updatedAt)
    if (updatedAt === null) continue
    if (['healthy', 'degraded'].includes(value.health) && updatedAt < now - healthStaleMs) continue
    if (value.health === 'cooling') {
      const cooldownUntil = nonNegativeInteger(value.cooldownUntil)
      if (cooldownUntil === null || cooldownUntil <= now) continue
      result.push([channelId, { health: value.health, cooldownUntil, updatedAt }])
      continue
    }
    result.push([channelId, { health: value.health, updatedAt }])
  }
  return Object.fromEntries(result)
}

function normalizeCandidates(input, validCandidates) {
  return Object.fromEntries(Object.entries(objectValue(input)).flatMap(([candidateKey, value]) => {
    if (!validCandidates.has(candidateKey) || !value || !CANDIDATE_HEALTH.has(value.health)) return []
    const updatedAt = nonNegativeInteger(value.updatedAt)
    return updatedAt === null ? [] : [[candidateKey, { health: value.health, updatedAt }]]
  }))
}

function normalizeLastTests(input, validModels) {
  return Object.fromEntries(Object.entries(objectValue(input)).flatMap(([modelId, value]) => {
    const normalized = normalizeLastTest(modelId, value, validModels)
    return normalized ? [[modelId, normalized]] : []
  }).sort((left, right) => Date.parse(right[1].testedAt) - Date.parse(left[1].testedAt)).slice(0, MAX_LAST_TESTS))
}

function normalizeLastTest(modelId, input, validModels) {
  if (!validModels.has(modelId) || !input || typeof input !== 'object') return null
  const status = String(input.status ?? '')
  const protocol = String(input.protocol ?? '')
  const transport = String(input.transport ?? '')
  const testedAt = validIsoTimestamp(input.testedAt)
  const latencyMs = nonNegativeInteger(input.latencyMs)
  if (!TEST_STATUS.has(status) || !TEST_PROTOCOLS.has(protocol) || !TEST_TRANSPORTS.has(transport) || !testedAt || latencyMs === null) return null
  const ok = status === 'success'
  const statusCode = input.statusCode === null ? null : boundedInteger(input.statusCode, 100, 599)
  if (statusCode === undefined) return null
  const result = { ok, status, statusCode, protocol, transport, latencyMs, testedAt }
  if (ok) {
    const contentLength = boundedInteger(input.contentLength, 0, 1_000_000_000)
    if (contentLength === undefined) return null
    result.contentLength = contentLength
  } else {
    const error = String(input.error ?? '')
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(error)) return null
    result.error = error
  }
  return result
}

function cloneSchedulerState(state) {
  return {
    channels: structuredClone(state.channels),
    candidates: structuredClone(state.candidates)
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function defaultFilePath(config) {
  const routesPath = config.paths?.routesPath
  if (!routesPath) return null
  return path.join(path.dirname(path.dirname(routesPath)), 'runtime', 'control-state.json')
}
