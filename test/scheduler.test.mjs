import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelScheduler, GatewayRoutingError } from '../src/scheduler.mjs'

test('aggregates exact model ids and selects an idle alternate channel', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const models = scheduler.catalog.listPublicModels().map(item => item.id)
  assert.ok(models.includes('shared-model'))
  assert.ok(models.includes('alpha/shared-model'))
  assert.ok(models.includes('coding-main'))

  const first = scheduler.reserve('shared-model')
  assert.equal(first.candidate.channelId, 'alpha')
  const second = scheduler.reserve('shared-model')
  assert.equal(second.candidate.channelId, 'beta')
  assert.throws(
    () => scheduler.reserve('shared-model'),
    error => error instanceof GatewayRoutingError && error.code === 'all_candidates_busy' && error.statusCode === 429
  )
  first.release()
  second.release()
})

test('a direct model id cannot bypass a channel-wide reservation', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const active = scheduler.reserve('alpha/shared-model')
  assert.throws(
    () => scheduler.reserve('alpha/other-model'),
    error => error instanceof GatewayRoutingError && error.code === 'all_candidates_busy'
  )
  active.release()
  const next = scheduler.reserve('alpha/other-model')
  assert.equal(next.candidate.upstreamModel, 'other-model')
  next.release()
})

test('passive authentication failure removes a channel from later selection', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const first = scheduler.reserve('shared-model')
  scheduler.recordOutcome(first, 401)
  first.release()
  const next = scheduler.reserve('shared-model')
  assert.equal(next.candidate.channelId, 'beta')
  next.release()
})

test('staged channels are available only to manual exact-model tests', () => {
  const config = fixtureConfig()
  config.channels.push({ ...channel('staged', 200, [model('staged', 'new-model', 200)]), enabled: false, staged: true, runtimeEnabled: true })
  const scheduler = createModelScheduler(config)
  assert.ok(!scheduler.catalog.listPublicModels().some(item => item.id === 'staged/new-model'))
  assert.throws(() => scheduler.reserve('staged/new-model'), error => error.code === 'no_eligible_candidates')
  const testLease = scheduler.reserve('staged/new-model', { source: 'manual-test' })
  assert.equal(testLease.candidate.channelId, 'staged')
  testLease.release()
})

function fixtureConfig() {
  const alpha = channel('alpha', 100, [
    model('alpha', 'shared-model', 100),
    model('alpha', 'other-model', 100)
  ])
  const beta = channel('beta', 50, [model('beta', 'shared-model', 50)])
  return {
    channels: [alpha, beta],
    stableAliases: [{ alias: 'coding-main', channel: 'alpha', model: 'shared-model' }],
    pinnedAliases: []
  }
}

function channel(id, priority, models) {
  return {
    id,
    name: id,
    enabled: true,
    listener: id === 'alpha' ? 19001 : 19002,
    upstream: new URL(`https://${id}.example.test/v1`),
    apiKey: `fixture-${id}-key`,
    protocol: 'responses',
    priority,
    models
  }
}

function model(channelId, upstream, priority) {
  return {
    upstream,
    protocol: 'responses',
    aliases: [`${channelId}/${upstream}`],
    priority,
    inputModalities: ['text'],
    outputModalities: ['text']
  }
}
