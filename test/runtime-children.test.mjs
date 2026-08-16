import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { RuntimeApplyError, createRuntimeChildren } from '../src/runtime-children.mjs'

test('starts HAProxy before CPA and stops both children cleanly', async () => {
  const events = []
  const children = []
  const runtime = createRuntimeChildren(fixtureOptions({ events, children }))
  await runtime.start(generated('release-a'))
  assert.deepEqual(events.slice(0, 4), ['check:HAProxy configuration', 'check:CPA binary', 'spawn:haproxy', 'ready:19001'])
  assert.equal(runtime.status().active.digest, 'release-a')
  await runtime.stop()
  assert.deepEqual(children.map(child => child.killed), [true, true])
})

test('drains, replaces, commits and resumes in order', async () => {
  const events = []
  const runtime = createRuntimeChildren(fixtureOptions({ events, readyPort: 19001 }))
  await runtime.start(generated('release-a'))
  events.length = 0
  const result = await runtime.replace(generated('release-b'), {
    drain: async () => events.push('drain'),
    waitForIdle: async () => events.push('idle'),
    commit: async () => events.push('commit'),
    resume: async () => events.push('resume')
  })
  assert.equal(result.changed, true)
  assert.equal(runtime.status().active.digest, 'release-b')
  assert.deepEqual(events, [
    'drain',
    'idle',
    'check:HAProxy configuration',
    'check:CPA binary',
    'spawn:haproxy',
    'ready:19001',
    'spawn:cpa',
    'ready:24675',
    'commit',
    'resume'
  ])
})

test('restores the previous release when the new child fails readiness', async () => {
  const events = []
  let startCount = 0
  const runtime = createRuntimeChildren(fixtureOptions({
    events,
    waitForPortImpl: async (_host, port) => {
      if (port === 19001 && ++startCount === 2) throw new Error('new HAProxy failed')
      events.push(`ready:${port}`)
    }
  }))
  await runtime.start(generated('release-a'))
  let rollbackCause
  await assert.rejects(
    runtime.replace(generated('release-b'), {
      rollback: async error => { rollbackCause = error }
    }),
    error => error instanceof RuntimeApplyError && error.code === 'runtime_apply_failed'
  )
  assert.equal(runtime.status().active.digest, 'release-a')
  assert.ok(rollbackCause)
})

test('reports unexpected child exit without exposing process details', async () => {
  let failure
  const children = []
  const runtime = createRuntimeChildren(fixtureOptions({ children, onFailure: error => { failure = error } }))
  await runtime.start(generated('release-a'))
  children[0].exit(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failure.code, 'runtime_child_exited')
  assert.equal(failure.statusCode, 503)
})

function generated(digest) {
  return {
    digest,
    releaseDir: `/runtime/releases/${digest}`,
    gateway: { internal: { host: '127.0.0.1', cpaPort: 24675 }, cpa: { localModelCatalog: true } },
    channels: [{ runtimeEnabled: true, enabled: true, listener: 19001 }]
  }
}

function fixtureOptions({ events = [], children = [], waitForPortImpl, onFailure } = {}) {
  return {
    cpaPath: 'cpa',
    haproxyPath: 'haproxy',
    onFailure,
    spawnImpl: (command, args) => {
      const child = new FakeChild(command)
      children.push(child)
      events.push(`spawn:${command}`)
      return child
    },
    runCheck: (_command, _args, label) => events.push(`check:${label}`),
    waitForPortImpl: waitForPortImpl ?? (async (_host, port) => events.push(`ready:${port}`)),
    terminateChildrenImpl: async items => items.forEach(item => item.kill())
  }
}

class FakeChild extends EventEmitter {
  constructor(command) {
    super()
    this.command = command
    this.killed = false
    this.exitCode = null
    this.signalCode = null
  }

  kill() {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0, null)
  }

  exit(code) {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}
