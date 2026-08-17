import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPrivateConfigManager } from '../src/config-manager.mjs'
import { createConfigRevisionStore } from '../src/config-revisions.mjs'
import { loadConfig } from '../src/config.mjs'

test('channel mutations are private, revisioned, validated, and restart-required', () => {
  const root = fixtureRoot()
  const config = loadConfig(root)
  const manager = createPrivateConfigManager(config)
  const loadedStatus = manager.status()
  assert.equal(loadedStatus.loadedRevision, loadedStatus.pendingRevision)
  assert.equal(loadedStatus.restartRequired, false)
  const baseline = manager.revisions()[0]
  assert.equal(baseline.operation, 'startup-baseline')
  assert.equal(baseline.parentRevision, null)
  const created = manager.createChannel({
    id: 'backup',
    name: 'Backup Channel',
    baseUrl: 'https://backup.example.test/v1',
    apiKey: 'backup_secret_key_123456',
    protocol: 'responses',
    priority: 20
  })
  assert.equal(created.enabled, false)
  assert.equal(created.staged, true)
  assert.equal(created.hasApiKey, true)
  assert.equal(JSON.stringify(created).includes('backup_secret_key'), false)
  assert.equal(JSON.stringify(created).includes('backup.example.test'), false)
  const createdRevision = createConfigRevisionStore({ root }).read(created.revision)
  assert.equal(createdRevision.manifest.parentRevision, baseline.revision)
  assert.equal(createdRevision.manifest.operation, 'channel-create')
  assert.deepEqual(createdRevision.manifest.affected.channelIds, ['backup'])
  assert.equal(JSON.parse(createdRevision.snapshot.routesText).channels.some(channel => channel.id === 'backup'), true)
  assert.equal(JSON.stringify(manager.revisions()).includes('backup_secret_key'), false)
  assert.equal(JSON.stringify(manager.revisions()).includes('backup.example.test'), false)
  assert.equal(manager.status().restartRequired, true)
  assert.notEqual(manager.status().loadedRevision, manager.status().pendingRevision)
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'backup' && !channel.enabled && channel.staged && channel.runtimeEnabled), true)

  const updated = manager.updateChannel('backup', {
    name: 'Backup Updated',
    baseUrl: 'https://backup-updated.example.test/v1',
    apiKey: 'replacement_secret_key_123456',
    protocol: 'claude',
    priority: 30
  })
  assert.equal(updated.name, 'Backup Updated')
  assert.equal(updated.protocol, 'claude')
  assert.equal(updated.priority, 30)
  assert.equal(updated.hasApiKey, true)
  assert.equal(JSON.stringify(updated).includes('replacement_secret_key'), false)
  assert.equal(JSON.stringify(updated).includes('backup-updated.example.test'), false)
  const pendingChannel = manager.routing().channels.find(channel => channel.id === 'backup')
  assert.deepEqual(pendingChannel, {
    id: 'backup',
    name: 'Backup Updated',
    baseUrl: 'https://backup-updated.example.test/v1',
    enabled: false,
    staged: true,
    runtimeEnabled: true,
    protocol: 'claude',
    priority: 30,
    modelCount: 0,
    hasApiKey: true
  })
  assert.equal(JSON.stringify(manager.routing()).includes('replacement_secret_key'), false)

  assert.throws(
    () => manager.updateChannel('backup', { enabled: true }),
    error => error.code === 'configuration_validation_failed'
  )
  assert.equal(loadConfig(root).channels.find(channel => channel.id === 'backup').enabled, false)
  assert.ok(fs.readdirSync(path.join(root, 'runtime', 'config-revisions')).length >= 2)

  assert.throws(
    () => manager.deleteChannel('backup'),
    error => error.code === 'channel_must_be_disabled'
  )

  manager.updateChannel('backup', { staged: false, enabled: false })
  assert.deepEqual(manager.deleteChannel('backup'), { id: 'backup', deleted: true, revision: manager.status().revision, restartRequired: true })
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'backup'), false)
})

test('markApplied advances the loaded revision after an external runtime apply', () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root))
  manager.createChannel({
    id: 'applied',
    name: 'Applied Channel',
    baseUrl: 'https://applied.example.test/v1',
    apiKey: 'applied_secret_key_123456',
    protocol: 'responses',
    priority: 1
  })
  assert.equal(manager.status().restartRequired, true)
  const releaseDigest = '0123456789abcdef'
  const releaseDir = path.join(root, 'runtime', 'releases', releaseDigest)
  fs.mkdirSync(releaseDir, { recursive: true })
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), '{}\n')
  const applied = manager.markApplied(releaseDigest)
  assert.equal(applied.restartRequired, false)
  assert.equal(applied.loadedRevision, applied.pendingRevision)
  assert.equal(createConfigRevisionStore({ root }).read(applied.loadedRevision).manifest.releaseDigest, releaseDigest)
})

test('startup links the current revision to the already activated generated release', () => {
  const root = fixtureRoot()
  const releaseDigest = 'fedcba9876543210'
  const releaseDir = path.join(root, 'runtime', 'releases', releaseDigest)
  fs.mkdirSync(releaseDir, { recursive: true })
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), '{}\n')
  const config = { ...loadConfig(root), digest: releaseDigest }

  const manager = createPrivateConfigManager(config)
  const status = manager.status()
  const linked = createConfigRevisionStore({ root }).read(status.loadedRevision)

  assert.equal(status.loadedRevision, status.pendingRevision)
  assert.equal(linked.manifest.releaseDigest, releaseDigest)
  assert.equal(linked.snapshot.envText, fs.readFileSync(path.join(root, 'config', 'channels.local.env'), 'utf8'))
  assert.equal(linked.snapshot.routesText, fs.readFileSync(path.join(root, 'config', 'routes.local.json'), 'utf8'))
})

test('manual revision pruning protects both loaded and pending revisions', () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root))
  const loadedRevision = manager.status().loadedRevision
  manager.createChannel({
    id: 'history',
    name: 'History Channel',
    baseUrl: 'https://history.example.test/v1',
    apiKey: 'history_secret_key_123456',
    protocol: 'responses',
    priority: 1
  })
  manager.updateChannel('history', { name: 'History Updated' })
  manager.updateChannel('history', { priority: 2 })
  const pendingRevision = manager.status().pendingRevision

  const result = manager.pruneRevisions({ keep: 1 })

  assert.equal(result.removedCount, 2)
  assert.equal(result.restartRequired, true)
  assert.equal(result.revision, pendingRevision)
  const store = createConfigRevisionStore({ root })
  assert.equal(store.read(loadedRevision).manifest.revision, loadedRevision)
  assert.equal(store.read(pendingRevision).manifest.revision, pendingRevision)
  assert.equal(manager.status().revisionStorage.count, 2)
  assert.equal(loadConfig(root).channels.find(channel => channel.id === 'history').priority, 2)
})

test('stable aliases may temporarily point to a disabled channel', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].enabled = false
  routes.stableAliases = [{ alias: 'coding-main', channel: 'sample', model: 'model-a' }]
  fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2))
  const config = loadConfig(root)
  assert.equal(config.channels[0].enabled, false)
  assert.equal(config.stableAliases[0].channel, 'sample')
})

test('routes schema migration is explicit, revisioned, and semantically empty', () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root))
  const migrated = manager.migrateRoutesSchema()
  assert.equal(migrated.changed, true)
  assert.equal(migrated.fromSchemaVersion, 1)
  assert.equal(migrated.toSchemaVersion, 2)
  const routes = JSON.parse(fs.readFileSync(path.join(root, 'config', 'routes.local.json'), 'utf8'))
  assert.equal(routes.schemaVersion, 2)
  assert.deepEqual(routes.logicalModels, [])
  assert.equal(createConfigRevisionStore({ root }).read(migrated.revision).manifest.operation, 'routes-schema-migrate')
  const unchanged = manager.migrateRoutesSchema()
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.revision, migrated.revision)
})

test('model status and stable alias changes are revisioned and prevent broken routes', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].models.push({ upstream: 'model-b', protocol: 'responses', aliases: ['sample/model-b'] })
  fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2))
  const manager = createPrivateConfigManager(loadConfig(root))

  const main = manager.setStableAlias('coding-main', 'sample', 'model-a')
  assert.equal(main.alias, 'coding-main')
  assert.equal(main.restartRequired, true)
  const revisionCount = manager.revisions().length
  const unchanged = manager.setStableAlias('coding-main', 'sample', 'model-a')
  assert.equal(unchanged.revision, main.revision)
  assert.equal(manager.revisions().length, revisionCount)
  assert.throws(
    () => manager.updateModelStatus('sample', 'model-a', 'disabled'),
    error => error.code === 'model_has_aliases'
  )

  manager.setStableAlias('coding-main', 'sample', 'model-b')
  const disabled = manager.updateModelStatus('sample', 'model-a', 'disabled')
  assert.equal(disabled.status, 'disabled')
  assert.throws(
    () => manager.setStableAlias('coding-backup', 'sample', 'model-a'),
    error => error.code === 'model_disabled'
  )

  const routing = manager.routing()
  assert.deepEqual(routing.stableAliases, [{ alias: 'coding-main', channel: 'sample', model: 'model-b' }])
  assert.equal(routing.models.find(item => item.model === 'model-a').status, 'disabled')
  assert.equal(loadConfig(root).channels[0].models.find(model => model.upstream === 'model-a').status, 'disabled')
})

test('logical model CRUD and logical stable aliases are atomic and reference-safe', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].models.push({ upstream: 'model-b', protocol: 'responses', aliases: ['sample/model-b'] })
  fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2))
  const manager = createPrivateConfigManager(loadConfig(root))

  const created = manager.createLogicalModel({
    id: 'coding-pool',
    candidates: [
      { channel: 'sample', model: 'model-a', enabled: true, priority: 20 },
      { channel: 'sample', model: 'model-b', enabled: true, priority: 10 }
    ]
  })
  assert.equal(created.restartRequired, true)
  const revision = createConfigRevisionStore({ root }).read(created.revision)
  assert.equal(revision.manifest.operation, 'logical-model-create')
  assert.deepEqual(revision.manifest.affected.logicalModelIds, ['coding-pool'])
  assert.equal(JSON.parse(revision.snapshot.routesText).schemaVersion, 2)

  const alias = manager.setStableAlias('coding-main', { logicalModel: 'coding-pool' })
  assert.equal(alias.logicalModel, 'coding-pool')
  assert.deepEqual(manager.routing().stableAliases, [{ alias: 'coding-main', logicalModel: 'coding-pool' }])
  assert.throws(
    () => manager.updateModelStatus('sample', 'model-a', 'disabled'),
    error => error.code === 'model_has_aliases'
  )

  manager.updateLogicalModel('coding-pool', {
    candidates: [
      { channel: 'sample', model: 'model-a', enabled: false, priority: 20 },
      { channel: 'sample', model: 'model-b', enabled: true, priority: 30 }
    ]
  })
  assert.equal(manager.updateModelStatus('sample', 'model-a', 'disabled').status, 'disabled')
  assert.throws(() => manager.deleteLogicalModel('coding-pool'), error => error.code === 'logical_model_has_aliases')

  manager.setStableAlias('coding-main', 'sample', 'model-b')
  const deleted = manager.deleteLogicalModel('coding-pool')
  assert.equal(deleted.deleted, true)
  assert.deepEqual(loadConfig(root).logicalModels, [])
})

test('admin model synchronization is read-only upstream, revisioned, and marks discovered inventory', async () => {
  const root = fixtureRoot()
  const config = loadConfig(root)
  const calls = []
  const manager = createPrivateConfigManager(config, {
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), headers: options.headers })
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) }
    }
  })
  const result = await manager.syncModels(['sample'])
  assert.equal(result.changed, true)
  assert.equal(result.channels[0].added, 1)
  const revision = createConfigRevisionStore({ root }).read(result.revision)
  assert.equal(revision.manifest.operation, 'model-sync')
  assert.deepEqual(revision.manifest.affected.channelIds, ['sample'])
  assert.deepEqual(revision.manifest.affected.modelIds, ['sample/model-a', 'sample/model-b'])
  assert.equal(JSON.parse(revision.snapshot.routesText).channels[0].models.some(model => model.upstream === 'model-b'), true)
  assert.equal(revision.snapshot.envText.includes('sample_secret_key_123456'), true)
  assert.equal(calls[0].url, 'https://sample.example.test/v1/models')
  assert.equal(calls[0].headers.Authorization, 'Bearer sample_secret_key_123456')
  assert.equal(loadConfig(root).channels[0].models.some(model => model.upstream === 'model-b'), true)
  const unchanged = await manager.syncModels(['sample'])
  assert.equal(unchanged.changed, false)
  assert.equal(unchanged.restartRequired, true)
})

test('an external valid file change is recorded as a linked revision', () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root))
  const baseline = manager.status().revision
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].priority = 7
  fs.writeFileSync(routesPath, `${JSON.stringify(routes, null, 2)}\n`)

  const status = manager.status()
  const revision = manager.revisions().find(item => item.revision === status.pendingRevision)
  assert.equal(revision.operation, 'external-change')
  assert.equal(revision.parentRevision, baseline)
  assert.equal(status.restartRequired, true)
})

test('restores private files when the revision manifest cannot be committed', () => {
  const root = fixtureRoot()
  const store = createConfigRevisionStore({ root })
  let rejectWrites = false
  const revisionStore = {
    ...store,
    create(input) {
      if (rejectWrites) throw new Error('fixture revision failure')
      return store.create(input)
    }
  }
  const manager = createPrivateConfigManager(loadConfig(root), { revisionStore })
  const envPath = path.join(root, 'config', 'channels.local.env')
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const beforeEnv = fs.readFileSync(envPath, 'utf8')
  const beforeRoutes = fs.readFileSync(routesPath, 'utf8')
  rejectWrites = true

  assert.throws(
    () => manager.createChannel({
      id: 'rejected',
      name: 'Rejected',
      baseUrl: 'https://rejected.example.test/v1',
      apiKey: 'rejected_secret_key_123456',
      protocol: 'responses',
      priority: 2
    }),
    error => error.code === 'configuration_revision_failed'
  )
  assert.equal(fs.readFileSync(envPath, 'utf8'), beforeEnv)
  assert.equal(fs.readFileSync(routesPath, 'utf8'), beforeRoutes)
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'rejected'), false)
  assert.equal(store.list().length, 1)
})

test('prepares a rollback revision and restores the prior snapshot on runtime failure', () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root))
  const baseline = manager.status().revision
  const created = manager.createChannel({
    id: 'rollback',
    name: 'Rollback',
    baseUrl: 'https://rollback.example.test/v1',
    apiKey: 'rollback_secret_key_123456',
    protocol: 'responses',
    priority: 3
  })
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'rollback'), true)

  const transaction = manager.prepareRollback(baseline)
  assert.equal(transaction.changed, true)
  assert.equal(manager.revisions().find(item => item.revision === transaction.revision).operation, 'runtime-rollback')
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'rollback'), false)

  manager.restoreRollback(transaction)
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'rollback'), true)
  assert.equal(manager.status().pendingRevision, created.revision)
  assert.equal(manager.status().restartRequired, true)
})

test('rejects a corrupted rollback target without changing the current private files', () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root))
  const baseline = manager.status().revision
  manager.createChannel({
    id: 'current',
    name: 'Current',
    baseUrl: 'https://current.example.test/v1',
    apiKey: 'current_secret_key_123456',
    protocol: 'responses',
    priority: 4
  })
  const envPath = path.join(root, 'config', 'channels.local.env')
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const beforeEnv = fs.readFileSync(envPath, 'utf8')
  const beforeRoutes = fs.readFileSync(routesPath, 'utf8')
  fs.appendFileSync(path.join(root, 'runtime', 'config-revisions', baseline, 'routes.local.json'), '\ntampered')

  assert.throws(() => manager.prepareRollback(baseline), error => error.code === 'revision_invalid')
  assert.equal(fs.readFileSync(envPath, 'utf8'), beforeEnv)
  assert.equal(fs.readFileSync(routesPath, 'utf8'), beforeRoutes)
})

test('a newly created staged channel can be synchronized without enabling it', async () => {
  const root = fixtureRoot()
  const manager = createPrivateConfigManager(loadConfig(root), {
    fetchImpl: async (url, options) => {
      assert.equal(url.toString(), 'https://new.example.test/v1/models')
      assert.equal(options.headers.Authorization, 'Bearer new_channel_key_123456')
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'new-model' }] }) }
    }
  })
  const created = manager.createChannel({
    id: 'new',
    name: 'New Channel',
    baseUrl: 'https://new.example.test/v1',
    apiKey: 'new_channel_key_123456',
    protocol: 'openai-compatible',
    priority: 5
  })
  const synced = await manager.syncModels(['new'])
  assert.equal(created.staged, true)
  assert.equal(synced.changed, true)
  assert.equal(synced.channels[0].discovered, 1)
  const loaded = loadConfig(root)
  assert.equal(loaded.channels.find(channel => channel.id === 'new').staged, true)
  assert.equal(loaded.channels.find(channel => channel.id === 'new').enabled, false)
  assert.equal(loaded.channels.find(channel => channel.id === 'new').models[0].upstream, 'new-model')
})

test('discovers env-only channels and imports them as staged without exposing the API key', () => {
  const root = fixtureRoot()
  fs.appendFileSync(path.join(root, 'config', 'channels.local.env'), '\n' + [
    'CHANNEL_NEW_NAME=New Channel',
    'CHANNEL_NEW_BASE_URL=https://new.example.test/v1',
    'CHANNEL_NEW_API_KEY=fixture-new-channel-key',
    'CHANNEL_NEW_PROTOCOL=responses',
    'CHANNEL_NEW_ENABLED=true'
  ].join('\n') + '\n')
  const manager = createPrivateConfigManager(loadConfig(root))
  const discovered = manager.discoverChannels()
  assert.equal(discovered.unregistered[0].id, 'new')
  assert.equal(discovered.unregistered[0].ready, true)
  assert.equal(JSON.stringify(discovered).includes('fixture-new-channel-key'), false)

  const imported = manager.importChannel('new')
  assert.equal(imported.staged, true)
  assert.equal(loadConfig(root).channels.find(channel => channel.id === 'new').runtimeEnabled, true)
  assert.ok(manager.discoverChannels().pendingRestart.some(channel => channel.id === 'new'))
})

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-config-manager-'))
  fs.mkdirSync(path.join(root, 'config'))
  fs.mkdirSync(path.join(root, 'runtime'))
  fs.copyFileSync(new URL('../config/gateway.json', import.meta.url), path.join(root, 'config', 'gateway.json'))
  fs.writeFileSync(path.join(root, 'config', 'channels.local.env'), [
    'GATEWAY_API_KEY=fixture_gateway_key_that_is_long_enough_123456',
    'CHANNEL_SAMPLE_NAME=Sample',
    'CHANNEL_SAMPLE_BASE_URL=https://sample.example.test/v1',
    'CHANNEL_SAMPLE_API_KEY=sample_secret_key_123456',
    'CHANNEL_SAMPLE_PROTOCOL=responses',
    'CHANNEL_SAMPLE_ENABLED=true'
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'config', 'routes.local.json'), JSON.stringify({
    schemaVersion: 1,
    channels: [{ id: 'sample', enabled: true, models: [{ upstream: 'model-a', protocol: 'responses', aliases: ['sample/model-a'] }] }],
    stableAliases: [],
    pinnedAliases: []
  }, null, 2))
  return root
}
