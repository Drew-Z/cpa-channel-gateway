export const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000
export const MIN_COMPARABLE_SAMPLES = 5
export const EWMA_ALPHA = 0.25
export const TRANSIENT_FAILURE_THRESHOLD = 3
export const BASE_COOLDOWN_MS = 30 * 1000
export const MAX_COOLDOWN_MS = 5 * 60 * 1000
export const MAX_EVIDENCE_SAMPLES = 10_000

const CIRCUITS = new Set(['closed', 'open'])
const OBSERVATIONS = new Set(['success', 'http-failure', 'transport-failure', 'cancelled'])

export function emptyEvidence() {
  return {
    sampleCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveTransientFailures: 0,
    ewmaLatencyMs: null,
    lastOutcomeAt: 0,
    circuit: 'closed',
    cooldownUntil: null,
    openCount: 0
  }
}

export function normalizeEvidence(input, { now = Date.now(), ttlMs = EVIDENCE_TTL_MS } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return emptyEvidence()
  const lastOutcomeAt = nonNegativeInteger(input.lastOutcomeAt)
  if (lastOutcomeAt === null || (ttlMs >= 0 && lastOutcomeAt > 0 && lastOutcomeAt < now - ttlMs)) return emptyEvidence()
  const sampleCount = boundedInteger(input.sampleCount, 0, MAX_EVIDENCE_SAMPLES)
  const successCount = boundedInteger(input.successCount, 0, sampleCount)
  const failureCount = boundedInteger(input.failureCount, 0, sampleCount)
  if (sampleCount === null || successCount === null || failureCount === null || successCount + failureCount > sampleCount) return emptyEvidence()
  const ewmaLatencyMs = input.ewmaLatencyMs === null ? null : boundedInteger(input.ewmaLatencyMs, 0, 24 * 60 * 60 * 1000)
  if (input.ewmaLatencyMs !== null && ewmaLatencyMs === null) return emptyEvidence()
  const consecutiveTransientFailures = boundedInteger(input.consecutiveTransientFailures, 0, MAX_EVIDENCE_SAMPLES)
  const openCount = boundedInteger(input.openCount, 0, MAX_EVIDENCE_SAMPLES)
  if (consecutiveTransientFailures === null || openCount === null || !CIRCUITS.has(input.circuit ?? 'closed')) return emptyEvidence()
  const cooldownUntil = input.cooldownUntil === null ? null : nonNegativeInteger(input.cooldownUntil)
  if (input.circuit === 'open' && cooldownUntil === null) return emptyEvidence()
  if (input.circuit === 'closed' && cooldownUntil !== null) return emptyEvidence()
  return {
    sampleCount,
    successCount,
    failureCount,
    consecutiveTransientFailures,
    ewmaLatencyMs,
    lastOutcomeAt,
    circuit: input.circuit ?? 'closed',
    cooldownUntil,
    openCount
  }
}

export function observeEvidence(previous, observation, { now = Date.now() } = {}) {
  const current = normalizeEvidence(previous, { now: Number.MAX_SAFE_INTEGER, ttlMs: -1 })
  if (!observation || !OBSERVATIONS.has(observation.kind) || !Number.isSafeInteger(now) || now < 0) return current
  if (observation.kind === 'cancelled') return current

  const result = { ...current }
  const latencyMs = boundedInteger(observation.durationMs, 0, 24 * 60 * 60 * 1000)
  let sampleCount = result.sampleCount
  let successCount = result.successCount
  let failureCount = result.failureCount
  if (sampleCount >= MAX_EVIDENCE_SAMPLES) {
    successCount = Math.floor(successCount / 2)
    failureCount = Math.floor(failureCount / 2)
    sampleCount = successCount + failureCount
  }
  sampleCount += 1
  if (observation.kind === 'success') {
    successCount += 1
    result.consecutiveTransientFailures = 0
    result.circuit = 'closed'
    result.cooldownUntil = null
    result.openCount = 0
  } else {
    failureCount += 1
    if (observation.transient === true) {
      result.consecutiveTransientFailures += 1
      if (result.circuit === 'open' || result.consecutiveTransientFailures >= TRANSIENT_FAILURE_THRESHOLD) {
        result.circuit = 'open'
        result.openCount = Math.min(MAX_EVIDENCE_SAMPLES, result.openCount + 1)
        result.cooldownUntil = now + cooldownMs(result.openCount)
      }
    } else {
      result.consecutiveTransientFailures = 0
    }
  }
  if (latencyMs !== null) {
    result.ewmaLatencyMs = result.ewmaLatencyMs === null
      ? latencyMs
      : Math.round(EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * result.ewmaLatencyMs)
  }
  result.sampleCount = sampleCount
  result.successCount = successCount
  result.failureCount = failureCount
  result.lastOutcomeAt = now
  return result
}

export function circuitStatus(evidence, now = Date.now()) {
  const normalized = normalizeEvidence(evidence, { now, ttlMs: EVIDENCE_TTL_MS })
  if (normalized.circuit !== 'open') return 'closed'
  return normalized.cooldownUntil > now ? 'open' : 'half-open'
}

export function cooldownMs(openCount) {
  const exponent = Math.max(0, Math.min(20, Number.isSafeInteger(openCount) ? openCount - 1 : 0))
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * (2 ** exponent))
}

export function successRate(evidence) {
  const normalized = normalizeEvidence(evidence, { now: Number.MAX_SAFE_INTEGER, ttlMs: -1 })
  return normalized.sampleCount > 0 ? normalized.successCount / normalized.sampleCount : null
}

export function compareEvidence(left, right, now = Date.now()) {
  const leftValue = normalizeEvidence(left, { now, ttlMs: EVIDENCE_TTL_MS })
  const rightValue = normalizeEvidence(right, { now, ttlMs: EVIDENCE_TTL_MS })
  const leftComparable = leftValue.sampleCount >= MIN_COMPARABLE_SAMPLES
  const rightComparable = rightValue.sampleCount >= MIN_COMPARABLE_SAMPLES
  if (leftComparable && rightComparable) {
    const rateDifference = successRate(rightValue) - successRate(leftValue)
    if (rateDifference !== 0) return rateDifference
  }
  if (leftValue.ewmaLatencyMs !== null && rightValue.ewmaLatencyMs !== null && leftValue.ewmaLatencyMs !== rightValue.ewmaLatencyMs) {
    return leftValue.ewmaLatencyMs - rightValue.ewmaLatencyMs
  }
  return 0
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

function nonNegativeInteger(value) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER)
}
