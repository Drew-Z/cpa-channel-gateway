import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigRevisionError, createConfigRevisionStore, diffSnapshots, digestSnapshot, revisionReleaseDigests } from '../src/config-revisions.mjs'

test('stores complete private snapshots with a validated low-sensitivity manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-revision-store-'))
  const snapshot = {
    envText: 'GATEWAY_API_KEY=fixture-secret\n',
    routesText: '{"schemaVersion":1,"channels":[]}\n',
    providersText: '{"schemaVersion":1,"providers":[]}\n',
    clientsText: null
  }
  const store = createConfigRevisionStore({
    root,
    now: () => Date.parse('2026-08-17T12:34:56.789Z'),
    idFactory: () => 'revision-1'
  })
  const manifest = store.create({
    operation: 'channel-update',
    affected: { channelIds: ['free5'], modelIds: ['free5/model-a'] },
    snapshot
  })
  assert.match(manifest.revision, /^20260817T123456789Z-[a-f0-9]{16}-[a-f0-9]{8}$/)
  assert.equal(manifest.contentDigest, digestSnapshot(snapshot))
  assert.equal(JSON.stringify(manifest).includes('fixture-secret'), false)
  const restored = store.read(manifest.revision)
  assert.deepEqual(restored.snapshot, snapshot)
  assert.deepEqual(store.list(), [{ ...manifest, valid: true }])
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(store.root, manifest.revision, 'manifest.json')).mode & 0o777, 0o600)
})

test('links revisions and rejects traversal or corrupted snapshot content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-revision-corrupt-'))
  let clock = Date.parse('2026-08-17T12:00:00.000Z')
  let id = 0
  const store = createConfigRevisionStore({ root, now: () => clock++, idFactory: () => `revision-${++id}` })
  const first = store.create({ operation: 'baseline', snapshot: { envText: 'A=1\n', routesText: '{}\n', providersText: null } })
  const second = store.create({ parentRevision: first.revision, operation: 'model-sync', snapshot: { envText: 'A=1\n', routesText: '{"changed":true}\n', providersText: null } })
  assert.equal(second.parentRevision, first.revision)
  assert.throws(() => store.read('../private'), error => error instanceof ConfigRevisionError && error.code === 'invalid_revision_id')
  fs.appendFileSync(path.join(store.root, second.revision, 'routes.local.json'), 'tampered')
  assert.throws(() => store.read(second.revision), error => error instanceof ConfigRevisionError && error.code === 'revision_invalid')
  assert.equal(store.list().find(entry => entry.revision === second.revision).valid, false)
})

test('links a validated revision to an existing runtime release without exposing snapshot data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-revision-release-'))
  const releaseDigest = '0123456789abcdef'
  const releaseDir = path.join(root, 'runtime', 'releases', releaseDigest)
  fs.mkdirSync(releaseDir, { recursive: true })
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), '{}\n')
  const store = createConfigRevisionStore({ root })
  const revision = store.create({
    operation: 'baseline',
    snapshot: { envText: 'PRIVATE_VALUE=fixture-secret\n', routesText: '{}\n', providersText: null }
  })

  const linked = store.linkRelease(revision.revision, releaseDigest)

  assert.equal(linked.releaseDigest, releaseDigest)
  assert.equal(store.read(revision.revision).manifest.releaseDigest, releaseDigest)
  assert.deepEqual(revisionReleaseDigests(root), [releaseDigest])
  assert.equal(JSON.stringify(store.list()).includes('fixture-secret'), false)
  assert.throws(() => store.linkRelease(revision.revision, 'not-a-release'), error => error instanceof ConfigRevisionError && error.code === 'invalid_release_digest')
  assert.throws(() => store.linkRelease(revision.revision, 'fedcba9876543210'), error => error instanceof ConfigRevisionError && error.code === 'release_not_found')
})

test('inventories and explicitly prunes old revisions while retaining the recent tail and protected revisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-revision-prune-'))
  let clock = Date.parse('2026-08-17T12:00:00.000Z')
  let id = 0
  const store = createConfigRevisionStore({ root, now: () => clock++, idFactory: () => `revision-${++id}` })
  const revisions = []
  for (let index = 0; index < 5; index += 1) {
    revisions.push(store.create({
      parentRevision: revisions.at(-1)?.revision ?? null,
      operation: index === 0 ? 'baseline' : 'channel-update',
      snapshot: { envText: `PRIVATE_VALUE=fixture-secret-${index}\n`, routesText: JSON.stringify({ index }), providersText: null }
    }))
  }
  const releaseDigest = 'abcdef0123456789'
  const releaseDir = path.join(root, 'runtime', 'releases', releaseDigest)
  fs.mkdirSync(releaseDir, { recursive: true })
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), '{}\n')
  store.linkRelease(revisions[2].revision, releaseDigest)
  fs.appendFileSync(path.join(store.root, revisions[1].revision, 'routes.local.json'), 'tampered')

  const inventory = store.inventory({ keep: 2, protectedRevisions: [revisions[0].revision] })

  assert.equal(inventory.count, 5)
  assert.equal(inventory.validCount, 4)
  assert.equal(inventory.invalidCount, 1)
  assert.equal(inventory.protectedCount, 1)
  assert.equal(inventory.prunableCount, 2)
  assert.ok(inventory.totalBytes > inventory.prunableBytes && inventory.prunableBytes > 0)
  assert.equal(JSON.stringify(inventory).includes('fixture-secret'), false)

  const result = store.prune({ keep: 2, protectedRevisions: [revisions[0].revision] })

  assert.equal(result.removedCount, 2)
  assert.equal(result.reclaimedBytes, inventory.prunableBytes)
  assert.equal(result.remaining.count, 3)
  assert.equal(store.read(revisions[0].revision).manifest.revision, revisions[0].revision)
  assert.equal(store.read(revisions[3].revision).manifest.revision, revisions[3].revision)
  assert.equal(store.read(revisions[4].revision).manifest.revision, revisions[4].revision)
  assert.throws(() => store.read(revisions[1].revision), error => error instanceof ConfigRevisionError && error.code === 'revision_not_found')
  assert.throws(() => store.read(revisions[2].revision), error => error instanceof ConfigRevisionError && error.code === 'revision_not_found')
  assert.deepEqual(revisionReleaseDigests(root), [])
})

test('produces structured diffs without returning provider URLs or keys', () => {
  const before = {
    envText: 'GATEWAY_API_KEY=gateway-secret\nCHANNEL_MAIN_NAME=Main\nCHANNEL_MAIN_BASE_URL=https://old.example.test/v1\nCHANNEL_MAIN_API_KEY=old-secret\nCHANNEL_MAIN_PROTOCOL=responses\nCHANNEL_MAIN_ENABLED=true\n',
    routesText: JSON.stringify({ schemaVersion: 1, channels: [{ id: 'main', enabled: true, models: [{ upstream: 'model-a', aliases: ['main/model-a'] }] }], stableAliases: [{ alias: 'coding-main', channel: 'main', model: 'model-a' }], pinnedAliases: [] }),
    providersText: null
  }
  const after = {
    envText: 'GATEWAY_API_KEY=gateway-secret\nCHANNEL_MAIN_NAME=Main v2\nCHANNEL_MAIN_BASE_URL=https://new.example.test/v1\nCHANNEL_MAIN_API_KEY=new-secret\nCHANNEL_MAIN_PROTOCOL=responses\nCHANNEL_MAIN_ENABLED=false\n',
    routesText: JSON.stringify({ schemaVersion: 1, channels: [{ id: 'main', enabled: false, models: [{ upstream: 'model-a', aliases: ['main/model-a'], status: 'disabled' }, { upstream: 'model-b', aliases: ['main/model-b'] }] }], stableAliases: [{ alias: 'coding-main', channel: 'main', model: 'model-b' }], pinnedAliases: [] }),
    providersText: null
  }
  const diff = diffSnapshots(before, after)
  const output = JSON.stringify(diff)
  assert.equal(diff.channels.changed[0].baseUrlChanged, true)
  assert.equal(diff.channels.changed[0].apiKeyReplaced, true)
  assert.deepEqual(diff.models.added, ['main/model-b'])
  assert.deepEqual(diff.aliases.stable.changed, [{ alias: 'coding-main', from: 'main/model-a', to: 'main/model-b' }])
  assert.doesNotMatch(output, /old\.example\.test|new\.example\.test|old-secret|new-secret/)
})

test('diffs logical model membership and logical alias targets without snapshot content', () => {
  const base = {
    schemaVersion: 2,
    channels: [{ id: 'main', models: [{ upstream: 'model-a' }, { upstream: 'model-b' }] }],
    logicalModels: [{ id: 'coding-pool', enabled: true, candidates: [{ channel: 'main', model: 'model-a', priority: 10 }] }],
    stableAliases: [{ alias: 'coding-main', logicalModel: 'coding-pool' }],
    pinnedAliases: []
  }
  const next = structuredClone(base)
  next.logicalModels[0].candidates = [{ channel: 'main', model: 'model-b', priority: 20 }]
  next.stableAliases = [{ alias: 'coding-main', channel: 'main', model: 'model-b' }]
  const snapshot = routes => ({ envText: 'GATEWAY_API_KEY=fixture\n', routesText: JSON.stringify(routes), providersText: null })
  const diff = diffSnapshots(snapshot(base), snapshot(next))
  assert.deepEqual(diff.logicalModels.changed, [{ id: 'coding-pool', candidatesChanged: true }])
  assert.deepEqual(diff.aliases.stable.changed, [{ alias: 'coding-main', from: 'logical:coding-pool', to: 'main/model-b' }])
  assert.equal(JSON.stringify(diff).includes('routesText'), false)
})
