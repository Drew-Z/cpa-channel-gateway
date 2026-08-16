import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { createPrivateConfigManager } from '../src/config-manager.mjs'
import { applyProviderMigration, planProviderMigration } from '../src/provider-migration.mjs'

test('provider migration is a dry-run by default and preserves normalized semantics', () => {
  const root = fixtureRoot()
  const beforeEnv = fs.readFileSync(path.join(root, 'config', 'channels.local.env'), 'utf8')
  const beforeRoutes = fs.readFileSync(path.join(root, 'config', 'routes.local.json'), 'utf8')
  const plan = planProviderMigration(root)
  assert.equal(plan.report.providerCount, 2)
  assert.equal(fs.existsSync(path.join(root, 'config', 'providers.local.json')), false)
  assert.equal(fs.readFileSync(path.join(root, 'config', 'channels.local.env'), 'utf8'), beforeEnv)
  assert.equal(fs.readFileSync(path.join(root, 'config', 'routes.local.json'), 'utf8'), beforeRoutes)
  assert.equal(JSON.stringify(plan.report).includes('secret-'), false)
  assert.equal(JSON.stringify(plan.report).includes('example.test'), false)
})

test('applied provider migration strips channel env and keeps channel routing behavior', () => {
  const root = fixtureRoot()
  const legacy = loadConfig(root)
  const result = applyProviderMigration(planProviderMigration(root))
  const migrated = loadConfig(root)
  assert.equal(result.applied, true)
  assert.equal(migrated.providerMode, true)
  assert.deepEqual(migrated.channels.map(channel => ({
    id: channel.id,
    enabled: channel.enabled,
    staged: channel.staged,
    priority: channel.priority,
    protocol: channel.protocol,
    modelCount: channel.models.length
  })), legacy.channels.map(channel => ({
    id: channel.id,
    enabled: channel.enabled,
    staged: channel.staged,
    priority: channel.priority,
    protocol: channel.protocol,
    modelCount: channel.models.length
  })))
  const envText = fs.readFileSync(path.join(root, 'config', 'channels.local.env'), 'utf8')
  assert.doesNotMatch(envText, /CHANNEL_[A-Z0-9_]+_API_KEY/)
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'config', 'routes.local.json'), 'utf8'), /"enabled"|"priority"/)
  const providers = JSON.parse(fs.readFileSync(path.join(root, 'config', 'providers.local.json'), 'utf8'))
  assert.deepEqual(providers.providers.map(provider => provider.id), ['chat', 'responses'])
  assert.equal(JSON.stringify(result).includes('secret-'), false)
})

test('provider-mode manager writes providers without putting channel secrets back into env', async () => {
  const root = fixtureRoot()
  applyProviderMigration(planProviderMigration(root))
  const manager = createPrivateConfigManager(loadConfig(root), {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'backup-model' }] }) })
  })
  const created = manager.createChannel({
    id: 'backup',
    name: 'Backup',
    baseUrl: 'https://backup.example.test/v1',
    apiKey: 'backup-secret-key-123456',
    protocol: 'responses',
    priority: 9
  })
  assert.equal(created.staged, true)
  const providers = JSON.parse(fs.readFileSync(path.join(root, 'config', 'providers.local.json'), 'utf8'))
  assert.equal(providers.providers.find(provider => provider.id === 'backup').apiKey, 'backup-secret-key-123456')
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'config', 'channels.local.env'), 'utf8'), /backup-secret/)
  await manager.syncModels(['backup'])
  manager.updateChannel('backup', { staged: false, enabled: true, priority: 11 })
  assert.equal(loadConfig(root).channels.find(channel => channel.id === 'backup').enabled, true)
  manager.updateChannel('backup', { enabled: false })
  assert.deepEqual(manager.deleteChannel('backup').deleted, true)
})

test('providers and legacy channel env cannot silently coexist', () => {
  const root = fixtureRoot()
  applyProviderMigration(planProviderMigration(root))
  fs.appendFileSync(path.join(root, 'config', 'channels.local.env'), '\nCHANNEL_CHAT_ENABLED=true\n')
  assert.throws(() => loadConfig(root), /cannot coexist/)
})

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-provider-migration-'))
  fs.mkdirSync(path.join(root, 'config'))
  fs.mkdirSync(path.join(root, 'runtime'))
  fs.copyFileSync(new URL('../config/gateway.json', import.meta.url), path.join(root, 'config', 'gateway.json'))
  fs.writeFileSync(path.join(root, 'config', 'channels.local.env'), [
    'GATEWAY_API_KEY=fixture_gateway_key_that_is_long_enough_123456',
    'CPA_MANAGEMENT_KEY=',
    'CHANNEL_CHAT_NAME=Chat',
    'CHANNEL_CHAT_BASE_URL=https://chat.example.test/v1',
    'CHANNEL_CHAT_API_KEY=secret-chat-123456',
    'CHANNEL_CHAT_PROTOCOL=openai-compatible',
    'CHANNEL_CHAT_ENABLED=true',
    'CHANNEL_RESPONSES_NAME=Responses',
    'CHANNEL_RESPONSES_BASE_URL=https://responses.example.test/v1',
    'CHANNEL_RESPONSES_API_KEY=secret-responses-123456',
    'CHANNEL_RESPONSES_PROTOCOL=responses',
    'CHANNEL_RESPONSES_ENABLED=false'
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'config', 'routes.local.json'), JSON.stringify({
    schemaVersion: 1,
    channels: [
      { id: 'chat', enabled: true, priority: 3, models: [{ upstream: 'model-a', aliases: ['chat/model-a'] }] },
      { id: 'responses', enabled: false, priority: 8, models: [{ upstream: 'model-b', aliases: ['responses/model-b'] }] }
    ],
    stableAliases: [],
    pinnedAliases: []
  }, null, 2))
  return root
}
