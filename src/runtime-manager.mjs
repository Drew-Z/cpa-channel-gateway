import { activateRelease, generateRelease } from './generate.mjs'

export function createRuntimeManager({
  rootDir,
  initialGenerated,
  runtimeChildren,
  getControlGateway,
  generateReleaseImpl = generateRelease,
  activateReleaseImpl = activateRelease
} = {}) {
  if (!rootDir) throw new TypeError('A gateway root directory is required')
  if (!initialGenerated?.digest) throw new TypeError('An initial generated release is required')
  if (!runtimeChildren?.status || !runtimeChildren?.replace) throw new TypeError('A runtime child supervisor is required')
  if (typeof getControlGateway !== 'function') throw new TypeError('A control gateway accessor is required')

  let appliedGenerated = initialGenerated

  return {
    status() {
      return { ...runtimeChildren.status(), available: true }
    },
    async apply() {
      const controlGateway = getControlGateway()
      if (!controlGateway) throw runtimeError('runtime_gateway_unavailable', 503, 'The control gateway is not ready')
      const next = generateReleaseImpl(rootDir)
      const previous = appliedGenerated
      const result = await runtimeChildren.replace(next, {
        drain: async () => { controlGateway.scheduler.drainAll() },
        waitForIdle: () => controlGateway.scheduler.waitForIdle({ timeoutMs: next.gateway.queue.timeoutSeconds * 1000 }),
        resume: async () => { controlGateway.scheduler.resumeAll() },
        commit: async release => {
          controlGateway.reloadConfig(release, { markApplied: false })
          activateReleaseImpl(rootDir, release)
          controlGateway.markConfigApplied(release.digest)
          appliedGenerated = release
        },
        rollback: async () => {
          controlGateway.reloadConfig(previous, { markApplied: false })
          activateReleaseImpl(rootDir, previous)
          appliedGenerated = previous
        }
      })
      if (!result.changed) controlGateway.markConfigApplied(next.digest)
      return result
    }
  }
}

function runtimeError(code, statusCode, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}
