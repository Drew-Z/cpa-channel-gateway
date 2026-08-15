import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildCpaConfig } from './cpa.mjs'
import { loadConfig } from './config.mjs'
import { assignListeners, buildHaproxyConfig } from './haproxy.mjs'

export function generateRelease(root) {
  const loaded = loadConfig(root)
  const channels = assignListeners(loaded.channels, loaded.gateway.internal.firstChannelPort)
  const runtimePaths = {
    authDir: path.join(root, 'runtime', 'auth').replaceAll('\\', '/'),
    cpaPort: loaded.gateway.internal.cpaPort
  }
  const cpa = buildCpaConfig(loaded, channels, { stableAliases: loaded.stableAliases, pinnedAliases: loaded.pinnedAliases }, runtimePaths)
  const haproxy = buildHaproxyConfig(loaded.gateway, channels)
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    channels: channels.map(channel => ({ id: channel.id, enabled: channel.enabled, listener: channel.listener, modelCount: channel.models.length })),
    files: ['cpa/config.yaml', 'haproxy/haproxy.cfg']
  }
  const digest = crypto.createHash('sha256').update(cpa).update('\0').update(haproxy).digest('hex').slice(0, 16)
  const releaseDir = path.join(root, 'runtime', 'releases', digest)
  fs.mkdirSync(path.join(releaseDir, 'cpa'), { recursive: true })
  fs.mkdirSync(path.join(releaseDir, 'haproxy'), { recursive: true })
  fs.writeFileSync(path.join(releaseDir, 'cpa', 'config.yaml'), cpa, { mode: 0o600 })
  fs.writeFileSync(path.join(releaseDir, 'haproxy', 'haproxy.cfg'), haproxy, { mode: 0o600 })
  fs.writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  fs.mkdirSync(path.join(root, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(root, 'runtime', 'generated.json'), JSON.stringify({ digest, releaseDir, generatedAt: manifest.generatedAt }, null, 2) + '\n', { mode: 0o600 })
  return { ...loaded, channels, digest, releaseDir, cpa, haproxy }
}

export function activateRelease(root, generated) {
  const activePath = path.join(root, 'runtime', 'active.json')
  const previous = fs.existsSync(activePath) ? JSON.parse(fs.readFileSync(activePath, 'utf8')) : null
  if (previous?.active === generated.digest) return previous
  const payload = { version: 1, active: generated.digest, releaseDir: generated.releaseDir, previous: previous?.active ?? null, activatedAt: new Date().toISOString() }
  fs.writeFileSync(`${activePath}.tmp`, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(`${activePath}.tmp`, activePath)
  return payload
}

export function rollbackRelease(root) {
  const activePath = path.join(root, 'runtime', 'active.json')
  if (!fs.existsSync(activePath)) throw new Error('No active release to roll back')
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'))
  if (!active.previous) throw new Error('No previous release recorded')
  const releaseDir = path.join(root, 'runtime', 'releases', active.previous)
  if (!fs.existsSync(releaseDir)) throw new Error(`Previous release missing: ${active.previous}`)
  const payload = { ...active, active: active.previous, releaseDir, previous: null, rolledBackAt: new Date().toISOString() }
  fs.writeFileSync(`${activePath}.tmp`, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(`${activePath}.tmp`, activePath)
  return payload
}
