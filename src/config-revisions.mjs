import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from './env.mjs'

const VERSION = 1
const REVISION_ID = /^\d{8}T\d{9}Z-[a-f0-9]{16}-[a-f0-9]{8}$/
const OPERATION = /^[a-z][a-z0-9-]{0,63}$/
const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/

export class ConfigRevisionError extends Error {
  constructor(code, statusCode, message) {
    super(message)
    this.name = 'ConfigRevisionError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function createConfigRevisionStore({
  root,
  now = () => Date.now(),
  idFactory = () => crypto.randomUUID()
} = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('root is required')
  const revisionRoot = path.resolve(root, 'runtime', 'config-revisions')

  return {
    snapshotCurrent() {
      return readCurrentSnapshot(root)
    },
    create({ parentRevision = null, operation, affected = {}, snapshot, validation = { ok: true } } = {}) {
      const normalizedSnapshot = normalizeSnapshot(snapshot)
      const contentDigest = digestSnapshot(normalizedSnapshot)
      const createdAt = new Date(now()).toISOString()
      const revision = `${compactTimestamp(createdAt)}-${contentDigest.slice(0, 16)}-${nonce(idFactory())}`
      const manifest = normalizeManifest({
        schemaVersion: VERSION,
        revision,
        parentRevision,
        createdAt,
        operation,
        affected,
        contentDigest,
        validation,
        files: { providers: normalizedSnapshot.providersText !== null }
      })
      if (manifest.parentRevision) readRevision(revisionRoot, manifest.parentRevision)
      const finalDir = revisionPath(revisionRoot, revision)
      const temporaryDir = path.join(revisionRoot, `.tmp-${process.pid}-${crypto.randomUUID()}`)
      if (fs.existsSync(finalDir)) throw new ConfigRevisionError('revision_exists', 409, 'Configuration revision already exists')
      try {
        fs.mkdirSync(temporaryDir, { recursive: true, mode: 0o700 })
        writeSnapshot(temporaryDir, normalizedSnapshot)
        fs.writeFileSync(path.join(temporaryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
        fs.mkdirSync(revisionRoot, { recursive: true, mode: 0o700 })
        fs.renameSync(temporaryDir, finalDir)
      } catch (error) {
        removeTemporaryDirectory(revisionRoot, temporaryDir)
        if (error instanceof ConfigRevisionError) throw error
        throw new ConfigRevisionError('revision_write_failed', 500, 'Configuration revision could not be written')
      }
      return structuredClone(manifest)
    },
    read(revision) {
      return readRevision(revisionRoot, revision)
    },
    findByDigest(contentDigest) {
      const digest = String(contentDigest ?? '')
      if (!/^[a-f0-9]{64}$/.test(digest)) return null
      const match = validManifests(revisionRoot)
        .filter(manifest => manifest.contentDigest === digest)
        .sort(compareManifests)[0]
      return match ? publicManifest(match) : null
    },
    latest() {
      const manifest = validManifests(revisionRoot).sort(compareManifests)[0]
      return manifest ? publicManifest(manifest) : null
    },
    list({ limit = 50 } = {}) {
      const boundedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50
      if (!fs.existsSync(revisionRoot)) return []
      const revisions = []
      for (const entry of fs.readdirSync(revisionRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !REVISION_ID.test(entry.name)) continue
        try {
          revisions.push(publicManifest(readRevision(revisionRoot, entry.name).manifest))
        } catch {
          revisions.push({ revision: entry.name, valid: false, errorCode: 'revision_invalid' })
        }
      }
      return revisions
        .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || right.revision.localeCompare(left.revision))
        .slice(0, boundedLimit)
    },
    root: revisionRoot
  }
}

function validManifests(revisionRoot) {
  if (!fs.existsSync(revisionRoot)) return []
  const manifests = []
  for (const entry of fs.readdirSync(revisionRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !REVISION_ID.test(entry.name)) continue
    try { manifests.push(readRevision(revisionRoot, entry.name).manifest) } catch {}
  }
  return manifests
}

function compareManifests(left, right) {
  return right.createdAt.localeCompare(left.createdAt) || right.revision.localeCompare(left.revision)
}

export function readCurrentSnapshot(root) {
  const configDir = path.join(root, 'config')
  const envPath = path.join(configDir, 'channels.local.env')
  const routesPath = path.join(configDir, 'routes.local.json')
  const providersPath = path.join(configDir, 'providers.local.json')
  if (!fs.existsSync(envPath) || !fs.existsSync(routesPath)) {
    throw new ConfigRevisionError('private_config_missing', 400, 'Private configuration is incomplete')
  }
  return normalizeSnapshot({
    envText: fs.readFileSync(envPath, 'utf8'),
    routesText: fs.readFileSync(routesPath, 'utf8'),
    providersText: fs.existsSync(providersPath) ? fs.readFileSync(providersPath, 'utf8') : null
  })
}

export function digestSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot)
  return crypto.createHash('sha256')
    .update('channels.local.env\0')
    .update(normalized.envText)
    .update('\0routes.local.json\0')
    .update(normalized.routesText)
    .update('\0providers.local.json\0')
    .update(normalized.providersText ?? '')
    .digest('hex')
}

export function diffSnapshots(beforeSnapshot, afterSnapshot) {
  const before = normalizeSnapshot(beforeSnapshot)
  const after = normalizeSnapshot(afterSnapshot)
  const beforeRoutes = parseJsonObject(before.routesText)
  const afterRoutes = parseJsonObject(after.routesText)
  const beforeChannels = channelSources(before, beforeRoutes)
  const afterChannels = channelSources(after, afterRoutes)
  const channelIds = [...new Set([...beforeChannels.keys(), ...afterChannels.keys()])].sort((left, right) => left.localeCompare(right))
  const channels = { added: [], removed: [], changed: [] }
  for (const id of channelIds) {
    const left = beforeChannels.get(id)
    const right = afterChannels.get(id)
    if (!left) channels.added.push(id)
    else if (!right) channels.removed.push(id)
    else {
      const fields = {}
      if (left.name !== right.name) fields.nameChanged = true
      if (left.baseUrl !== right.baseUrl) fields.baseUrlChanged = true
      if (left.apiKey !== right.apiKey) fields.apiKeyReplaced = true
      if (left.protocol !== right.protocol) fields.protocolChanged = true
      if (left.enabled !== right.enabled) fields.enabledChanged = true
      if (left.priority !== right.priority) fields.priorityChanged = true
      if (left.staged !== right.staged) fields.stagedChanged = true
      if (Object.keys(fields).length) channels.changed.push({ id, ...fields })
    }
  }

  const models = diffModels(beforeRoutes, afterRoutes)
  const logicalModels = diffLogicalModels(beforeRoutes, afterRoutes)
  const aliases = diffAliases(beforeRoutes, afterRoutes)
  return { channels, models, logicalModels, aliases }
}

function readRevision(revisionRoot, revisionValue) {
  const revision = normalizeRevisionId(revisionValue)
  const directory = revisionPath(revisionRoot, revision)
  if (!fs.existsSync(directory)) throw new ConfigRevisionError('revision_not_found', 404, 'Configuration revision was not found')
  let manifest
  let snapshot
  try {
    manifest = normalizeManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')))
    if (manifest.revision !== revision) throw new Error('Revision id mismatch')
    snapshot = normalizeSnapshot({
      envText: fs.readFileSync(path.join(directory, 'channels.local.env'), 'utf8'),
      routesText: fs.readFileSync(path.join(directory, 'routes.local.json'), 'utf8'),
      providersText: manifest.files.providers
        ? fs.readFileSync(path.join(directory, 'providers.local.json'), 'utf8')
        : null
    })
    if (digestSnapshot(snapshot) !== manifest.contentDigest) throw new Error('Revision digest mismatch')
  } catch (error) {
    if (error instanceof ConfigRevisionError) throw error
    throw new ConfigRevisionError('revision_invalid', 409, 'Configuration revision is invalid')
  }
  return { manifest: structuredClone(manifest), snapshot }
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object') throw new ConfigRevisionError('invalid_revision_snapshot', 400, 'Configuration snapshot is required')
  if (typeof value.envText !== 'string' || typeof value.routesText !== 'string') {
    throw new ConfigRevisionError('invalid_revision_snapshot', 400, 'Configuration snapshot files must be text')
  }
  if (value.providersText !== null && value.providersText !== undefined && typeof value.providersText !== 'string') {
    throw new ConfigRevisionError('invalid_revision_snapshot', 400, 'Provider snapshot must be text or null')
  }
  return {
    envText: value.envText,
    routesText: value.routesText,
    providersText: value.providersText ?? null
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function channelSources(snapshot, routes) {
  const values = parseEnv(snapshot.envText)
  const providers = snapshot.providersText === null ? null : parseJsonObject(snapshot.providersText)
  const result = new Map()
  for (const route of Array.isArray(routes.channels) ? routes.channels : []) {
    const id = String(route.id ?? '').trim().toLowerCase()
    if (!id) continue
    const provider = providers?.providers?.find(item => String(item?.id ?? '').trim().toLowerCase() === id)
    const prefix = `CHANNEL_${id.toUpperCase().replaceAll('-', '_')}`
    result.set(id, {
      name: String(provider?.name ?? values[`${prefix}_NAME`] ?? ''),
      baseUrl: String(provider?.baseUrl ?? values[`${prefix}_BASE_URL`] ?? ''),
      apiKey: String(provider?.apiKey ?? values[`${prefix}_API_KEY`] ?? ''),
      protocol: String(provider?.protocol ?? values[`${prefix}_PROTOCOL`] ?? 'openai-compatible'),
      enabled: provider ? Boolean(provider.enabled) : !/^(false|0)$/i.test(values[`${prefix}_ENABLED`] ?? 'true'),
      priority: provider?.priority ?? route.priority ?? 0,
      staged: Boolean(route.staged)
    })
  }
  return result
}

function diffModels(beforeRoutes, afterRoutes) {
  const before = modelMap(beforeRoutes)
  const after = modelMap(afterRoutes)
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right))
  const result = { added: [], removed: [], changed: [] }
  for (const id of ids) {
    const left = before.get(id)
    const right = after.get(id)
    if (!left) result.added.push(id)
    else if (!right) result.removed.push(id)
    else {
      const fields = {}
      for (const field of ['protocol', 'priority', 'status', 'kind', 'streaming', 'canaryEligible']) {
        if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) fields[`${field}Changed`] = true
      }
      if (JSON.stringify(left.aliases) !== JSON.stringify(right.aliases)) fields.aliasesChanged = true
      if (Object.keys(fields).length) result.changed.push({ id, ...fields })
    }
  }
  return result
}

function modelMap(routes) {
  const result = new Map()
  for (const channel of Array.isArray(routes.channels) ? routes.channels : []) {
    const channelId = String(channel.id ?? '').trim().toLowerCase()
    for (const model of Array.isArray(channel.models) ? channel.models : []) {
      const upstream = String(model.upstream ?? '').trim()
      if (!channelId || !upstream) continue
      result.set(`${channelId}/${upstream}`, {
        protocol: model.protocol ?? null,
        priority: model.priority ?? null,
        status: model.status ?? 'active',
        kind: model.kind ?? null,
        streaming: model.streaming ?? null,
        canaryEligible: model.canaryEligible ?? null,
        aliases: [...new Set(Array.isArray(model.aliases) ? model.aliases.map(value => String(value)) : [])].sort()
      })
    }
  }
  return result
}

function diffAliases(beforeRoutes, afterRoutes) {
  return {
    stable: diffAliasList(beforeRoutes.stableAliases, afterRoutes.stableAliases),
    pinned: diffAliasList(beforeRoutes.pinnedAliases, afterRoutes.pinnedAliases)
  }
}

function diffLogicalModels(beforeRoutes, afterRoutes) {
  const before = logicalModelMap(beforeRoutes)
  const after = logicalModelMap(afterRoutes)
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right))
  const result = { added: [], removed: [], changed: [] }
  for (const id of ids) {
    const left = before.get(id)
    const right = after.get(id)
    if (!left) result.added.push(id)
    else if (!right) result.removed.push(id)
    else {
      const fields = {}
      if (left.enabled !== right.enabled) fields.enabledChanged = true
      if (JSON.stringify(left.candidates) !== JSON.stringify(right.candidates)) fields.candidatesChanged = true
      if (Object.keys(fields).length) result.changed.push({ id, ...fields })
    }
  }
  return result
}

function logicalModelMap(routes) {
  const result = new Map()
  for (const item of Array.isArray(routes.logicalModels) ? routes.logicalModels : []) {
    const id = String(item?.id ?? '').trim()
    if (!id) continue
    const candidates = (Array.isArray(item.candidates) ? item.candidates : [])
      .map(candidate => ({
        channel: String(candidate?.channel ?? '').trim(),
        model: String(candidate?.model ?? '').trim(),
        enabled: candidate?.enabled !== false,
        priority: candidate?.priority ?? 0
      }))
      .sort((left, right) => left.channel.localeCompare(right.channel) || left.model.localeCompare(right.model))
    result.set(id, { enabled: item.enabled !== false, candidates })
  }
  return result
}

function diffAliasList(before = [], after = []) {
  const left = new Map((Array.isArray(before) ? before : []).map(item => [String(item?.alias ?? ''), aliasTarget(item)]))
  const right = new Map((Array.isArray(after) ? after : []).map(item => [String(item?.alias ?? ''), aliasTarget(item)]))
  const added = []
  const removed = []
  const changed = []
  for (const alias of [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a.localeCompare(b))) {
    if (!left.has(alias)) added.push({ alias, target: right.get(alias) })
    else if (!right.has(alias)) removed.push({ alias, target: left.get(alias) })
    else if (left.get(alias) !== right.get(alias)) changed.push({ alias, from: left.get(alias), to: right.get(alias) })
  }
  return { added, removed, changed }
}

function aliasTarget(item) {
  if (item?.logicalModel) return `logical:${String(item.logicalModel).trim()}`
  return `${String(item?.channel ?? '').trim()}/${String(item?.model ?? '').trim()}`
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision manifest must be an object')
  const revision = normalizeRevisionId(value.revision)
  const parentRevision = value.parentRevision === null ? null : normalizeRevisionId(value.parentRevision)
  const createdAt = normalizeTimestamp(value.createdAt)
  const operation = String(value.operation ?? '')
  if (value.schemaVersion !== VERSION || !OPERATION.test(operation)) {
    throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision manifest fields are invalid')
  }
  const contentDigest = String(value.contentDigest ?? '')
  if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision content digest is invalid')
  if (value.validation?.ok !== true) throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision validation result is invalid')
  return {
    schemaVersion: VERSION,
    revision,
    parentRevision,
    createdAt,
    operation,
    affected: normalizeAffected(value.affected),
    contentDigest,
    validation: { ok: true },
    files: {
      env: 'channels.local.env',
      routes: 'routes.local.json',
      providers: value.files?.providers === true
    }
  }
}

function normalizeAffected(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    channelIds: normalizeList(input.channelIds, CHANNEL_ID, 100),
    modelIds: normalizeList(input.modelIds, /^[^\r\n\0]{1,512}$/, 500),
    logicalModelIds: normalizeList(input.logicalModelIds, /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,254}$/, 200)
  }
}

function normalizeList(value, pattern, maximum) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision affected fields must be arrays')
  const result = [...new Set(value.map(item => String(item).trim()))]
  if (result.length > maximum || result.some(item => !pattern.test(item))) {
    throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision affected identifiers are invalid')
  }
  return result.sort((left, right) => left.localeCompare(right))
}

function writeSnapshot(directory, snapshot) {
  fs.writeFileSync(path.join(directory, 'channels.local.env'), snapshot.envText, { mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'routes.local.json'), snapshot.routesText, { mode: 0o600 })
  if (snapshot.providersText !== null) fs.writeFileSync(path.join(directory, 'providers.local.json'), snapshot.providersText, { mode: 0o600 })
}

function publicManifest(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    revision: manifest.revision,
    parentRevision: manifest.parentRevision,
    createdAt: manifest.createdAt,
    operation: manifest.operation,
    affected: structuredClone(manifest.affected),
    contentDigest: manifest.contentDigest,
    validation: { ok: true },
    files: { ...manifest.files },
    valid: true
  }
}

function normalizeRevisionId(value) {
  const revision = String(value ?? '')
  if (!REVISION_ID.test(revision)) throw new ConfigRevisionError('invalid_revision_id', 400, 'Configuration revision id is invalid')
  return revision
}

function normalizeTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ConfigRevisionError('invalid_revision_manifest', 400, 'Revision timestamp is invalid')
  }
  return new Date(value).toISOString()
}

function compactTimestamp(value) {
  return value.replaceAll('-', '').replaceAll(':', '').replace('.', '')
}

function nonce(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8)
}

function revisionPath(revisionRoot, revision) {
  const target = path.resolve(revisionRoot, revision)
  if (path.dirname(target) !== revisionRoot) throw new ConfigRevisionError('invalid_revision_id', 400, 'Configuration revision path is invalid')
  return target
}

function removeTemporaryDirectory(revisionRoot, temporaryDir) {
  const resolved = path.resolve(temporaryDir)
  if (path.dirname(resolved) !== revisionRoot || !path.basename(resolved).startsWith('.tmp-')) return
  try { fs.rmSync(resolved, { recursive: true, force: true }) } catch {}
}
