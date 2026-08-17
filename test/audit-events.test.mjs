import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createAuditEventStore } from '../src/audit-events.mjs'

test('persists only allowlisted audit fields and restores around corrupt lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-audit-events-'))
  const filePath = path.join(root, 'runtime', 'audit-events.jsonl')
  let clock = Date.parse('2026-08-17T12:00:00.000Z')
  const audit = createAuditEventStore({}, { filePath, now: () => clock })
  assert.equal(audit.record({
    jobId: 'job-1',
    operation: 'channel-update',
    result: 'success',
    revision: 'revision-1',
    durationMs: 12,
    apiKey: 'must-not-persist',
    body: 'must-not-persist'
  }), true)
  clock += 1_000
  assert.equal(audit.record({
    jobId: 'job-2',
    operation: 'runtime-apply',
    result: 'failure',
    durationMs: 25,
    errorCode: 'runtime_not_ready',
    error: 'private upstream response'
  }), true)
  const persisted = fs.readFileSync(filePath, 'utf8')
  assert.doesNotMatch(persisted, /must-not-persist|private upstream response|apiKey|body/)
  assert.deepEqual(audit.list().map(event => event.jobId), ['job-2', 'job-1'])
  fs.appendFileSync(filePath, 'corrupt private line\n')
  const restored = createAuditEventStore({}, { filePath, now: () => clock })
  assert.equal(restored.status().storage, 'persistent')
  assert.deepEqual(restored.list().map(event => event.jobId), ['job-2', 'job-1'])
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /corrupt private line/)
})

test('bounds audit history and falls back to memory on write failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-audit-bounds-'))
  const filePath = path.join(root, 'audit-events.jsonl')
  let clock = 1_000
  const audit = createAuditEventStore({}, { filePath, now: () => clock++, maxEntries: 3, maxBytes: 512 })
  for (let index = 0; index < 8; index += 1) {
    assert.equal(audit.record({ jobId: `job-${index}`, operation: 'model-sync', result: 'success', revision: `revision-${index}`, durationMs: index }), true)
  }
  assert.deepEqual(audit.list().map(event => event.jobId), ['job-7', 'job-6', 'job-5'])
  assert.ok(fs.statSync(filePath).size <= 512)

  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'not a directory')
  const fallback = createAuditEventStore({}, { filePath: path.join(blocker, 'audit.jsonl'), now: () => 2_000 })
  assert.equal(fallback.record({ jobId: 'job-x', operation: 'channel-delete', result: 'success', durationMs: 1 }), true)
  assert.equal(fallback.status().storage, 'memory-fallback')
})
