import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { buildLocalBaseUrl } from '../src/cpa.mjs'
import { generateRelease } from '../src/generate.mjs'

test('generates protocol-specific CPA sections and one HAProxy queue per channel', () => {
  const root = fixtureRoot()
  const result = generateRelease(root)
  assert.match(result.cpa, /^openai-compatibility:$/m)
  assert.match(result.cpa, /^codex-api-key:$/m)
  assert.match(result.cpa, /^claude-api-key:$/m)
  assert.match(result.cpa, /alias: "coding-main"/)
  assert.match(result.cpa, /alias: "ai-daily-v1"/)
  assert.match(result.cpa, /request-retry: 0/)
  assert.match(result.cpa, /identity-confuse: false/)
  assert.match(result.cpa, /disable-codex-cloaking: false/)
  assert.match(result.cpa, /^host: "127\.0\.0\.1"$/m)
  assert.match(result.cpa, /^port: 24675$/m)
  assert.doesNotMatch(result.cpa, /^\s+prefix:/m)
  assert.equal((result.haproxy.match(/ maxconn 1 maxqueue 8 /g) ?? []).length, 3)
  assert.equal((result.haproxy.match(/^frontend channel_/gm) ?? []).length, 3)
  assert.match(result.haproxy, /^  log global$/m)
  assert.match(result.haproxy, /alpn http\/1\.1/)
  assert.doesNotMatch(result.haproxy, /http-request set-path/)
  assert.match(result.cpa, /base-url: "http:\/\/127\.0\.0\.1:19001\/v1"/)
  assert.match(result.cpa, /base-url: "http:\/\/127\.0\.0\.1:19002\/v1"/)
  assert.match(result.cpa, /base-url: "http:\/\/127\.0\.0\.1:19003"/)
  assert.match(result.cpa, /alias: "chat\/model-a"/)
  assert.ok(!result.cpa.includes('https://chat.example.test'))
  assert.ok(!result.haproxy.includes('secret-chat'))
  assert.equal(result.cloudflareTunnel.enabled, false)
})

test('normalizes CPA executor paths without duplicating the upstream v1 segment', () => {
  const gateway = { internal: { host: '127.0.0.1' } }
  const channel = { listener: 19001, upstream: new URL('https://upstream.example.test/proxy/v1') }
  const chatBase = buildLocalBaseUrl(gateway, channel, 'openai-compatible')
  const responsesBase = buildLocalBaseUrl(gateway, channel, 'responses')
  const claudeBase = buildLocalBaseUrl(gateway, channel, 'claude')
  assert.equal(new URL(`${chatBase}/chat/completions`).pathname, '/proxy/v1/chat/completions')
  assert.equal(new URL(`${responsesBase}/responses`).pathname, '/proxy/v1/responses')
  assert.equal(new URL(`${claudeBase}/v1/messages`).pathname, '/proxy/v1/messages')
  assert.equal(new URL(`${claudeBase}/v1/messages/count_tokens`).pathname, '/proxy/v1/messages/count_tokens')
})

test('rejects duplicate aliases and non-serial queue settings', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[1].models[0].aliases = ['chat/model']
  fs.writeFileSync(routesPath, JSON.stringify(routes))
  assert.throws(() => loadConfig(root), /Duplicate client alias/)

  const second = fixtureRoot()
  const gatewayPath = path.join(second, 'config', 'gateway.json')
  const gateway = JSON.parse(fs.readFileSync(gatewayPath, 'utf8'))
  gateway.queue.maxConnectionsPerChannel = 2
  fs.writeFileSync(gatewayPath, JSON.stringify(gateway))
  assert.throws(() => loadConfig(second), /must be exactly 1/)

  const third = fixtureRoot()
  const thirdGatewayPath = path.join(third, 'config', 'gateway.json')
  const thirdGateway = JSON.parse(fs.readFileSync(thirdGatewayPath, 'utf8'))
  thirdGateway.cpa.disableCodexCloaking = 'false'
  fs.writeFileSync(thirdGatewayPath, JSON.stringify(thirdGateway))
  assert.throws(() => loadConfig(third), /cpa\.disableCodexCloaking must be boolean/)
})

test('does not fall back to example secrets during normal validation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-missing-'))
  fs.mkdirSync(path.join(root, 'config'))
  copy('gateway.json', root)
  assert.throws(() => loadConfig(root), /Missing private configuration/)
})

test('accepts namespaced upstream model ids and permits empty enabled channels only for discovery', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].models[0].upstream = 'Provider/Model-A:free'
  routes.channels[0].models[0].aliases = ['chat/Provider/Model-A:free']
  routes.pinnedAliases[0].model = 'Provider/Model-A:free'
  fs.writeFileSync(routesPath, JSON.stringify(routes))
  assert.equal(loadConfig(root).channels[0].models[0].aliases[0], 'chat/Provider/Model-A:free')

  routes.channels[0].models = []
  routes.pinnedAliases = []
  fs.writeFileSync(routesPath, JSON.stringify(routes))
  assert.throws(() => loadConfig(root), /Enabled channel chat has no models/)
  assert.equal(loadConfig(root, { allowEmptyEnabledChannels: true }).channels[0].models.length, 0)
})

test('accepts disabled models without exposing them through generated CPA config', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].models.push({
    upstream: 'retired-model',
    status: 'disabled',
    aliases: ['chat/retired-model']
  })
  routes.stableAliases.push({ alias: 'retired-main', channel: 'chat', model: 'retired-model' })
  fs.writeFileSync(routesPath, JSON.stringify(routes))
  assert.equal(loadConfig(root).channels[0].models.find(model => model.upstream === 'retired-model').status, 'disabled')
  const generated = generateRelease(root)
  assert.doesNotMatch(generated.cpa, /retired-model|chat\/retired-model/)
})

test('normalizes model capabilities and rejects non-generation stable aliases', () => {
  const root = fixtureRoot()
  const routesPath = path.join(root, 'config', 'routes.local.json')
  const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  routes.channels[0].models.push({
    upstream: 'text-embedding-3-small',
    aliases: ['chat/text-embedding-3-small']
  })
  fs.writeFileSync(routesPath, JSON.stringify(routes))
  const loaded = loadConfig(root)
  const embedding = loaded.channels[0].models.find(model => model.upstream === 'text-embedding-3-small')
  assert.equal(embedding.kind, 'embedding')
  assert.equal(embedding.streaming, 'both')
  assert.equal(embedding.canaryEligible, false)

  routes.stableAliases.push({ alias: 'embedding-main', channel: 'chat', model: 'text-embedding-3-small' })
  fs.writeFileSync(routesPath, JSON.stringify(routes))
  assert.throws(() => loadConfig(root), /must reference a generation model/)
})

test('requires a private token only when Cloudflare Tunnel is enabled', () => {
  const enabledRoot = fixtureRoot()
  const enabledEnv = path.join(enabledRoot, 'config', 'channels.local.env')
  fs.appendFileSync(enabledEnv, '\nCLOUDFLARE_TUNNEL_ENABLED=true\nCLOUDFLARE_TUNNEL_TOKEN=fixture_tunnel_token_that_is_long_enough_123456\n')
  const enabled = loadConfig(enabledRoot)
  assert.equal(enabled.cloudflareTunnel.enabled, true)
  assert.equal(enabled.cloudflareTunnel.credential, 'fixture_tunnel_token_that_is_long_enough_123456')
  const generated = generateRelease(enabledRoot)
  const releaseText = [
    generated.cpa,
    generated.haproxy,
    fs.readFileSync(path.join(generated.releaseDir, 'manifest.json'), 'utf8')
  ].join('\n')
  assert.doesNotMatch(releaseText, /fixture_tunnel_token_that_is_long_enough_123456/)

  const missingRoot = fixtureRoot()
  const missingEnv = path.join(missingRoot, 'config', 'channels.local.env')
  fs.appendFileSync(missingEnv, '\nCLOUDFLARE_TUNNEL_ENABLED=true\nCLOUDFLARE_TUNNEL_TOKEN=\n')
  assert.throws(() => loadConfig(missingRoot), /CLOUDFLARE_TUNNEL_TOKEN is missing/)
})

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-fixture-'))
  fs.mkdirSync(path.join(root, 'config'))
  copy('gateway.json', root)
  fs.writeFileSync(path.join(root, 'config', 'channels.local.env'), [
    'GATEWAY_API_KEY=fixture_gateway_key_that_is_long_enough_123456',
    'CHANNEL_CHAT_NAME=Chat',
    'CHANNEL_CHAT_BASE_URL=https://chat.example.test/v1',
    'CHANNEL_CHAT_API_KEY=secret-chat',
    'CHANNEL_CHAT_PROTOCOL=openai-compatible',
    'CHANNEL_CHAT_ENABLED=true',
    'CHANNEL_RESPONSES_NAME=Responses',
    'CHANNEL_RESPONSES_BASE_URL=https://responses.example.test/v1',
    'CHANNEL_RESPONSES_API_KEY=secret-responses',
    'CHANNEL_RESPONSES_PROTOCOL=responses',
    'CHANNEL_RESPONSES_ENABLED=true',
    'CHANNEL_CLAUDE_NAME=Claude',
    'CHANNEL_CLAUDE_BASE_URL=https://claude.example.test/v1',
    'CHANNEL_CLAUDE_API_KEY=secret-claude',
    'CHANNEL_CLAUDE_PROTOCOL=claude',
    'CHANNEL_CLAUDE_ENABLED=true'
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'config', 'routes.local.json'), JSON.stringify({
    schemaVersion: 1,
    channels: [
      { id: 'chat', models: [{ upstream: 'model-a', aliases: ['chat/model'] }, { upstream: 'model-a-responses', protocol: 'responses', aliases: ['chat/model-responses'] }] },
      { id: 'responses', models: [{ upstream: 'model-b', aliases: ['responses/model'] }] },
      { id: 'claude', models: [{ upstream: 'model-c', aliases: ['claude/model'] }] }
    ],
    stableAliases: [{ alias: 'coding-main', channel: 'responses', model: 'model-b' }],
    pinnedAliases: [{ alias: 'ai-daily-v1', channel: 'chat', model: 'model-a', approvalRef: 'approval-001' }]
  }, null, 2))
  return root
}

function copy(name, root) {
  fs.copyFileSync(new URL(`../config/${name}`, import.meta.url), path.join(root, 'config', name))
}
