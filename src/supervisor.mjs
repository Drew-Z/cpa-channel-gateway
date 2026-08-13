import net from 'node:net'

export function waitForPort(host, port, timeoutMs, { signal, retryIntervalMs = 100, connectTimeoutMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    let currentSocket = null
    let retryTimer = null
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      if (retryTimer) clearTimeout(retryTimer)
      if (currentSocket) currentSocket.destroy()
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }

    const onAbort = () => {
      const error = new Error(`Port wait aborted for ${host}:${port}`)
      error.name = 'AbortError'
      finish(error)
    }

    const scheduleRetry = () => {
      if (settled) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        finish(new Error(`Listener ${host}:${port} did not become ready within ${timeoutMs}ms`))
        return
      }
      retryTimer = setTimeout(attempt, Math.min(retryIntervalMs, remaining))
    }

    const attempt = () => {
      if (settled) return
      let handled = false
      const socket = net.createConnection({ host, port })
      currentSocket = socket
      const retryOnce = () => {
        if (handled || settled) return
        handled = true
        socket.destroy()
        scheduleRetry()
      }
      socket.setTimeout(Math.min(connectTimeoutMs, Math.max(1, deadline - Date.now())))
      socket.once('connect', () => {
        if (handled || settled) return
        handled = true
        socket.destroy()
        finish()
      })
      socket.once('error', retryOnce)
      socket.once('timeout', retryOnce)
    }

    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    attempt()
  })
}

export function childOutcome(child, label) {
  return new Promise(resolve => {
    let settled = false
    const finish = outcome => {
      if (settled) return
      settled = true
      resolve({ label, ...outcome })
    }
    child.once('error', error => finish({ type: 'error', error }))
    child.once('exit', (code, signal) => finish({ type: 'exit', code, signal }))
  })
}

export async function terminateChildren(children, graceMs = 5000) {
  const running = () => children.filter(child => child.exitCode === null && child.signalCode === null)
  for (const child of running()) child.kill('SIGTERM')
  if (running().length) {
    await Promise.race([
      Promise.all(running().map(waitForExit)),
      new Promise(resolve => setTimeout(resolve, graceMs))
    ])
  }
  for (const child of running()) child.kill('SIGKILL')
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
}
