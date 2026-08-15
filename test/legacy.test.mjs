import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeLegacyConfig, readLegacyChannels } from '../src/legacy.mjs'

test('legacy reader normalizes old chat completion protocol names', () => {
  const channels = readLegacyChannels({
    AI_PROVIDER_NAME: 'Free',
    AI_BASE_URL: 'https://free.example.test/v1',
    AI_API_KEY: 'legacy-free-key',
    AI_API_PROTOCOL: 'responses',
    PROVIDER_NAME3: 'Free3',
    BASE_URL3: 'https://free3.example.test/v1',
    API_KEY3: 'legacy-free3-key',
    PROVIDER_NAME5: 'Free5',
    BASE_URL5: 'https://free5.example.test/v1',
    API_KEY5: 'legacy-free5-key',
    API_PROTOCOL5: 'chat/completion',
    PROVIDER_NAME7: 'Free7',
    BASE_URL7: 'https://free7.example.test/v1/chat/completions',
    API_KEY7: 'legacy-free7-key'
  })
  assert.deepEqual(channels.map(channel => channel.id), ['free', 'free3', 'free5', 'free7'])
  assert.equal(channels[2].protocol, 'openai-compatible')
  assert.equal(channels[2].rawProtocol, 'chat/completion')
  assert.equal(channels[3].baseUrl, 'https://free7.example.test/v1')
})

test('legacy merge preserves private settings, enabled state, models, and aliases', () => {
  const result = mergeLegacyConfig({
    currentEnv: {
      GATEWAY_API_KEY: 'gateway-key',
      CPA_MANAGEMENT_KEY: 'management-key',
      CLOUDFLARE_TUNNEL_ENABLED: 'true',
      CHANNEL_FREE_BASE_URL: 'https://old.example.test/v1',
      CHANNEL_FREE_API_KEY: 'old-key',
      CHANNEL_FREE_PROTOCOL: 'responses',
      CHANNEL_FREE_ENABLED: 'true'
    },
    currentRoutes: {
      schemaVersion: 1,
      channels: [{ id: 'free', enabled: true, models: [{ upstream: 'gpt-4o', aliases: ['free/gpt-4o'] }] }],
      stableAliases: [{ alias: 'coding-main', channel: 'free', model: 'gpt-4o' }],
      pinnedAliases: []
    },
    legacyChannels: [
      { id: 'free', name: 'Free', baseUrl: 'https://new.example.test/v1', rawBaseUrl: 'https://new.example.test/v1', apiKey: 'new-key', protocol: 'responses', rawProtocol: 'responses' },
      { id: 'free3', name: 'Free3', baseUrl: 'https://free3.example.test/v1', rawBaseUrl: 'https://free3.example.test/v1', apiKey: 'free3-key', protocol: 'openai-compatible', rawProtocol: 'openai-compatible' }
    ]
  })
  assert.equal(result.env.GATEWAY_API_KEY, 'gateway-key')
  assert.equal(result.env.CPA_MANAGEMENT_KEY, 'management-key')
  assert.equal(result.env.CHANNEL_FREE_BASE_URL, 'https://new.example.test/v1')
  assert.equal(result.env.CHANNEL_FREE_ENABLED, 'true')
  assert.equal(result.env.CHANNEL_FREE3_ENABLED, 'false')
  assert.deepEqual(result.routes.channels[0].models, [{ upstream: 'gpt-4o', aliases: ['free/gpt-4o'] }])
  assert.deepEqual(result.routes.stableAliases, [{ alias: 'coding-main', channel: 'free', model: 'gpt-4o' }])
  assert.deepEqual(result.report, { added: ['free3'], updated: ['free'], normalizedProtocols: [], normalizedBaseUrls: [] })
})
