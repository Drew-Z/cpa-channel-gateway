import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MAX_EVIDENCE_SAMPLES,
  MIN_COMPARABLE_SAMPLES,
  circuitStatus,
  compareEvidence,
  cooldownMs,
  emptyEvidence,
  normalizeEvidence,
  observeEvidence,
  successRate
} from '../src/candidate-evidence.mjs'

test('evidence updates success rate, EWMA and resets transient failures on success', () => {
  let evidence = emptyEvidence()
  evidence = observeEvidence(evidence, { kind: 'success', durationMs: 1_000 }, { now: 1_000 })
  evidence = observeEvidence(evidence, { kind: 'success', durationMs: 2_000 }, { now: 2_000 })
  assert.equal(evidence.sampleCount, 2)
  assert.equal(evidence.successCount, 2)
  assert.equal(evidence.failureCount, 0)
  assert.equal(evidence.ewmaLatencyMs, 1_250)
  assert.equal(successRate(evidence), 1)
})

test('three transient failures open a circuit and cooldown is bounded exponentially', () => {
  let evidence = emptyEvidence()
  for (let index = 0; index < 3; index += 1) {
    evidence = observeEvidence(evidence, { kind: 'transport-failure', transient: true, durationMs: 100 }, { now: 1_000 + index })
  }
  assert.equal(evidence.circuit, 'open')
  assert.equal(evidence.consecutiveTransientFailures, 3)
  assert.equal(evidence.openCount, 1)
  assert.equal(evidence.cooldownUntil, 1_000 + 2 + BASE_COOLDOWN_MS)
  assert.equal(circuitStatus(evidence, evidence.cooldownUntil - 1), 'open')
  assert.equal(circuitStatus(evidence, evidence.cooldownUntil), 'half-open')
  assert.equal(cooldownMs(1), BASE_COOLDOWN_MS)
  assert.equal(cooldownMs(20), MAX_COOLDOWN_MS)
})

test('half-open success closes and clears the backoff', () => {
  let evidence = emptyEvidence()
  for (let index = 0; index < 3; index += 1) evidence = observeEvidence(evidence, { kind: 'http-failure', transient: true }, { now: index + 1 })
  assert.equal(circuitStatus(evidence, evidence.cooldownUntil), 'half-open')
  const recovered = observeEvidence(evidence, { kind: 'success', durationMs: 50 }, { now: evidence.cooldownUntil })
  assert.equal(recovered.circuit, 'closed')
  assert.equal(recovered.cooldownUntil, null)
  assert.equal(recovered.openCount, 0)
  assert.equal(recovered.consecutiveTransientFailures, 0)
})

test('non-transient failures do not open the circuit and cancellation is ignored', () => {
  let evidence = emptyEvidence()
  for (let index = 0; index < 10; index += 1) evidence = observeEvidence(evidence, { kind: 'http-failure', transient: false }, { now: index + 1 })
  assert.equal(evidence.circuit, 'closed')
  assert.equal(evidence.failureCount, 10)
  const cancelled = observeEvidence(evidence, { kind: 'cancelled', durationMs: 100 }, { now: 100 })
  assert.deepEqual(cancelled, evidence)
})

test('evidence comparison ignores insufficient samples and prefers rate then latency', () => {
  const unknown = emptyEvidence()
  const oneSample = observeEvidence(unknown, { kind: 'success', durationMs: 1 }, { now: 1 })
  assert.equal(compareEvidence(oneSample, unknown, 2), 0)

  let slower = emptyEvidence()
  let faster = emptyEvidence()
  for (let index = 0; index < MIN_COMPARABLE_SAMPLES; index += 1) {
    slower = observeEvidence(slower, { kind: index === 0 ? 'http-failure' : 'success', durationMs: 400 }, { now: index + 1 })
    faster = observeEvidence(faster, { kind: 'success', durationMs: 100 }, { now: index + 1 })
  }
  assert.ok(compareEvidence(faster, slower, 10) < 0)

  const invalid = normalizeEvidence({ sampleCount: 2, successCount: 3, failureCount: 0, lastOutcomeAt: 1 })
  assert.deepEqual(invalid, emptyEvidence())
})

test('counter history is bounded before another sample is added', () => {
  const saturated = {
    ...emptyEvidence(),
    sampleCount: MAX_EVIDENCE_SAMPLES,
    successCount: MAX_EVIDENCE_SAMPLES,
    lastOutcomeAt: 1
  }
  const next = observeEvidence(saturated, { kind: 'success' }, { now: 2 })
  assert.equal(next.sampleCount, Math.floor(MAX_EVIDENCE_SAMPLES / 2) + 1)
  assert.equal(next.successCount, Math.floor(MAX_EVIDENCE_SAMPLES / 2) + 1)
})

test('expires evidence at the TTL boundary and reopens with bounded backoff', () => {
  let evidence = emptyEvidence()
  for (let index = 0; index < 3; index += 1) evidence = observeEvidence(evidence, { kind: 'transport-failure', transient: true }, { now: index + 1 })
  const expired = normalizeEvidence(evidence, { now: evidence.lastOutcomeAt + 24 * 60 * 60 * 1000 + 1 })
  assert.deepEqual(expired, emptyEvidence())

  const halfOpenFailure = observeEvidence(evidence, { kind: 'transport-failure', transient: true }, { now: evidence.cooldownUntil })
  assert.equal(halfOpenFailure.openCount, 2)
  assert.equal(halfOpenFailure.cooldownUntil, evidence.cooldownUntil + BASE_COOLDOWN_MS * 2)
  assert.ok(halfOpenFailure.cooldownUntil - evidence.cooldownUntil <= MAX_COOLDOWN_MS * 2)
})

test('interleaved transient success resets the opening threshold', () => {
  let evidence = emptyEvidence()
  evidence = observeEvidence(evidence, { kind: 'transport-failure', transient: true }, { now: 1 })
  evidence = observeEvidence(evidence, { kind: 'transport-failure', transient: true }, { now: 2 })
  evidence = observeEvidence(evidence, { kind: 'success', durationMs: 10 }, { now: 3 })
  evidence = observeEvidence(evidence, { kind: 'transport-failure', transient: true }, { now: 4 })
  assert.equal(evidence.circuit, 'closed')
  assert.equal(evidence.consecutiveTransientFailures, 1)
})
