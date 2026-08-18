#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generateRelease, activateRelease, rollbackRelease } from '../src/generate.mjs'
import { loadConfig } from '../src/config.mjs'
import { createControlGateway } from '../src/control-gateway.mjs'
import { createRuntimeChildren } from '../src/runtime-children.mjs'
import { createRuntimeManager } from '../src/runtime-manager.mjs'
import { PTERODACTYL_STARTUP_MARKER } from '../src/startup-preparation.mjs'
import { childOutcome, terminateChildren, waitForHttpOk } from '../src/supervisor.mjs'

const root = path.resolve(process.env.GATEWAY_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const command = process.argv[2] || 'status'

try {
  if (command === 'validate') {
    const config = loadConfig(root)
    console.log(JSON.stringify(publicSummary(config), null, 2))
  } else if (command === 'generate') {
    const generated = generateRelease(root)
    console.log(JSON.stringify({ digest: generated.digest, channels: generated.channels.map(item => ({ id: item.id, enabled: item.enabled, staged: item.staged, runtimeEnabled: item.runtimeEnabled, listener: item.listener })) }, null, 2))
  } else if (command === 'activate') {
    const generated = generateRelease(root)
    console.log(JSON.stringify(activateRelease(root, generated), null, 2))
  } else if (command === 'rollback') {
    console.log(JSON.stringify(rollbackRelease(root), null, 2))
  } else if (command === 'status') {
    const config = loadConfig(root)
    const activePath = path.join(root, 'runtime', 'active.json')
    console.log(JSON.stringify({ config: publicSummary(config), active: fs.existsSync(activePath) ? JSON.parse(fs.readFileSync(activePath, 'utf8')) : null, serverPort: Number(process.env.SERVER_PORT || config.gateway.public.defaultPort) }, null, 2))
  } else if (command === 'start') {
    await start(root)
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

function publicSummary(config) {
  return {
    channels: config.channels.map(item => ({ id: item.id, name: item.name, enabled: item.enabled, staged: item.staged, runtimeEnabled: item.runtimeEnabled, modelCount: item.models.length, protocol: item.protocol })),
    stableAliases: config.stableAliases.map(item => ({ alias: item.alias, channel: item.channel, model: item.model })),
    pinnedAliases: config.pinnedAliases.map(item => ({ alias: item.alias, channel: item.channel, model: item.model, approvalRef: item.approvalRef })),
    cloudflareTunnel: { enabled: config.cloudflareTunnel.enabled },
    queue: config.gateway.queue
  }
}

async function start(rootDir) {
  const generated = generateRelease(rootDir)
  activateRelease(rootDir, generated)
  const binDir = path.join(rootDir, 'bin')
  const cpaPath = path.join(binDir, process.platform === 'win32' ? 'CLIProxyAPI.exe' : 'CLIProxyAPI')
  const haproxyPath = path.join(binDir, process.platform === 'win32' ? 'haproxy.exe' : 'haproxy')
  const cloudflaredPath = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  if (!fs.existsSync(cpaPath) || !fs.existsSync(haproxyPath)) throw new Error('Missing runtime binaries. Run the documented install step before start.')
  if (generated.cloudflareTunnel.enabled && !fs.existsSync(cloudflaredPath)) throw new Error('Cloudflare Tunnel is enabled but bin/cloudflared is missing. Run the documented install step before start.')
  runCheck(haproxyPath, ['-c', '-f', path.join(generated.releaseDir, 'haproxy', 'haproxy.cfg')], 'HAProxy configuration')
  runCheck(cpaPath, ['-help'], 'CPA binary', new Set([0, 2]))
  fs.mkdirSync(path.join(rootDir, 'runtime', 'auth'), { recursive: true })
  fs.mkdirSync(path.join(rootDir, 'logs'), { recursive: true })
  const children = []
  const outcomes = []
  let controlGateway = null
  let resolveRuntimeFailure
  const runtimeFailure = new Promise(resolve => { resolveRuntimeFailure = resolve })
  const abortController = new AbortController()
  let resolveSignal
  const signalOutcome = new Promise(resolve => { resolveSignal = resolve })
  const onSigint = () => { abortController.abort(); resolveSignal({ type: 'signal', signal: 'SIGINT' }) }
  const onSigterm = () => { abortController.abort(); resolveSignal({ type: 'signal', signal: 'SIGTERM' }) }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  const runtimeChildren = createRuntimeChildren({
    cpaPath,
    haproxyPath,
    readyTimeoutMs: 15_000,
    onFailure: error => resolveRuntimeFailure({ type: 'error', label: 'Internal runtime', error })
  })
  const runtimeManager = createRuntimeManager({
    rootDir,
    initialGenerated: generated,
    runtimeChildren,
    getControlGateway: () => controlGateway
  })

  try {
    const publicPort = Number(process.env[generated.gateway.public.portEnv] || process.env.SERVER_PORT || process.env.PORT || generated.gateway.public.defaultPort)
    try {
      await runtimeChildren.start(generated, { signal: abortController.signal })
    } catch (error) {
      if (abortController.signal.aborted) return
      throw error
    }

    controlGateway = createControlGateway(generated, { runtimeManager })
    await controlGateway.listen({ host: generated.gateway.public.host, port: publicPort })

    if (generated.cloudflareTunnel.enabled) {
      const tunnel = generated.cloudflareTunnel
      runCheck(cloudflaredPath, ['version'], 'cloudflared binary')
      const tunnelEnv = { ...process.env, NO_AUTOUPDATE: 'true' }
      tunnelEnv['TUNNEL_TOKEN'] = tunnel.credential
      const cloudflared = spawn(cloudflaredPath, [
        'tunnel',
        '--no-autoupdate',
        '--metrics', `${tunnel.metricsHost}:${tunnel.metricsPort}`,
        'run'
      ], {
        stdio: 'inherit',
        windowsHide: true,
        env: tunnelEnv
      })
      children.push(cloudflared)
      outcomes.push(childOutcome(cloudflared, 'cloudflared'))
      const tunnelReady = waitForHttpOk(
        `http://${tunnel.metricsHost}:${tunnel.metricsPort}/ready`,
        tunnel.readyTimeoutMs,
        { signal: abortController.signal }
      ).then(() => null)
      const tunnelStartup = await Promise.race([tunnelReady, ...outcomes, runtimeFailure, signalOutcome])
      if (tunnelStartup?.type === 'signal') return
      if (tunnelStartup) throw childFailure(tunnelStartup)
    }

    console.log(JSON.stringify({ ready: true, port: publicPort, release: generated.digest, cloudflareTunnel: generated.cloudflareTunnel.enabled }))
    console.log(PTERODACTYL_STARTUP_MARKER)

    const outcome = await Promise.race([...outcomes, runtimeFailure, signalOutcome])
    if (outcome.type !== 'signal') throw childFailure(outcome)
  } finally {
    abortController.abort()
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    await controlGateway?.close().catch(() => {})
    await runtimeChildren.stop().catch(() => {})
    await terminateChildren(children)
  }
}

function childFailure(outcome) {
  if (outcome.type === 'error') return new Error(`${outcome.label} failed to start: ${outcome.error.message}`, { cause: outcome.error })
  return new Error(`${outcome.label} exited unexpectedly code=${outcome.code} signal=${outcome.signal}`)
}

function runCheck(command, args, label, accepted = new Set([0])) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (!accepted.has(result.status)) throw new Error(`${label} check failed: ${(result.stderr || result.stdout || '').trim().slice(0, 1000)}`)
}
