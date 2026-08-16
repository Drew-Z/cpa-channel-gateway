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

test('restores validated health state and persists expired cooldown cleanup', () => {
  let clock = 1_000
  const changes = []
  const scheduler = createModelScheduler(fixtureConfig(), {
    now: () => clock,
    initialState: {
      channels: {
        alpha: { health: 'cooling', cooldownUntil: 2_000, updatedAt: 900 },
        beta: { health: 'auth-failed', updatedAt: 900 },
        unknown: { health: 'healthy', updatedAt: 900 }
      }
    },
    onStateChange: state => {
      changes.push(state)
      throw new Error('Persistence callbacks must not affect routing')
    }
  })
  assert.throws(() => scheduler.reserve('shared-model'), error => error.code === 'no_eligible_candidates')

  clock = 2_001
  const selection = scheduler.reserve('shared-model')
  assert.equal(selection.candidate.channelId, 'alpha')
  selection.release()
  assert.equal(changes.length, 1)
  assert.equal(changes[0].channels.alpha, undefined)
  assert.equal(changes[0].channels.beta.health, 'auth-failed')

  assert.doesNotThrow(() => scheduler.recordTransportError({ candidate: { channelId: 'alpha' } }))
  assert.equal(changes.length, 2)
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

test('disabled models are absent from public catalog and cannot be reserved', () => {
  const config = fixtureConfig()
  config.channels[0].models[0].status = 'disabled'
  const scheduler = createModelScheduler(config)
  const publicIds = scheduler.catalog.listPublicModels().map(item => item.id)
  assert.ok(!publicIds.includes('alpha/shared-model'))
  assert.throws(
    () => scheduler.reserve('alpha/shared-model'),
    error => error instanceof GatewayRoutingError && error.code === 'model_not_found'
  )
  const logical = scheduler.reserve('shared-model')
  assert.equal(logical.candidate.channelId, 'beta')
  logical.release()
})

test('filters candidates by requested streaming mode without silent downgrade', () => {
  const config = fixtureConfig()
  config.channels[0].models[0].streaming = 'stream-only'
  config.channels[1].models[0].streaming = 'non-stream-only'
  const scheduler = createModelScheduler(config)

  const stream = scheduler.reserve('shared-model', { streaming: 'stream' })
  assert.equal(stream.candidate.channelId, 'alpha')
  stream.release()

  const nonStream = scheduler.reserve('shared-model', { streaming: 'non-stream' })
  assert.equal(nonStream.candidate.channelId, 'beta')
  nonStream.release()

  const onlyStream = { ...fixtureConfig(), channels: [fixtureConfig().channels[0]] }
  onlyStream.channels[0].models[0].streaming = 'stream-only'
  const streamOnlyScheduler = createModelScheduler(onlyStream)
  assert.throws(
    () => streamOnlyScheduler.reserve('shared-model', { streaming: 'non-stream' }),
    error => error instanceof GatewayRoutingError && error.code === 'streaming_not_supported' && error.statusCode === 422
  )
})

test('reports unavailable instead of unsupported when the only streaming candidate is blocked', () => {
  const config = fixtureConfig()
  config.channels[0].models[0].streaming = 'stream-only'
  config.channels[1].models[0].streaming = 'non-stream-only'
  const scheduler = createModelScheduler(config)
  const failed = scheduler.reserve('shared-model', { streaming: 'stream' })
  scheduler.recordOutcome(failed, 401)
  failed.release()

  assert.throws(
    () => scheduler.reserve('shared-model', { streaming: 'stream' }),
    error => error instanceof GatewayRoutingError && error.code === 'no_eligible_candidates' && error.statusCode === 503
  )
})

test('marks protocol status errors as misconfigured candidates', () => {
  for (const statusCode of [400, 422]) {
    const scheduler = createModelScheduler(fixtureConfig())
    const failed = scheduler.reserve('shared-model')
    scheduler.recordOutcome(failed, statusCode)
    failed.release()
    const next = scheduler.reserve('shared-model')
    assert.equal(next.candidate.channelId, 'beta')
    next.release()
  }
})

test('non-generation models remain auditable but are absent from public routing', () => {
  const config = fixtureConfig()
  config.channels[0].models.push({
    upstream: 'text-embedding-3-small',
    kind: 'embedding',
    aliases: ['alpha/text-embedding-3-small']
  })
  config.stableAliases.push({ alias: 'embedding-main', channel: 'alpha', model: 'text-embedding-3-small' })
  const scheduler = createModelScheduler(config)
  const publicIds = scheduler.catalog.listPublicModels().map(item => item.id)
  assert.ok(!publicIds.includes('text-embedding-3-small'))
  assert.ok(!publicIds.includes('alpha/text-embedding-3-small'))
  assert.ok(!publicIds.includes('embedding-main'))
  assert.ok(scheduler.catalog.allModels.get('text-embedding-3-small'))
  assert.throws(() => scheduler.reserve('alpha/text-embedding-3-small'), error => error.code === 'model_not_found')
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
