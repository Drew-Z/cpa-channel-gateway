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
  assert.equal(created.hasApiKey, true)
  assert.equal(JSON.stringify(created).includes('backup_secret_key'), false)
  assert.equal(JSON.stringify(created).includes('backup.example.test'), false)
  assert.equal(manager.status().restartRequired, true)
  assert.equal(loadConfig(root).channels.some(channel => channel.id === 'backup' && !channel.enabled), true)

  assert.throws(
    () => manager.updateChannel('backup', { enabled: true }),
    error => error.code === 'configuration_validation_failed'
  )
  assert.equal(loadConfig(root).channels.find(channel => channel.id === 'backup').enabled, false)
  assert.ok(fs.readdirSync(path.join(root, 'runtime', 'config-revisions')).length >= 2)

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
