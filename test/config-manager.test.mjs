import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPrivateConfigManager } from '../src/config-manager.mjs'
import { loadConfig } from '../src/config.mjs'

test('channel mutations are private, revisioned, validated, and restart-required', () => {
  const root = fixtureRoot()
  const config = loadConfig(root)
  const manager = createPrivateConfigManager(config)
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
  assert.equal(manager.status().restartRequired, true)
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'backup' && !channel.enabled && channel.staged && channel.runtimeEnabled), true)

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
  assert.match(result.backup, /^runtime\/config-revisions\//)
  assert.equal(calls[0].url, 'https://sample.example.test/v1/models')
  assert.equal(calls[0].headers.Authorization, 'Bearer sample_secret_key_123456')
  assert.equal(loadConfig(root).channels[0].models.some(model => model.upstream === 'model-b'), true)
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
