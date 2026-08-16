import crypto from 'node:crypto'
import { buildModelCatalog, compareCandidates } from './catalog.mjs'
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
  const catalog = buildModelCatalog(config)
  const validChannelIds = new Set(config.channels.map(channel => channel.id))
  const validCandidateKeys = new Set([...catalog.allModels.values()].flat().map(candidate => candidate.key))
  const channelState = restoreChannelState(initialState.channels, validChannelIds)
  const candidateState = restoreCandidateState(initialState.candidates, validCandidateKeys)

  function reserve(modelId, metadata = {}) {
    const resolved = catalog.resolve(modelId)
    if (!resolved) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${modelId}`)
    clearExpiredCooldowns()
    const requestedStreaming = metadata.streaming
    const modeCandidates = requestedStreaming
      ? resolved.candidates.filter(candidate => supportsStreaming(candidate.model, requestedStreaming))
      : resolved.candidates
    if (!modeCandidates.length && requestedStreaming) {
      throw new GatewayRoutingError('streaming_not_supported', 422, `No candidate supports ${requestedStreaming} requests for model: ${modelId}`, {
        requestedStreaming,
        candidateCount: resolved.candidates.length
      })
    }
    const eligible = modeCandidates.filter(candidate => isEligible(candidate, channelState, candidateState, now(), metadata.source ?? 'production'))
    if (!eligible.length) {
      throw new GatewayRoutingError('no_eligible_candidates', 503, `No eligible channel is available for model: ${modelId}`)
    }
    const ordered = [...eligible].sort((left, right) => {
      return healthRank(channelState.get(left.channelId)?.health) - healthRank(channelState.get(right.channelId)?.health)
        || compareCandidates(left, right)
    })
    for (const candidate of ordered) {
      const lease = reservations.tryAcquire(candidate.channelId, {
        ...metadata,
        requestedModel: modelId,
        upstreamModel: candidate.upstreamModel
      })
      if (lease) return { ...lease, candidate, resolved }
    }
    throw new GatewayRoutingError('all_candidates_busy', 429, `All candidates are busy for model: ${modelId}`, {
      candidateCount: ordered.length
    })
  }

  function recordOutcome(selection, statusCode, headers = {}) {
    const candidate = selection.candidate
    const previous = channelState.get(candidate.channelId) ?? { health: 'unknown' }
    if (statusCode >= 200 && statusCode < 300) {
      channelState.set(candidate.channelId, { health: 'healthy', updatedAt: now() })
      candidateState.delete(candidate.key)
      notifyStateChange()
      return
    }
    if (statusCode === 401 || statusCode === 403) {
      channelState.set(candidate.channelId, { health: 'auth-failed', updatedAt: now() })
    } else if (statusCode === 402) {
      channelState.set(candidate.channelId, { health: 'payment-blocked', updatedAt: now() })
    } else if (statusCode === 429) {
      channelState.set(candidate.channelId, {
        health: 'cooling',
        cooldownUntil: retryAt(headers['retry-after'], now()),
        updatedAt: now()
      })
    } else if ([400, 404, 405, 422].includes(statusCode)) {
      candidateState.set(candidate.key, { health: 'misconfigured', updatedAt: now() })
    } else if (statusCode >= 500) {
      channelState.set(candidate.channelId, { ...previous, health: 'degraded', updatedAt: now() })
    } else {
      return
    }
    notifyStateChange()
  }

  function recordTransportError(selection) {
    channelState.set(selection.candidate.channelId, { health: 'degraded', updatedAt: now() })
    notifyStateChange()
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
    catalog,
    reservations,
    reserve,
    recordOutcome,
    recordTransportError,
    snapshot() {
      return {
        reservations: reservations.snapshot(),
        channels: Object.fromEntries(channelState),
        candidates: Object.fromEntries(candidateState)
      }
    }
  }
}

function isEligible(candidate, channelState, candidateState, now, source) {
  if (candidate.channel.staged && source !== 'manual-test') return false
  const channel = channelState.get(candidate.channelId)
  if (BLOCKED_CHANNEL_STATES.has(channel?.health)) return false
  if (channel?.health === 'cooling' && channel.cooldownUntil > now) return false
  return candidateState.get(candidate.key)?.health !== 'misconfigured'
}

function restoreChannelState(input, validChannelIds) {
  return new Map(Object.entries(objectValue(input)).flatMap(([channelId, value]) => {
    if (!validChannelIds.has(channelId) || !value || !RESTORABLE_CHANNEL_STATES.has(value.health)) return []
    if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return []
    if (value.health === 'cooling') {
      if (!Number.isSafeInteger(value.cooldownUntil) || value.cooldownUntil < 0) return []
      return [[channelId, { health: value.health, cooldownUntil: value.cooldownUntil, updatedAt: value.updatedAt }]]
    }
    return [[channelId, { health: value.health, updatedAt: value.updatedAt }]]
  }))
}

function restoreCandidateState(input, validCandidateKeys) {
  return new Map(Object.entries(objectValue(input)).flatMap(([candidateKey, value]) => {
    if (!validCandidateKeys.has(candidateKey) || value?.health !== 'misconfigured') return []
    if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) return []
    return [[candidateKey, { health: value.health, updatedAt: value.updatedAt }]]
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
