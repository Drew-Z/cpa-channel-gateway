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

test('explicit logical models merge different upstream ids and honor candidate priority', () => {
  const config = fixtureConfig()
  config.logicalModels = [{
    id: 'coding-pool',
    enabled: true,
    candidates: [
      { channel: 'alpha', model: 'other-model', enabled: true, priority: 10 },
      { channel: 'beta', model: 'shared-model', enabled: true, priority: 200 }
    ]
  }]
  config.stableAliases = [{ alias: 'coding-main', logicalModel: 'coding-pool' }]
  const scheduler = createModelScheduler(config)
  const publicIds = scheduler.catalog.listPublicModels().map(item => item.id)
  assert.ok(publicIds.includes('coding-pool'))
  assert.ok(publicIds.includes('coding-main'))
  assert.ok(publicIds.includes('shared-model'))
  assert.ok(publicIds.includes('alpha/other-model'))
  assert.equal(scheduler.catalog.resolve('coding-pool').logicalModelId, 'coding-pool')
  assert.equal(scheduler.catalog.resolve('coding-main').logicalModelId, 'coding-pool')
  assert.equal(scheduler.catalog.resolve('shared-model').logicalModelId, 'shared-model')
  assert.equal(scheduler.catalog.resolve('alpha/other-model').logicalModelId, 'other-model')

  const first = scheduler.reserve('coding-pool')
  assert.equal(first.candidate.channelId, 'beta')
  const second = scheduler.reserve('coding-main')
  assert.equal(second.candidate.channelId, 'alpha')
  first.release()
  second.release()

  const direct = scheduler.reserve('alpha/other-model')
  assert.equal(direct.candidate.upstreamModel, 'other-model')
  direct.release()
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
  const status = scheduler.candidateStatus(scheduler.catalog.resolve('alpha/shared-model').candidates[0])
  assert.equal(status.lastStatusCode, 401)
  const next = scheduler.reserve('shared-model')
  assert.equal(next.candidate.channelId, 'beta')
  next.release()
})

test('channel health reset clears only the selected authentication blocker', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const alpha = scheduler.reserve('alpha/shared-model')
  scheduler.recordOutcome(alpha, 403)
  alpha.release()
  const beta = scheduler.reserve('beta/shared-model')
  scheduler.recordOutcome(beta, 401)
  beta.release()

  assert.equal(scheduler.resetChannelHealth('alpha'), true)
  assert.equal(scheduler.snapshot().channels.alpha, undefined)
  assert.deepEqual(scheduler.snapshot().channels.beta, { health: 'auth-failed', lastStatusCode: 401, updatedAt: scheduler.snapshot().channels.beta.updatedAt })

  const recovered = scheduler.reserve('alpha/shared-model')
  assert.equal(recovered.candidate.channelId, 'alpha')
  recovered.release()
  assert.equal(scheduler.resetChannelHealth('missing'), false)
})

test('a successful outcome replaces an earlier authentication diagnostic', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const candidate = scheduler.catalog.resolve('alpha/shared-model').candidates[0]
  scheduler.recordOutcome({ candidate }, 403)
  assert.equal(scheduler.snapshot().channels.alpha.lastStatusCode, 403)
  scheduler.recordOutcome({ candidate }, 200)
  assert.deepEqual(scheduler.snapshot().channels.alpha, { health: 'healthy', updatedAt: scheduler.snapshot().channels.alpha.updatedAt })
})

test('opens a transient candidate circuit and permits one half-open recovery trial', () => {
  let clock = 1_000
  const scheduler = createModelScheduler(fixtureConfig(), { now: () => clock })
  for (let index = 0; index < 3; index += 1) {
    const selection = scheduler.reserve('alpha/shared-model')
    scheduler.recordOutcome(selection, { kind: 'transport-failure', transient: true, durationMs: 100 })
    selection.release()
    clock += 1
  }

  assert.equal(scheduler.snapshot().candidates['alpha\0shared-model\0responses'].evidence.circuit, 'open')
  assert.throws(
    () => scheduler.reserve('alpha/shared-model'),
    error => error instanceof GatewayRoutingError && error.code === 'no_eligible_candidates'
  )

  clock += 30_000
  const halfOpen = scheduler.reserve('alpha/shared-model')
  assert.equal(halfOpen.halfOpen, true)
  assert.throws(
    () => scheduler.reserve('alpha/shared-model'),
    error => error instanceof GatewayRoutingError && error.code === 'no_eligible_candidates'
  )
  scheduler.recordOutcome(halfOpen, { kind: 'success', statusCode: 200, durationMs: 80 })
  halfOpen.release()

  const recovered = scheduler.reserve('alpha/shared-model')
  assert.equal(recovered.halfOpen, false)
  recovered.release()
})

test('evidence ordering is used only after priority and minimum samples tie', () => {
  let clock = 1_000
  const config = fixtureConfig()
  config.channels[0].priority = 100
  config.channels[1].priority = 100
  config.channels[0].models[0].priority = 100
  config.channels[1].models[0].priority = 100
  const scheduler = createModelScheduler(config, { now: () => clock })
  for (let index = 0; index < 5; index += 1) {
    for (const [model, durationMs] of [['alpha/shared-model', 500], ['beta/shared-model', 100]]) {
      const selection = scheduler.reserve(model)
      scheduler.recordOutcome(selection, { kind: 'success', statusCode: 200, durationMs })
      selection.release()
      clock += 1
    }
  }
  const selected = scheduler.reserve('shared-model')
  assert.equal(selected.candidate.channelId, 'beta')
  selected.release()
})

test('duplicate terminal observations do not inflate evidence', () => {
  const scheduler = createModelScheduler(fixtureConfig(), { now: () => 1_000 })
  const selection = scheduler.reserve('shared-model')
  assert.equal(scheduler.recordOutcome(selection, { kind: 'success', statusCode: 200, durationMs: 50 }), true)
  assert.equal(scheduler.recordOutcome(selection, { kind: 'success', statusCode: 200, durationMs: 50 }), false)
  selection.release()
  const evidence = scheduler.snapshot().candidates['alpha\0shared-model\0responses'].evidence
  assert.equal(evidence.sampleCount, 1)
  assert.equal(evidence.successCount, 1)
})

test('cancellation releases observation without creating candidate evidence', () => {
  const scheduler = createModelScheduler(fixtureConfig(), { now: () => 1_000 })
  const selection = scheduler.reserve('shared-model')
  assert.equal(scheduler.recordOutcome(selection, { kind: 'cancelled' }), true)
  selection.release()
  assert.equal(scheduler.snapshot().candidates['alpha\0shared-model\0responses'], undefined)
})

test('candidate status exposes only bounded evidence and reason codes', () => {
  let clock = 1_000
  const scheduler = createModelScheduler(fixtureConfig(), { now: () => clock })
  const candidate = scheduler.catalog.resolve('alpha/shared-model').candidates[0]
  const ready = scheduler.candidateStatus(candidate)
  assert.deepEqual(ready, {
    evidence: {
      sampleCount: 0,
      successCount: 0,
      failureCount: 0,
      successRate: null,
      ewmaLatencyMs: null,
      consecutiveTransientFailures: 0,
      circuit: 'closed',
      cooldownUntil: null
    },
    reasonCodes: ['candidate-ready']
  })
  for (let index = 0; index < 3; index += 1) {
    const selection = scheduler.reserve('alpha/shared-model')
    scheduler.recordOutcome(selection, { kind: 'transport-failure', transient: true, durationMs: 50 })
    selection.release()
    clock += 1
  }
  const blocked = scheduler.candidateStatus(candidate)
  assert.equal(blocked.evidence.circuit, 'open')
  assert.deepEqual(blocked.reasonCodes, ['circuit-open'])
  assert.equal(JSON.stringify(blocked).includes('example.test'), false)
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

test('drains a channel without interrupting an existing lease', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const active = scheduler.reserve('shared-model')
  assert.equal(active.candidate.channelId, 'alpha')
  assert.equal(scheduler.drainChannel('alpha'), true)
  assert.deepEqual(scheduler.snapshot().draining, ['alpha'])

  const alternate = scheduler.reserve('shared-model')
  assert.equal(alternate.candidate.channelId, 'beta')
  alternate.release()
  active.release()

  assert.equal(scheduler.resumeChannel('alpha'), true)
  const resumed = scheduler.reserve('shared-model')
  assert.equal(resumed.candidate.channelId, 'alpha')
  resumed.release()
})

test('suppresses a pending model disable while keeping other models on the channel available', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  assert.equal(scheduler.suppressCandidate('alpha', 'shared-model'), true)
  assert.equal(scheduler.isCandidateSuppressed('alpha', 'shared-model'), true)
  const other = scheduler.reserve('alpha/other-model')
  assert.equal(other.candidate.upstreamModel, 'other-model')
  other.release()
  const alternate = scheduler.reserve('shared-model')
  assert.equal(alternate.candidate.channelId, 'beta')
  alternate.release()
  assert.equal(scheduler.resumeCandidate('alpha', 'shared-model'), true)
  assert.equal(scheduler.isCandidateSuppressed('alpha', 'shared-model'), false)
})

test('reloads the catalog only when no request lease is active', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const active = scheduler.reserve('shared-model')
  assert.throws(
    () => scheduler.reload(fixtureConfig()),
    error => error instanceof GatewayRoutingError && error.code === 'runtime_busy'
  )
  active.release()

  const next = fixtureConfig()
  next.channels[0].models[0].upstream = 'new-model'
  next.channels[0].models[0].aliases = ['alpha/new-model']
  next.stableAliases = [{ alias: 'coding-main', channel: 'alpha', model: 'new-model' }]
  scheduler.reload(next)
  const publicIds = scheduler.catalog.listPublicModels().map(item => item.id)
  assert.ok(publicIds.includes('new-model'))
  assert.ok(!publicIds.includes('alpha/shared-model'))
  const selection = scheduler.reserve('new-model')
  assert.equal(selection.candidate.upstreamModel, 'new-model')
  selection.release()
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

test('non-generation models are publicly discoverable by exact id but remain outside generation routing', () => {
  const config = fixtureConfig()
  config.channels[0].models.push({
    upstream: 'text-embedding-3-small',
    kind: 'embedding',
    aliases: ['alpha/text-embedding-3-small']
  })
  config.stableAliases.push({ alias: 'embedding-main', channel: 'alpha', model: 'text-embedding-3-small' })
  const scheduler = createModelScheduler(config)
  const publicModels = scheduler.catalog.listPublicModels({ includeNonGeneration: true })
  const publicIds = publicModels.map(item => item.id)
  assert.ok(!publicIds.includes('text-embedding-3-small'))
  assert.ok(publicIds.includes('alpha/text-embedding-3-small'))
  assert.ok(!publicIds.includes('embedding-main'))
  assert.deepEqual(publicModels.find(item => item.id === 'alpha/text-embedding-3-small'), {
    id: 'alpha/text-embedding-3-small',
    object: 'model',
    created: 0,
    owned_by: 'cpa-channel-gateway',
    kind: 'embedding',
    endpoints: ['/v1/embeddings']
  })
  assert.ok(scheduler.catalog.allModels.get('text-embedding-3-small'))
  const embedding = scheduler.reserve('alpha/text-embedding-3-small', { allowedKinds: ['embedding'] })
  embedding.release()
  assert.throws(() => scheduler.reserve('alpha/text-embedding-3-small', { allowedKinds: ['generation'] }), error => error.code === 'model_endpoint_mismatch')
})

test('client channel groups filter public models and logical candidates', () => {
  const scheduler = createModelScheduler(fixtureConfig())
  const allowed = new Set(['beta'])
  const ids = scheduler.catalog.listPublicModels({ allowedChannels: allowed }).map(item => item.id)
  assert.ok(ids.includes('shared-model'))
  assert.ok(ids.includes('beta/shared-model'))
  assert.ok(!ids.includes('alpha/shared-model'))
  const selection = scheduler.reserve('shared-model', { allowedChannels: allowed })
  assert.equal(selection.candidate.channelId, 'beta')
  selection.release()
  assert.throws(() => scheduler.reserve('alpha/other-model', { allowedChannels: allowed }), error => error.code === 'model_not_found' && error.statusCode === 404)
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
