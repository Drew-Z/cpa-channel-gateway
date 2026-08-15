import crypto from 'node:crypto'
import { buildModelCatalog, compareCandidates } from './catalog.mjs'

const BLOCKED_CHANNEL_STATES = new Set(['auth-failed', 'payment-blocked'])

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

export function createModelScheduler(config, { reservations = new ChannelReservations(), now = () => Date.now() } = {}) {
  const catalog = buildModelCatalog(config)
  const channelState = new Map()
  const candidateState = new Map()

  function reserve(modelId, metadata = {}) {
    const resolved = catalog.resolve(modelId)
    if (!resolved) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${modelId}`)
    const eligible = resolved.candidates.filter(candidate => isEligible(candidate, channelState, candidateState, now()))
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
    } else if ([404, 405].includes(statusCode)) {
      candidateState.set(candidate.key, { health: 'misconfigured', updatedAt: now() })
    } else if (statusCode >= 500) {
      channelState.set(candidate.channelId, { ...previous, health: 'degraded', updatedAt: now() })
    }
  }

  function recordTransportError(selection) {
    channelState.set(selection.candidate.channelId, { health: 'degraded', updatedAt: now() })
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

function isEligible(candidate, channelState, candidateState, now) {
  const channel = channelState.get(candidate.channelId)
  if (BLOCKED_CHANNEL_STATES.has(channel?.health)) return false
  if (channel?.health === 'cooling') {
    if (channel.cooldownUntil > now) return false
    channelState.delete(candidate.channelId)
  }
  return candidateState.get(candidate.key)?.health !== 'misconfigured'
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
