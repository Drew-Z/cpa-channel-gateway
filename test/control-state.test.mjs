import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createControlState } from '../src/control-state.mjs'

test('persists scheduler state and allowlisted canary summaries across restart', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root)
  const timestamp = 1_700_000_000_000
  const candidateKey = 'alpha\0shared-model\0responses'
  const state = createControlState(config, { filePath, now: () => timestamp })

  state.replaceSchedulerState({
    channels: { alpha: { health: 'healthy', updatedAt: timestamp, secret: 'must-not-persist' } },
    candidates: { [candidateKey]: { health: 'misconfigured', updatedAt: timestamp, responseBody: 'must-not-persist' } },
    authorization: 'must-not-persist'
  })
  assert.equal(state.rememberTest('alpha/shared-model', {
    ok: true,
    status: 'success',
    statusCode: 200,
    protocol: 'responses',
    configuredProtocol: 'responses',
    transport: 'native-passthrough',
    latencyMs: 250,
    contentLength: 32,
    testedAt: new Date(timestamp).toISOString(),
    prompt: 'must-not-persist',
    responseBody: 'must-not-persist',
    headers: { authorization: 'must-not-persist' },
    diagnostics: { bodyBytes: 128, responseStatus: 'completed', outputItemTypes: ['message'], reasoningPresent: false, usage: { outputTokens: 32 }, responseBody: 'must-not-persist' }
  }), true)

  const persisted = fs.readFileSync(filePath, 'utf8')
  assert.doesNotMatch(persisted, /must-not-persist|authorization|prompt|responseBody/)
  const restored = createControlState(config, { filePath, now: () => timestamp + 1 })
  assert.deepEqual(restored.schedulerState(), {
    channels: { alpha: { health: 'healthy', updatedAt: timestamp } },
    candidates: { [candidateKey]: { health: 'misconfigured', updatedAt: timestamp } }
  })
  assert.deepEqual(restored.lastTests()['alpha/shared-model'], {
    ok: true,
    status: 'success',
    statusCode: 200,
    protocol: 'responses',
    configuredProtocol: 'responses',
    transport: 'native-passthrough',
    latencyMs: 250,
    testedAt: new Date(timestamp).toISOString(),
    contentLength: 32,
    diagnostics: { bodyBytes: 128, responseStatus: 'completed', outputItemTypes: ['message'], reasoningPresent: false, usage: { outputTokens: 32 } }
  })
  assert.equal(restored.status().storage, 'persistent')
})

test('expires transient health, retains release-scoped failures, and resets them on release change', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root, ['alpha', 'beta', 'gamma', 'delta', 'epsilon'])
  let clock = 1_000
  const state = createControlState(config, { filePath, now: () => clock, healthStaleMs: 100 })
  state.replaceSchedulerState({
    channels: {
      alpha: { health: 'healthy', updatedAt: clock },
      beta: { health: 'degraded', updatedAt: clock },
      gamma: { health: 'auth-failed', lastStatusCode: 403, updatedAt: clock },
      delta: { health: 'payment-blocked', updatedAt: clock },
      epsilon: { health: 'cooling', cooldownUntil: clock + 100, updatedAt: clock }
    },
    candidates: {
      ['alpha\0shared-model\0responses']: { health: 'misconfigured', updatedAt: clock }
    }
  })
  state.rememberTest('alpha/shared-model', successfulTest(clock))

  clock += 201
  const aged = createControlState(config, { filePath, now: () => clock, healthStaleMs: 100 })
  assert.deepEqual(aged.schedulerState().channels, {
    gamma: { health: 'auth-failed', lastStatusCode: 403, updatedAt: 1_000 },
    delta: { health: 'payment-blocked', updatedAt: 1_000 }
  })
  assert.equal(aged.schedulerState().candidates['alpha\0shared-model\0responses'].health, 'misconfigured')

  const nextRelease = createControlState({ ...config, digest: 'release-b' }, { filePath, now: () => clock, healthStaleMs: 100 })
  assert.deepEqual(nextRelease.schedulerState(), { channels: {}, candidates: {} })
  assert.equal(nextRelease.lastTests()['alpha/shared-model'].status, 'success')
})

test('persists only 401 or 403 authentication diagnostics', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root, ['alpha', 'beta', 'gamma'])
  const state = createControlState(config, { filePath, now: () => 5_000 })
  state.replaceSchedulerState({
    channels: {
      alpha: { health: 'auth-failed', lastStatusCode: 401, updatedAt: 5_000 },
      beta: { health: 'auth-failed', lastStatusCode: 403, updatedAt: 5_000 },
      gamma: { health: 'auth-failed', lastStatusCode: 500, updatedAt: 5_000 }
    }
  })
  assert.deepEqual(state.schedulerState().channels, {
    alpha: { health: 'auth-failed', lastStatusCode: 401, updatedAt: 5_000 },
    beta: { health: 'auth-failed', lastStatusCode: 403, updatedAt: 5_000 },
    gamma: { health: 'auth-failed', updatedAt: 5_000 }
  })
  const restored = createControlState(config, { filePath, now: () => 5_001 })
  assert.deepEqual(restored.schedulerState().channels, state.schedulerState().channels)
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /authorization|apiKey|responseBody/)
})

test('rejects invalid summaries and falls back to memory for corrupt or unwritable state paths', t => {
  const root = temporaryRoot(t)
  const config = fixtureConfig(root)
  const corruptPath = path.join(root, 'runtime', 'corrupt.json')
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true })
  fs.writeFileSync(corruptPath, '{broken')
  const corrupt = createControlState(config, { filePath: corruptPath, now: () => 1_000 })
  assert.equal(corrupt.status().storage, 'memory-fallback')
  assert.equal(corrupt.rememberTest('unknown/model', successfulTest(1_000)), false)
  corrupt.replaceSchedulerState({ channels: { alpha: { health: 'healthy', updatedAt: 1_000 } } })
  assert.equal(corrupt.schedulerState().channels.alpha.health, 'healthy')
  assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{broken')

  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'not-a-directory')
  const unwritable = createControlState(config, { filePath: path.join(blocker, 'control-state.json'), now: () => 2_000 })
  unwritable.replaceSchedulerState({ channels: { alpha: { health: 'healthy', updatedAt: 2_000 } } })
  assert.equal(unwritable.status().storage, 'memory-fallback')
  assert.equal(unwritable.schedulerState().channels.alpha.health, 'healthy')
})

test('reconfigures the state store across a release change without carrying old blockers', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root)
  const state = createControlState(config, { filePath, now: () => 1_000 })
  state.replaceSchedulerState({ channels: { alpha: { health: 'auth-failed', updatedAt: 1_000 } } })
  state.rememberTest('alpha/shared-model', successfulTest(1_000))

  const next = fixtureConfig(root)
  next.digest = 'release-b'
  next.channels[0].models[0].upstream = 'new-model'
  next.channels[0].models[0].protocol = 'responses'
  const schedulerState = state.reconfigure(next)
  assert.deepEqual(schedulerState, { channels: {}, candidates: {} })
  assert.deepEqual(state.lastTests(), {})
  assert.equal(state.status().configRevision, 'release-b')
})

test('restores a prior release state snapshot after a failed runtime reload', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root)
  const state = createControlState(config, { filePath, now: () => 1_000 })
  state.replaceSchedulerState({ channels: { alpha: { health: 'auth-failed', updatedAt: 1_000 } } })
  state.rememberTest('alpha/shared-model', successfulTest(1_000))
  const snapshot = state.snapshot()

  const next = fixtureConfig(root)
  next.digest = 'release-b'
  state.reconfigure(next)
  state.restore(config, snapshot)

  assert.equal(state.status().configRevision, 'release-a')
  assert.equal(state.schedulerState().channels.alpha.health, 'auth-failed')
  assert.equal(state.lastTests()['alpha/shared-model'].status, 'success')
})

test('migrates v1 blockers to v2 and starts evidence empty', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root)
  const timestamp = 2_000
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    configRevision: 'release-a',
    updatedAt: new Date(timestamp).toISOString(),
    channels: { alpha: { health: 'auth-failed', updatedAt: timestamp } },
    candidates: { ['alpha\0shared-model\0responses']: { health: 'misconfigured', updatedAt: timestamp } },
    lastTests: {}
  }))

  const restored = createControlState(config, { filePath, now: () => timestamp })
  assert.deepEqual(restored.schedulerState(), {
    channels: { alpha: { health: 'auth-failed', updatedAt: timestamp } },
    candidates: { ['alpha\0shared-model\0responses']: { health: 'misconfigured', updatedAt: timestamp } }
  })
  const migrated = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(migrated.v, 2)
  assert.equal(migrated.candidates['alpha\0shared-model\0responses'].evidence, undefined)
})

test('persists and restores allowlisted candidate evidence without sensitive fields', t => {
  const root = temporaryRoot(t)
  const filePath = path.join(root, 'runtime', 'control-state.json')
  const config = fixtureConfig(root)
  const timestamp = 3_000
  const state = createControlState(config, { filePath, now: () => timestamp })
  state.replaceSchedulerState({
    candidates: {
      ['alpha\0shared-model\0responses']: {
        updatedAt: timestamp,
        evidence: {
          sampleCount: 5,
          successCount: 4,
          failureCount: 1,
          consecutiveTransientFailures: 0,
          ewmaLatencyMs: 120,
          lastOutcomeAt: timestamp,
          circuit: 'closed',
          cooldownUntil: null,
          openCount: 0,
          prompt: 'must-not-persist'
        },
        responseBody: 'must-not-persist'
      }
    }
  })
  const restored = createControlState(config, { filePath, now: () => timestamp + 1 })
  const candidate = restored.schedulerState().candidates['alpha\0shared-model\0responses']
  assert.deepEqual(candidate.evidence, {
    sampleCount: 5,
    successCount: 4,
    failureCount: 1,
    consecutiveTransientFailures: 0,
    ewmaLatencyMs: 120,
    lastOutcomeAt: timestamp,
    circuit: 'closed',
    cooldownUntil: null,
    openCount: 0
  })
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /must-not-persist|prompt|responseBody/)
})

function fixtureConfig(root, channelIds = ['alpha']) {
  return {
    digest: 'release-a',
    paths: { routesPath: path.join(root, 'config', 'routes.local.json') },
    channels: channelIds.map(id => ({
      id,
      protocol: 'responses',
      models: [{ upstream: 'shared-model', protocol: 'responses' }]
    }))
  }
}

function successfulTest(timestamp) {
  return {
    ok: true,
    status: 'success',
    statusCode: 200,
    protocol: 'responses',
    transport: 'native-passthrough',
    latencyMs: 10,
    contentLength: 20,
    testedAt: new Date(timestamp).toISOString()
  }
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-control-state-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
