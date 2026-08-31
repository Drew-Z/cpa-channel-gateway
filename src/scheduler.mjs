import crypto from 'node:crypto'
import { buildModelCatalog, compareCandidatePriority, compareCandidates } from './catalog.mjs'
import { circuitStatus, compareEvidence, emptyEvidence, normalizeEvidence, observeEvidence, successRate } from './candidate-evidence.mjs'
import { supportsStreaming } from './model-metadata.mjs'

const BLOCKED_CHANNEL_STATES = new Set(['auth-failed', 'payment-blocked'])
const RESTORABLE_CHANNEL_STATES = new Set(['healthy', 'degraded', 'auth-failed', 'payment-blocked', 'cooling'])

export class GatewayRoutingError extends Error {
  constructor(code, statusCode, message, details = {}) {
    super(message)
    this.name = 'GatewayRoutingError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

export class ChannelReservations {
  #active = new Map()

  isBusy(channelId) {
    return this.#active.has(channelId)
  }

  tryAcquire(channelId, metadata = {}) {
    if (this.#active.has(channelId)) return null
    const token = crypto.randomUUID()
    const reservation = {
      token,
      channelId,
      requestId: metadata.requestId ?? crypto.randomUUID(),
      requestedModel: metadata.requestedModel,
      upstreamModel: metadata.upstreamModel,
      source: metadata.source ?? 'production',
      startedAt: new Date().toISOString()
    }
    this.#active.set(channelId, reservation)
    let released = false
    return {
      reservation,
      release: () => {
        if (released) return false
        released = true
        if (this.#active.get(channelId)?.token !== token) return false
        this.#active.delete(channelId)
        return true
      }
    }
  }

  snapshot() {
    return [...this.#active.values()].map(item => ({ ...item }))
  }
}

export function createModelScheduler(config, {
  reservations = new ChannelReservations(),
  now = () => Date.now(),
  initialState = {},
  onStateChange = null
} = {}) {
  let catalog = buildModelCatalog(config)
  let validChannelIds = new Set(config.channels.map(channel => channel.id))
  let validCandidateKeys = new Set([...catalog.allModels.values()].flat().map(candidate => candidate.key))
  const channelState = restoreChannelState(initialState.channels, validChannelIds)
  const candidateState = restoreCandidateState(initialState.candidates, validCandidateKeys, now())
  const drainingChannels = new Set()
  const suppressedCandidates = new Set()
  const halfOpenCandidates = new Set()

  function reserve(modelId, metadata = {}) {
    const resolved = catalog.resolve(modelId)
    if (!resolved) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${modelId}`)
    clearExpiredCooldowns()
    const allowedChannels = metadata.allowedChannels instanceof Set ? metadata.allowedChannels : null
    const accessCandidates = allowedChannels
      ? resolved.candidates.filter(candidate => allowedChannels.has(candidate.channelId))
      : resolved.candidates
    if (!accessCandidates.length) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${modelId}`)
    const allowedKinds = Array.isArray(metadata.allowedKinds) && metadata.allowedKinds.length
      ? new Set(metadata.allowedKinds.map(value => String(value).trim().toLowerCase()))
      : null
    const kindCandidates = allowedKinds
      ? accessCandidates.filter(candidate => allowedKinds.has(candidate.kind))
      : accessCandidates
    if (!kindCandidates.length && allowedKinds) {
      throw new GatewayRoutingError('model_endpoint_mismatch', 422, `Model ${modelId} is not compatible with this endpoint`)
    }
    const requestedStreaming = metadata.streaming
    const modeCandidates = requestedStreaming
      ? kindCandidates.filter(candidate => supportsStreaming(candidate.model, requestedStreaming))
      : kindCandidates
    if (!modeCandidates.length && requestedStreaming) {
      throw new GatewayRoutingError('streaming_not_supported', 422, `No candidate supports ${requestedStreaming} requests for model: ${modelId}`, {
        requestedStreaming,
        candidateCount: resolved.candidates.length
      })
    }
    const eligible = modeCandidates.filter(candidate => isEligible(candidate, channelState, candidateState, drainingChannels, suppressedCandidates, halfOpenCandidates, now(), metadata.source ?? 'production'))
    if (!eligible.length) {
      throw new GatewayRoutingError('no_eligible_candidates', 503, `No eligible channel is available for model: ${modelId}`)
    }
    const ordered = [...eligible].sort((left, right) => {
      return healthRank(channelState.get(left.channelId)?.health) - healthRank(channelState.get(right.channelId)?.health)
        || compareCandidatePriority(left, right)
        || compareEvidence(candidateState.get(left.key)?.evidence, candidateState.get(right.key)?.evidence, now())
        || compareCandidates(left, right)
    })
    for (const candidate of ordered) {
      const lease = reservations.tryAcquire(candidate.channelId, {
        ...metadata,
        requestedModel: modelId,
        upstreamModel: candidate.upstreamModel
      })
      if (!lease) continue
      const circuit = circuitStatus(candidateState.get(candidate.key)?.evidence, now())
      if (circuit === 'half-open') {
        if (halfOpenCandidates.has(candidate.key)) {
          lease.release()
          continue
        }
        halfOpenCandidates.add(candidate.key)
      }
      return {
        ...lease,
        release: () => {
          halfOpenCandidates.delete(candidate.key)
          return lease.release()
        },
        candidate,
        resolved,
        halfOpen: circuit === 'half-open'
      }
    }
    throw new GatewayRoutingError('all_candidates_busy', 429, `All candidates are busy for model: ${modelId}`, {
      candidateCount: ordered.length
    })
  }

  function recordOutcome(selection, statusOrObservation, headers = {}) {
    if (!selection?.candidate || selection.outcomeRecorded) return false
    const candidate = selection.candidate
    const observation = normalizeObservation(statusOrObservation, headers)
    if (observation.kind === 'cancelled') {
      selection.outcomeRecorded = true
      halfOpenCandidates.delete(candidate.key)
      return true
    }
    const timestamp = now()
    const statusCode = observation.statusCode
    const previous = channelState.get(candidate.channelId) ?? { health: 'unknown' }
    if (statusCode >= 200 && statusCode < 300) {
      channelState.set(candidate.channelId, { health: 'healthy', updatedAt: timestamp })
    } else if (statusCode === 401 || statusCode === 403) {
      channelState.set(candidate.channelId, { health: 'auth-failed', lastStatusCode: statusCode, updatedAt: timestamp })
    } else if (statusCode === 402) {
      channelState.set(candidate.channelId, { health: 'payment-blocked', updatedAt: timestamp })
    } else if (statusCode === 429) {
      channelState.set(candidate.channelId, {
        health: 'cooling',
        cooldownUntil: retryAt(headers['retry-after'], timestamp),
        updatedAt: timestamp
      })
    } else if ([400, 404, 405, 422].includes(statusCode)) {
      const current = candidateState.get(candidate.key) ?? { updatedAt: timestamp }
      candidateState.set(candidate.key, { ...current, health: 'misconfigured', updatedAt: timestamp })
    } else if (statusCode >= 500 || observation.kind === 'transport-failure') {
      channelState.set(candidate.channelId, { ...previous, health: 'degraded', updatedAt: timestamp })
    }

    if (!candidate.key) {
      selection.outcomeRecorded = true
      notifyStateChange()
      return true
    }
    const current = candidateState.get(candidate.key) ?? { updatedAt: timestamp }
    const evidence = observeEvidence(current.evidence, observation, { now: timestamp })
    const next = { ...current, evidence, updatedAt: timestamp }
    if (statusCode >= 200 && statusCode < 300) delete next.health
    candidateState.set(candidate.key, next)
    selection.outcomeRecorded = true
    halfOpenCandidates.delete(candidate.key)
    notifyStateChange()
    return true
  }

  function recordTransportError(selection, durationMs) {
    if (!selection?.candidate) return false
    return recordOutcome(selection, { kind: 'transport-failure', transient: true, durationMs })
  }

  function reload(nextConfig, { initialState = {} } = {}) {
    if (reservations.snapshot().length) {
      throw new GatewayRoutingError('runtime_busy', 409, 'Cannot reload routing while requests are active')
    }
    catalog = buildModelCatalog(nextConfig)
    validChannelIds = new Set(nextConfig.channels.map(channel => channel.id))
    validCandidateKeys = new Set([...catalog.allModels.values()].flat().map(candidate => candidate.key))
    channelState.clear()
    candidateState.clear()
    for (const [channelId, value] of restoreChannelState(initialState.channels, validChannelIds)) channelState.set(channelId, value)
    for (const [candidateKey, value] of restoreCandidateState(initialState.candidates, validCandidateKeys, now())) candidateState.set(candidateKey, value)
    drainingChannels.clear()
    suppressedCandidates.clear()
    halfOpenCandidates.clear()
    notifyStateChange()
    return true
  }

  function drainChannel(channelId) {
    const id = String(channelId ?? '').trim()
    if (!validChannelIds.has(id) || drainingChannels.has(id)) return false
    drainingChannels.add(id)
    return true
  }

  function resumeChannel(channelId) {
    return drainingChannels.delete(String(channelId ?? '').trim())
  }

  function resetChannelHealth(channelId) {
    const id = String(channelId ?? '').trim()
    if (!validChannelIds.has(id)) return false
    const changed = channelState.delete(id)
    if (changed) notifyStateChange()
    return changed
  }

  function drainAll() {
    for (const channelId of validChannelIds) drainingChannels.add(channelId)
    return [...drainingChannels].sort()
  }

  function resumeAll() {
    drainingChannels.clear()
    return true
  }

  async function waitForIdle({ timeoutMs = 30_000, pollMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (reservations.snapshot().length) {
      if (Date.now() >= deadline) throw new GatewayRoutingError('drain_timeout', 409, 'Active requests did not finish before the runtime apply deadline')
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return true
  }

  function suppressCandidate(channelId, upstreamModel) {
    const matches = candidatesFor(channelId, upstreamModel)
    for (const candidate of matches) suppressedCandidates.add(candidate.key)
    return matches.length > 0
  }

  function resumeCandidate(channelId, upstreamModel) {
    const matches = candidatesFor(channelId, upstreamModel)
    for (const candidate of matches) suppressedCandidates.delete(candidate.key)
    return matches.length > 0
  }

  function evidenceFor(candidate) {
    const value = candidateState.get(candidate?.key)?.evidence
    return value ? normalizeEvidence(value, { now: now() }) : emptyEvidence()
  }

  function candidateStatus(candidate) {
    if (!candidate?.key || !validCandidateKeys.has(candidate.key)) {
      return { evidence: publicEvidence(emptyEvidence(), 'closed'), reasonCodes: ['configuration-pending-restart'] }
    }
    const timestamp = now()
    const evidence = evidenceFor(candidate)
    const circuit = circuitStatus(evidence, timestamp)
    const reasons = []
    const channel = channelState.get(candidate.channelId)
    if (candidate.channel.staged) reasons.push('staged-manual-only')
    if (drainingChannels.has(candidate.channelId)) reasons.push('channel-draining')
    if (suppressedCandidates.has(candidate.key)) reasons.push('configuration-pending-restart')
    if (reservations.isBusy(candidate.channelId)) reasons.push('channel-busy')
    if (channel?.health === 'auth-failed') reasons.push('channel-auth-failed')
    if (channel?.health === 'payment-blocked') reasons.push('channel-payment-blocked')
    if (channel?.health === 'cooling' && channel.cooldownUntil > timestamp) reasons.push('channel-cooling')
    if (candidateState.get(candidate.key)?.health === 'misconfigured') reasons.push('candidate-misconfigured')
    if (circuit === 'open') reasons.push('circuit-open')
    if (circuit === 'half-open') reasons.push(halfOpenCandidates.has(candidate.key) ? 'half-open-busy' : 'half-open-ready')
    if (!reasons.length) reasons.push('candidate-ready')
    return {
      evidence: publicEvidence(evidence, circuit),
      ...(channel?.lastStatusCode === 401 || channel?.lastStatusCode === 403 ? { lastStatusCode: channel.lastStatusCode } : {}),
      reasonCodes: reasons
    }
  }

  function candidatesFor(channelId, upstreamModel) {
    return [...catalog.allModels.values()].flat().filter(candidate => candidate.channelId === channelId && candidate.upstreamModel === upstreamModel)
  }

  function clearExpiredCooldowns() {
    const timestamp = now()
    let changed = false
    for (const [channelId, value] of channelState) {
      if (value.health === 'cooling' && value.cooldownUntil <= timestamp) {
        channelState.delete(channelId)
        changed = true
      }
    }
    if (changed) notifyStateChange()
  }

  function notifyStateChange() {
    if (typeof onStateChange !== 'function') return
    try {
      onStateChange({
        channels: Object.fromEntries(channelState),
        candidates: Object.fromEntries(candidateState)
      })
    } catch {}
  }

  return {
    get catalog() {
      return catalog
    },
    reservations,
    reserve,
    recordOutcome,
    recordTransportError,
    reload,
    drainChannel,
    resumeChannel,
    resetChannelHealth,
    drainAll,
    resumeAll,
    waitForIdle,
    suppressCandidate,
    resumeCandidate,
    isChannelDraining(channelId) {
      return drainingChannels.has(String(channelId ?? '').trim())
    },
    isCandidateSuppressed(channelId, upstreamModel) {
      return candidatesFor(channelId, upstreamModel).some(candidate => suppressedCandidates.has(candidate.key))
    },
    evidenceFor,
    candidateStatus,
    snapshot() {
      return {
        reservations: reservations.snapshot(),
        channels: Object.fromEntries(channelState),
        candidates: Object.fromEntries(candidateState),
        draining: [...drainingChannels].sort(),
        suppressedCandidates: [...suppressedCandidates].sort()
      }
    }
  }
}

function publicEvidence(evidence, circuit) {
  return {
    sampleCount: evidence.sampleCount,
    successCount: evidence.successCount,
    failureCount: evidence.failureCount,
    successRate: successRate(evidence),
    ewmaLatencyMs: evidence.ewmaLatencyMs,
    consecutiveTransientFailures: evidence.consecutiveTransientFailures,
    circuit,
    cooldownUntil: evidence.cooldownUntil
  }
}

function isEligible(candidate, channelState, candidateState, drainingChannels, suppressedCandidates, halfOpenCandidates, now, source) {
  if (candidate.channel.staged && source !== 'manual-test') return false
  if (drainingChannels.has(candidate.channelId) || suppressedCandidates.has(candidate.key)) return false
  const channel = channelState.get(candidate.channelId)
  if (BLOCKED_CHANNEL_STATES.has(channel?.health)) return false
  if (channel?.health === 'cooling' && channel.cooldownUntil > now) return false
  if (candidateState.get(candidate.key)?.health === 'misconfigured') return false
  const circuit = circuitStatus(candidateState.get(candidate.key)?.evidence, now)
  return circuit !== 'open' && !(circuit === 'half-open' && halfOpenCandidates.has(candidate.key))
}

function restoreChannelState(input, validChannelIds) {
  return new Map(Object.entries(objectValue(input)).flatMap(([channelId, value]) => {
    if (!validChannelIds.has(channelId) || !value || !RESTORABLE_CHANNEL_STATES.has(value.health)) return []
    if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return []
    if (value.health === 'cooling') {
      if (!Number.isSafeInteger(value.cooldownUntil) || value.cooldownUntil < 0) return []
      return [[channelId, { health: value.health, cooldownUntil: value.cooldownUntil, updatedAt: value.updatedAt }]]
    }
    const lastStatusCode = normalizeAuthStatusCode(value.lastStatusCode)
    return [[channelId, {
      health: value.health,
      ...(value.health === 'auth-failed' && lastStatusCode ? { lastStatusCode } : {}),
      updatedAt: value.updatedAt
    }]]
  }))
}

function normalizeAuthStatusCode(value) {
  return value === 401 || value === 403 ? value : null
}

function restoreCandidateState(input, validCandidateKeys, now) {
  return new Map(Object.entries(objectValue(input)).flatMap(([candidateKey, value]) => {
    if (!validCandidateKeys.has(candidateKey) || !value || typeof value !== 'object' || Array.isArray(value)) return []
    if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return []
    if (value.health !== undefined && value.health !== 'misconfigured') return []
    const result = { updatedAt: value.updatedAt }
    if (value.health !== undefined) result.health = value.health
    if (value.evidence !== undefined) result.evidence = normalizeEvidence(value.evidence, { now })
    return Object.keys(result).length > 1 ? [[candidateKey, result]] : []
  }))
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function healthRank(health) {
  if (health === 'healthy') return 0
  if (!health || health === 'unknown') return 1
  return 2
}

function retryAt(value, now) {
  const seconds = Number(Array.isArray(value) ? value[0] : value)
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000
  const date = Date.parse(Array.isArray(value) ? value[0] : value)
  if (Number.isFinite(date)) return Math.max(now, date)
  return now + 30_000
}

function normalizeObservation(value, headers = {}) {
  if (value && typeof value === 'object' && typeof value.kind === 'string') {
    return {
      kind: value.kind,
      transient: value.transient === true,
      durationMs: value.durationMs,
      statusCode: Number.isSafeInteger(value.statusCode) ? value.statusCode : null
    }
  }
  const statusCode = Number.isSafeInteger(value) ? value : null
  return {
    kind: statusCode >= 200 && statusCode < 300 ? 'success' : 'http-failure',
    transient: statusCode >= 500,
    durationMs: undefined,
    statusCode
  }
}
