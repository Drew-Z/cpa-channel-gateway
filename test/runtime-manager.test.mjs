import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeApplyError } from '../src/runtime-children.mjs'
import { createRuntimeManager } from '../src/runtime-manager.mjs'

test('commits a changed release only after drain and readiness replacement', async () => {
  const events = []
  const gateway = fixtureGateway(events)
  const manager = createRuntimeManager({
    rootDir: '/gateway',
    initialGenerated: generated('release-a'),
    runtimeChildren: fixtureRuntime(events, async (next, hooks) => {
      events.push(`replace:${next.digest}`)
      await hooks.drain()
      await hooks.waitForIdle()
      await hooks.commit(next)
      await hooks.resume()
      return { changed: true, active: { digest: next.digest }, transitioning: false }
    }),
    getControlGateway: () => gateway,
    generateReleaseImpl: () => { events.push('generate'); return generated('release-b', 7) },
    activateReleaseImpl: (_root, release) => events.push(`activate:${release.digest}`)
  })

  const result = await manager.apply()

  assert.equal(result.changed, true)
  assert.deepEqual(events, [
    'generate',
    'replace:release-b',
    'drain',
    'idle:7000',
    'reload:release-b:false',
    'activate:release-b',
    'mark-applied:release-b',
    'resume'
  ])
})

test('reloads an unchanged generated revision without restarting the runtime', async () => {
  const events = []
  const gateway = fixtureGateway(events)
  const manager = createRuntimeManager({
    rootDir: '/gateway',
    initialGenerated: generated('release-a'),
    runtimeChildren: fixtureRuntime(events, async next => {
      events.push(`replace:${next.digest}`)
      return { changed: false, active: { digest: 'release-a' }, transitioning: false }
    }),
    getControlGateway: () => gateway,
    generateReleaseImpl: () => { events.push('generate'); return generated('release-a') },
    activateReleaseImpl: () => { throw new Error('unchanged releases must not activate') }
  })

  const result = await manager.apply()

  assert.equal(result.changed, false)
  assert.deepEqual(events, [
    'generate',
    'replace:release-a',
    'reload:release-a:false',
    'mark-applied:release-a'
  ])
})

test('restores the prior outer routing config when an unchanged revision cannot be marked applied', async () => {
  const events = []
  const gateway = fixtureGateway(events)
  gateway.markConfigApplied = releaseDigest => {
    events.push(`mark-applied:${releaseDigest}`)
    throw new Error('simulated revision link failure')
  }
  const manager = createRuntimeManager({
    rootDir: '/gateway',
    initialGenerated: generated('release-a', 120, 'previous'),
    runtimeChildren: fixtureRuntime(events, async next => {
      events.push(`replace:${next.digest}`)
      return { changed: false, active: { digest: 'release-a' }, transitioning: false }
    }),
    getControlGateway: () => gateway,
    generateReleaseImpl: () => { events.push('generate'); return generated('release-a', 120, 'next') },
    activateReleaseImpl: () => { throw new Error('unchanged releases must not activate') }
  })

  await assert.rejects(manager.apply(), /simulated revision link failure/)
  assert.deepEqual(events, [
    'generate',
    'replace:release-a',
    'reload:release-a:false:next',
    'mark-applied:release-a',
    'reload:release-a:false:previous'
  ])
})

test('restores the previous config and active release when commit fails', async () => {
  const events = []
  const gateway = fixtureGateway(events)
  const manager = createRuntimeManager({
    rootDir: '/gateway',
    initialGenerated: generated('release-a'),
    runtimeChildren: fixtureRuntime(events, async (next, hooks) => {
      events.push(`replace:${next.digest}`)
      await hooks.drain()
      await hooks.waitForIdle()
      try {
        await hooks.commit(next)
      } catch (error) {
        await hooks.rollback(error)
        throw new RuntimeApplyError('runtime_apply_failed', 503, 'The new release was rolled back', error)
      } finally {
        await hooks.resume()
      }
    }),
    getControlGateway: () => gateway,
    generateReleaseImpl: () => { events.push('generate'); return generated('release-b') },
    activateReleaseImpl: (_root, release) => {
      events.push(`activate:${release.digest}`)
      if (release.digest === 'release-b') throw new Error('simulated active pointer failure')
    }
  })

  await assert.rejects(manager.apply(), error => error.code === 'runtime_apply_failed')
  assert.deepEqual(events, [
    'generate',
    'replace:release-b',
    'drain',
    'idle:120000',
    'reload:release-b:false',
    'activate:release-b',
    'reload:release-a:false',
    'activate:release-a',
    'resume'
  ])
})

test('does not reload or activate when draining times out', async () => {
  const events = []
  const gateway = fixtureGateway(events, { waitError: new Error('drain timeout') })
  const manager = createRuntimeManager({
    rootDir: '/gateway',
    initialGenerated: generated('release-a'),
    runtimeChildren: fixtureRuntime(events, async (next, hooks) => {
      events.push(`replace:${next.digest}`)
      try {
        await hooks.drain()
        await hooks.waitForIdle()
      } finally {
        await hooks.resume()
      }
    }),
    getControlGateway: () => gateway,
    generateReleaseImpl: () => { events.push('generate'); return generated('release-b') },
    activateReleaseImpl: (_root, release) => events.push(`activate:${release.digest}`)
  })

  await assert.rejects(manager.apply(), /drain timeout/)
  assert.deepEqual(events, ['generate', 'replace:release-b', 'drain', 'idle:120000', 'resume'])
})

function generated(digest, timeoutSeconds = 120, marker = null) {
  return { digest, marker, gateway: { queue: { timeoutSeconds } } }
}

function fixtureRuntime(events, replace) {
  return {
    status: () => ({ active: { digest: 'release-a', childCount: 2 }, transitioning: false }),
    replace
  }
}

function fixtureGateway(events, { waitError = null } = {}) {
  return {
    scheduler: {
      drainAll: () => events.push('drain'),
      waitForIdle: ({ timeoutMs }) => {
        events.push(`idle:${timeoutMs}`)
        if (waitError) throw waitError
      },
      resumeAll: () => events.push('resume')
    },
    reloadConfig: (release, options) => events.push(`reload:${release.digest}:${options.markApplied}${release.marker ? `:${release.marker}` : ''}`),
    markConfigApplied: releaseDigest => events.push(`mark-applied:${releaseDigest}`)
  }
}
