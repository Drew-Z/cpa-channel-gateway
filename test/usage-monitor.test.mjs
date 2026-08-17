import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createUsageMonitor } from '../src/usage-monitor.mjs'

test('usage monitor aggregates a rolling window and persists only low-sensitive events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-usage-monitor-'))
  const filePath = path.join(root, 'runtime', 'usage-events.jsonl')
  let clock = Date.parse('2026-08-15T12:00:00.000Z')
  const monitor = createUsageMonitor({}, { filePath, now: () => clock })

  monitor.record({
    requestedModel: 'coding-main',
    channelId: 'free',
    upstreamModel: 'shared-model',
    outcome: 'success',
    transport: 'native-passthrough',
    prompt: 'must not be stored',
    authorization: 'must not be stored'
  })
  clock += 1_000
  monitor.record({
    requestedModel: 'coding-main',
    upstreamModel: 'shared-model',
    outcome: 'failure',
    transport: 'unassigned'
  })
  clock += 1_000
  monitor.record({
    requestedModel: 'free/shared-model',
    channelId: 'free',
    upstreamModel: 'shared-model',
    outcome: 'cancelled',
    transport: 'adapted'
  })
  clock += 1_000
  monitor.record({
    requestedModel: 'shared-model',
    channelId: 'backup',
    upstreamModel: 'shared-model',
    outcome: 'success',
    transport: 'adapted'
  })

  const snapshot = monitor.snapshot()
  assert.deepEqual(snapshot.summary, {
    total: 4,
    success: 2,
    failure: 1,
    cancelled: 1,
    successRate: 50,
    nativePassthrough: 1,
    adapted: 2,
    lastSeenAt: new Date(clock).toISOString()
  })
  assert.deepEqual(snapshot.models.map(item => [item.id, item.total]), [
    ['coding-main', 2],
    ['free/shared-model', 1],
    ['shared-model', 1]
  ])
  assert.deepEqual(snapshot.logicalModels.map(item => [item.id, item.total]), [['shared-model', 4]])
  assert.equal(snapshot.physicalModels[0].id, 'free/shared-model')
  assert.equal(snapshot.physicalModels[0].total, 2)
  assert.equal(snapshot.physicalModels[1].id, 'backup/shared-model')
  assert.equal(snapshot.storage, 'persistent')

  const persisted = fs.readFileSync(filePath, 'utf8')
  assert.doesNotMatch(persisted, /must not be stored|prompt|authorization/)
  fs.appendFileSync(filePath, 'malformed local line\n')
  const restored = createUsageMonitor({}, { filePath, now: () => clock }).snapshot()
  assert.deepEqual(restored.summary, snapshot.summary)
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /malformed local line/)

  clock += 25 * 60 * 60 * 1000
  assert.equal(monitor.snapshot().summary.total, 0)
})

test('usage monitor rejects malformed events and remains in-memory without private paths', () => {
  const monitor = createUsageMonitor({}, { filePath: null, now: () => 1_000 })
  assert.equal(monitor.record({ requestedModel: '', outcome: 'success' }), false)
  assert.equal(monitor.record({ requestedModel: 'model-a', outcome: 'unknown' }), false)
  assert.equal(monitor.snapshot().summary.total, 0)
  assert.equal(monitor.snapshot().storage, 'memory')
})

test('usage monitor attributes different upstream ids to an explicit logical model', () => {
  let clock = 1_000
  const monitor = createUsageMonitor({}, { filePath: null, now: () => clock })
  monitor.record({
    requestedModel: 'coding-main',
    channelId: 'deepseek',
    logicalModelId: 'coding-pool',
    upstreamModel: 'DeepSeek-V4-Flash',
    outcome: 'success',
    transport: 'native-passthrough'
  })
  clock += 1
  monitor.record({
    requestedModel: 'coding-pool',
    channelId: 'glm',
    logicalModelId: 'coding-pool',
    upstreamModel: 'glm-5.2',
    outcome: 'success',
    transport: 'adapted'
  })

  const snapshot = monitor.snapshot()
  assert.deepEqual(snapshot.logicalModels.map(item => [item.id, item.total]), [['coding-pool', 2]])
  assert.deepEqual(snapshot.physicalModels.map(item => item.id), [
    'deepseek/DeepSeek-V4-Flash',
    'glm/glm-5.2'
  ])
})

test('usage monitor restores v1 events using their upstream model as the logical id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-usage-v1-'))
  const filePath = path.join(root, 'runtime', 'usage-events.jsonl')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify({
    v: 1,
    at: 1_000,
    requestedModel: 'coding-main',
    channelId: 'legacy',
    upstreamModel: 'legacy-model',
    outcome: 'success',
    transport: 'adapted'
  })}\n`)

  const snapshot = createUsageMonitor({}, { filePath, now: () => 1_001 }).snapshot()
  assert.deepEqual(snapshot.logicalModels.map(item => [item.id, item.total]), [['legacy-model', 1]])
  assert.equal(snapshot.physicalModels[0].id, 'legacy/legacy-model')
})

test('usage monitor falls back to memory when its private event file is not writable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-usage-fallback-'))
  const blocker = path.join(root, 'not-a-directory')
  fs.writeFileSync(blocker, 'block')
  const monitor = createUsageMonitor({}, {
    filePath: path.join(blocker, 'usage-events.jsonl'),
    now: () => 1_000
  })
  assert.equal(monitor.record({ requestedModel: 'model-a', outcome: 'success' }), true)
  assert.equal(monitor.snapshot().storage, 'memory-fallback')
  assert.equal(monitor.snapshot().summary.total, 1)
})
