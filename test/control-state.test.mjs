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
    transport: 'native-passthrough',
    latencyMs: 250,
    contentLength: 32,
    testedAt: new Date(timestamp).toISOString(),
    prompt: 'must-not-persist',
    responseBody: 'must-not-persist',
    headers: { authorization: 'must-not-persist' }
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
    transport: 'native-passthrough',
    latencyMs: 250,
    testedAt: new Date(timestamp).toISOString(),
    contentLength: 32
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
      gamma: { health: 'auth-failed', updatedAt: clock },
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
    gamma: { health: 'auth-failed', updatedAt: 1_000 },
    delta: { health: 'payment-blocked', updatedAt: 1_000 }
  })
  assert.equal(aged.schedulerState().candidates['alpha\0shared-model\0responses'].health, 'misconfigured')

  const nextRelease = createControlState({ ...config, digest: 'release-b' }, { filePath, now: () => clock, healthStaleMs: 100 })
  assert.deepEqual(nextRelease.schedulerState(), { channels: {}, candidates: {} })
  assert.equal(nextRelease.lastTests()['alpha/shared-model'].status, 'success')
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
