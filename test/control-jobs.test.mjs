import assert from 'node:assert/strict'
import test from 'node:test'
import { ControlJobError, createControlJobQueue } from '../src/control-jobs.mjs'

test('runs configuration jobs FIFO and exposes only low-sensitivity status', async () => {
  const queue = createControlJobQueue({ idFactory: (() => { let index = 0; return () => `job-${++index}` })() })
  let releaseFirst
  const first = queue.run('model-sync', async () => {
    await new Promise(resolve => { releaseFirst = resolve })
    return 'first-result'
  })
  const second = queue.run('alias-update', async () => 'second-result')
  assert.equal(queue.status().active.type, 'model-sync')
  assert.equal(queue.status().queued, 1)
  assert.equal(queue.status().recent.length, 0)
  releaseFirst()
  assert.equal(await first, 'first-result')
  assert.equal(await second, 'second-result')

  const snapshot = queue.status()
  assert.equal(snapshot.active, null)
  assert.equal(snapshot.queued, 0)
  assert.deepEqual(snapshot.recent.map(job => ({ id: job.id, type: job.type, status: job.status })), [
    { id: 'job-1', type: 'model-sync', status: 'completed' },
    { id: 'job-2', type: 'alias-update', status: 'completed' }
  ])
  assert.doesNotMatch(JSON.stringify(snapshot), /first-result|second-result/)
})

test('records redacted failures and continues with later jobs', async () => {
  const queue = createControlJobQueue({ idFactory: (() => { let index = 0; return () => `job-${++index}` })() })
  const failure = queue.run('channel-update', async () => {
    const error = new Error('secret upstream URL and API key')
    error.code = 'configuration_validation_failed'
    error.statusCode = 400
    throw error
  })
  const success = queue.run('channel-delete', async () => 'ok')
  await assert.rejects(failure, /secret upstream URL/)
  assert.equal(await success, 'ok')
  const snapshot = queue.status()
  assert.deepEqual(snapshot.recent[0].error, { code: 'configuration_validation_failed', statusCode: 400 })
  assert.doesNotMatch(JSON.stringify(snapshot), /secret upstream URL|API key/)
})

test('rejects invalid job types and protects the queue from unbounded backlog', async () => {
  const queue = createControlJobQueue({ maxQueued: 1 })
  assert.throws(() => queue.run('unknown', () => {}), error => error instanceof ControlJobError && error.code === 'invalid_control_job')
  let release
  const active = queue.run('model-sync', () => new Promise(resolve => { release = resolve }))
  const queued = queue.run('alias-update', () => 'queued')
  await assert.rejects(
    queue.run('channel-update', () => 'rejected'),
    error => error instanceof ControlJobError && error.code === 'control_queue_full' && error.statusCode === 429
  )
  release()
  await active
  assert.equal(await queued, 'queued')
})

test('notifies completion with safe job context and ignores audit hook failures', async () => {
  const events = []
  const queue = createControlJobQueue({
    idFactory: () => 'job-1',
    now: (() => {
      let value = Date.parse('2026-08-17T12:00:00.000Z')
      return () => value += 25
    })(),
    onFinished: async event => {
      events.push(event)
      throw new Error('audit sink failure')
    }
  })
  const result = await queue.run('model-sync', context => {
    assert.deepEqual(Object.keys(context).sort(), ['id', 'startedAt', 'submittedAt', 'type'])
    return {
      revision: '20260817T120000025Z-0123456789abcdef-01234567',
      body: 'must not reach hook'
    }
  })
  assert.equal(result.body, 'must not reach hook')
  assert.deepEqual(events[0], {
    id: 'job-1',
    type: 'model-sync',
    status: 'completed',
    submittedAt: '2026-08-17T12:00:00.025Z',
    startedAt: '2026-08-17T12:00:00.050Z',
    finishedAt: '2026-08-17T12:00:00.075Z',
    durationMs: 25,
    revision: '20260817T120000025Z-0123456789abcdef-01234567'
  })
  assert.doesNotMatch(JSON.stringify(events), /must not reach hook|audit sink failure/)
})
