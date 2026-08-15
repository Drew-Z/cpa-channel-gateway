import assert from 'node:assert/strict'
import test from 'node:test'
import { buildModelCatalogUrl, canonicalModelAlias, fetchChannelModels, selectChannelsForSync, synchronizeRouteModels } from '../src/model-sync.mjs'

test('builds model catalog URLs from the configured upstream base path', () => {
  assert.equal(buildModelCatalogUrl(new URL('https://api.example.test/v1')).toString(), 'https://api.example.test/v1/models')
  assert.equal(buildModelCatalogUrl(new URL('https://api.example.test/custom/v1/')).toString(), 'https://api.example.test/custom/v1/models')
  assert.equal(buildModelCatalogUrl(new URL('https://api.example.test')).toString(), 'https://api.example.test/models')
})

test('selects enabled channels by default and explicit disabled channels by id', () => {
  const channels = [{ id: 'free', enabled: true }, { id: 'free3', enabled: false }]
  assert.deepEqual(selectChannelsForSync(channels).map(channel => channel.id), ['free'])
  assert.deepEqual(selectChannelsForSync(channels, ['free3']).map(channel => channel.id), ['free3'])
  assert.throws(() => selectChannelsForSync(channels, ['missing']), /Unknown channels/)
})

test('fetches paginated model catalogs with protocol-appropriate authentication', async () => {
  const calls = []
  const pages = [
    { data: [{ id: 'Model-A' }, { id: 'provider/model-b:free' }], has_more: true, last_id: 'provider/model-b:free' },
    { data: [{ id: 'provider/model-b:free' }, { id: 'model-c' }], has_more: false }
  ]
  const channel = {
    id: 'sample',
    upstream: new URL('https://api.example.test/v1'),
    apiKey: 'private-key',
    protocol: 'claude'
  }
  const models = await fetchChannelModels(channel, {
    fetchImpl: async (url, options) => {
      calls.push({ url: url.toString(), headers: options.headers })
      return { ok: true, status: 200, json: async () => pages[calls.length - 1] }
    }
  })
  assert.deepEqual(models, ['Model-A', 'provider/model-b:free', 'model-c'])
  assert.equal(calls[1].url, 'https://api.example.test/v1/models?after_id=provider%2Fmodel-b%3Afree')
  assert.equal(calls[0].headers.Authorization, 'Bearer private-key')
  assert.equal(calls[0].headers['x-api-key'], 'private-key')
  assert.equal(calls[0].headers['anthropic-version'], '2023-06-01')
})

test('synchronizes complete channel inventories while preserving reviewed metadata', () => {
  const routes = {
    schemaVersion: 1,
    channels: [{
      id: 'sample',
      models: [
        {
          upstream: 'Model-A',
          protocol: 'responses',
          aliases: ['custom-a'],
          maxContextLength: 128000,
          thinkingLevels: ['high']
        },
        { upstream: 'stale-model', aliases: ['sample/stale-model'] }
      ]
    }],
    stableAliases: [],
    pinnedAliases: []
  }
  const result = synchronizeRouteModels(routes, new Map([
    ['sample', ['Model-A', 'provider/model-b:free']]
  ]))
  assert.deepEqual(result.summaries, [{ channel: 'sample', before: 2, discovered: 2, added: 1, removed: 1, preservedReferenced: 0, after: 2 }])
  const reviewed = result.routes.channels[0].models.find(model => model.upstream === 'Model-A')
  assert.equal(reviewed.maxContextLength, 128000)
  assert.deepEqual(reviewed.thinkingLevels, ['high'])
  assert.deepEqual(reviewed.aliases, ['custom-a', 'sample/Model-A'])
  const added = result.routes.channels[0].models.find(model => model.upstream === 'provider/model-b:free')
  assert.deepEqual(added.aliases, ['sample/provider/model-b:free'])
  assert.equal(canonicalModelAlias('sample', 'provider/model-b:free'), 'sample/provider/model-b:free')
})

test('preserves stale models until stable or pinned aliases move away from them', () => {
  const routes = {
    schemaVersion: 1,
    channels: [{ id: 'sample', models: [{ upstream: 'old-model', aliases: ['sample/old-model'] }] }],
    stableAliases: [{ alias: 'coding-main', channel: 'sample', model: 'old-model' }],
    pinnedAliases: []
  }
  const result = synchronizeRouteModels(routes, new Map([['sample', ['new-model']]]))
  assert.deepEqual(result.routes.channels[0].models.map(model => model.upstream), ['new-model', 'old-model'])
  assert.deepEqual(result.summaries, [{
    channel: 'sample',
    before: 1,
    discovered: 1,
    added: 1,
    removed: 0,
    preservedReferenced: 1,
    after: 2
  }])
})
