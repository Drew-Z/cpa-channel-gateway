import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { childOutcome, terminateChildren, waitForPort } from './supervisor.mjs'

export class RuntimeApplyError extends Error {
  constructor(code, statusCode, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'RuntimeApplyError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function createRuntimeChildren({
  cpaPath,
  haproxyPath,
  spawnImpl = spawn,
  runCheck = defaultRunCheck,
  waitForPortImpl = waitForPort,
  terminateChildrenImpl = terminateChildren,
  readyTimeoutMs = 15_000,
  monotonicNow = () => Date.now(),
  onFailure = () => {}
} = {}) {
  if (!cpaPath || !haproxyPath) throw new TypeError('CPA and HAProxy paths are required')
  let active = null
  let transitioning = false
  const metrics = {
    applyCount: 0,
    successCount: 0,
    failureCount: 0,
    lastResult: null,
    lastDurationMs: null,
    lastDrainWaitMs: null,
    lastErrorCode: null,
    unexpectedExitCount: 0
  }

  async function start(generated, { signal } = {}) {
    if (active) throw new RuntimeApplyError('runtime_already_started', 409, 'The internal runtime is already started')
    const release = await spawnRelease(generated, signal)
    active = release
    monitorRelease(release)
    return publicStatus()
  }

  async function replace(generated, {
    drain = async () => {},
    waitForIdle = async () => {},
    resume = async () => {},
    commit = async () => {},
    rollback = async () => {}
  } = {}) {
    if (transitioning) throw new RuntimeApplyError('runtime_apply_in_progress', 409, 'A runtime apply is already in progress')
    if (!active) throw new RuntimeApplyError('runtime_not_started', 503, 'The internal runtime is not started')
    metrics.applyCount += 1
    const startedAt = monotonicNow()
    if (active.generated.digest === generated.digest) {
      metrics.successCount += 1
      metrics.lastResult = 'unchanged'
      metrics.lastDurationMs = elapsed(startedAt)
      metrics.lastDrainWaitMs = 0
      metrics.lastErrorCode = null
      return { changed: false, ...publicStatus() }
    }

    transitioning = true
    const previous = active
    let next = null
    try {
      const drainStartedAt = monotonicNow()
      try {
        await drain()
        await waitForIdle()
      } finally {
        metrics.lastDrainWaitMs = elapsed(drainStartedAt)
      }
      await stopRelease(previous)
      active = null
      try {
        next = await spawnRelease(generated)
        active = next
        monitorRelease(next)
        await commit(generated)
      } catch (error) {
        if (next) await stopRelease(next)
        active = null
        try {
          const restored = await spawnRelease(previous.generated)
          active = restored
          monitorRelease(restored)
          await rollback(error)
        } catch (rollbackError) {
          active = null
          throw new RuntimeApplyError('runtime_rollback_failed', 503, 'The previous internal runtime could not be restored', rollbackError)
        }
        throw new RuntimeApplyError('runtime_apply_failed', 503, 'The new internal runtime failed readiness and was rolled back', error)
      }
      metrics.successCount += 1
      metrics.lastResult = 'success'
      metrics.lastDurationMs = elapsed(startedAt)
      metrics.lastErrorCode = null
      return { changed: true, ...publicStatus() }
    } catch (error) {
      metrics.failureCount += 1
      metrics.lastResult = 'failure'
      metrics.lastDurationMs = elapsed(startedAt)
      metrics.lastErrorCode = publicErrorCode(error)
      throw error
    } finally {
      transitioning = false
      await resume()
    }
  }

  async function stop() {
    if (!active) return false
    const current = active
    active = null
    await stopRelease(current)
    return true
  }

  function publicStatus() {
    return {
      active: active
        ? { digest: active.generated.digest, childCount: active.children.length }
        : null,
      transitioning,
      metrics: { ...metrics }
    }
  }

  function elapsed(startedAt) {
    const duration = monotonicNow() - startedAt
    return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0
  }

  async function spawnRelease(generated, signal) {
    const children = []
    const release = { generated, children, stopping: false }
    try {
      const haproxyConfig = path.join(generated.releaseDir, 'haproxy', 'haproxy.cfg')
      runCheck(haproxyPath, ['-c', '-f', haproxyConfig], 'HAProxy configuration')
      runCheck(cpaPath, ['-help'], 'CPA binary', new Set([0, 2]))
      const haproxy = spawnImpl(haproxyPath, ['-f', haproxyConfig, '-db'], {
        stdio: 'inherit',
        env: process.env
      })
      children.push(haproxy)
      await waitForReleaseReady(release, generated.channels
        .filter(item => item.runtimeEnabled ?? item.enabled)
        .map(item => waitForPortImpl(generated.gateway.internal.host, item.listener, readyTimeoutMs, { signal })))
      assertChildRunning(haproxy, 'HAProxy')

      const cpaArgs = ['-config', path.join(generated.releaseDir, 'cpa', 'config.yaml')]
      if (generated.gateway.cpa.localModelCatalog) cpaArgs.push('-local-model')
      const cpa = spawnImpl(cpaPath, cpaArgs, {
        stdio: 'inherit',
        env: { ...process.env, SERVER_PORT: String(generated.gateway.internal.cpaPort) }
      })
      children.push(cpa)
      await waitForReleaseReady(release, [waitForPortImpl(
        generated.gateway.internal.host,
        generated.gateway.internal.cpaPort,
        readyTimeoutMs,
        { signal }
      )])
      assertChildRunning(haproxy, 'HAProxy')
      assertChildRunning(cpa, 'CPA')
      return release
    } catch (error) {
      release.stopping = true
      await terminateChildrenImpl(children)
      throw new RuntimeApplyError('runtime_child_failed', 503, 'Internal runtime readiness failed', error)
    }
  }

  async function waitForReleaseReady(release, readiness) {
    const outcomes = release.children.map((child, index) => childOutcome(child, index === 0 ? 'HAProxy' : 'CPA'))
    const failed = Promise.race(outcomes).then(outcome => {
      throw new RuntimeApplyError('runtime_child_failed', 503, `${outcome.label} exited before readiness`)
    })
    await Promise.race([Promise.all(readiness), failed])
  }

  async function stopRelease(release) {
    release.stopping = true
    await terminateChildrenImpl(release.children)
  }

  function monitorRelease(release) {
    release.children.forEach((child, index) => {
      const outcome = childOutcome(child, index === 0 ? 'HAProxy' : 'CPA')
      outcome.then(result => {
        if (release.stopping) return
        metrics.unexpectedExitCount += 1
        metrics.lastErrorCode = 'runtime_child_exited'
        try {
          onFailure(new RuntimeApplyError('runtime_child_exited', 503, `${result.label} exited unexpectedly`))
        } catch {}
      }).catch(() => {})
    })
  }

  function assertChildRunning(child, label) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new RuntimeApplyError('runtime_child_failed', 503, `${label} exited before readiness`)
    }
  }

  return { start, replace, stop, status: publicStatus }
}

function publicErrorCode(error) {
  const code = String(error?.code ?? '')
  return /^[a-z][a-z0-9_-]{0,63}$/.test(code) ? code : 'runtime_apply_failed'
}

function defaultRunCheck(command, args, label, accepted = new Set([0])) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (!accepted.has(result.status)) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 1_000)
    throw new Error(`${label} check failed${detail ? `: ${detail}` : ''}`)
  }
}
