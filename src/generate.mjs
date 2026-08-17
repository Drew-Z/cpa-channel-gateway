import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { buildCpaConfig } from './cpa.mjs'
import { loadConfig } from './config.mjs'
import { assignListeners, buildHaproxyConfig } from './haproxy.mjs'

const DEFAULT_EXTRA_RELEASES = 3
const RELEASE_ID = /^[a-f0-9]{16}$/

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
    channels: channels.map(channel => ({ id: channel.id, enabled: channel.enabled, staged: channel.staged, runtimeEnabled: channel.runtimeEnabled, listener: channel.listener, modelCount: channel.models.length })),
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
  if (previous?.active === generated.digest) {
    pruneReleases(root)
    return previous
  }
  const payload = { version: 1, active: generated.digest, releaseDir: generated.releaseDir, previous: previous?.active ?? null, activatedAt: new Date().toISOString() }
  const temporaryPath = path.join(path.dirname(activePath), `${path.basename(activePath)}.tmp`)
  fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporaryPath, activePath)
  pruneReleases(root)
  return payload
}

export function pruneReleases(root, { keepExtra = DEFAULT_EXTRA_RELEASES } = {}) {
  const extraLimit = Number.isSafeInteger(keepExtra) && keepExtra >= 0 ? keepExtra : DEFAULT_EXTRA_RELEASES
  const releaseRoot = path.resolve(root, 'runtime', 'releases')
  if (!fs.existsSync(releaseRoot)) return { removed: [], retained: [] }
  const protectedIds = new Set()
  const activePath = path.resolve(root, 'runtime', 'active.json')
  if (fs.existsSync(activePath)) {
    try {
      const active = JSON.parse(fs.readFileSync(activePath, 'utf8'))
      if (RELEASE_ID.test(String(active?.active ?? ''))) protectedIds.add(active.active)
      if (RELEASE_ID.test(String(active?.previous ?? ''))) protectedIds.add(active.previous)
    } catch {}
  }
  const releases = fs.readdirSync(releaseRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && RELEASE_ID.test(entry.name))
    .map(entry => {
      const directory = path.resolve(releaseRoot, entry.name)
      const manifestPath = path.join(directory, 'manifest.json')
      let timestamp = fs.statSync(directory).mtimeMs
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const generatedAt = Date.parse(manifest.generatedAt)
        if (Number.isFinite(generatedAt)) timestamp = generatedAt
      } catch {}
      return { id: entry.name, directory, timestamp }
    })
    .sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id))
  const extraIds = new Set(releases.filter(item => !protectedIds.has(item.id)).slice(0, extraLimit).map(item => item.id))
  const retained = releases.filter(item => protectedIds.has(item.id) || extraIds.has(item.id)).map(item => item.id)
  const removed = []
  for (const release of releases) {
    if (protectedIds.has(release.id) || extraIds.has(release.id)) continue
    if (path.dirname(release.directory) !== releaseRoot) continue
    fs.rmSync(release.directory, { recursive: true })
    removed.push(release.id)
  }
  return { removed, retained }
}

export function rollbackRelease(root) {
  const activePath = path.join(root, 'runtime', 'active.json')
  if (!fs.existsSync(activePath)) throw new Error('No active release to roll back')
  const active = JSON.parse(fs.readFileSync(activePath, 'utf8'))
  if (!active.previous) throw new Error('No previous release recorded')
  const releaseDir = path.join(root, 'runtime', 'releases', active.previous)
  if (!fs.existsSync(releaseDir)) throw new Error(`Previous release missing: ${active.previous}`)
  const payload = { ...active, active: active.previous, releaseDir, previous: null, rolledBackAt: new Date().toISOString() }
  const temporaryPath = path.join(path.dirname(activePath), `${path.basename(activePath)}.tmp`)
  fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temporaryPath, activePath)
  return payload
}
