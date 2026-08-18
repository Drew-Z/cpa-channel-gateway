import crypto from 'node:crypto'

const ID = /^[a-z][a-z0-9-]{0,63}$/
const HASH = /^[a-f0-9]{64}$/

export function hashClientKey(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
}

export function createClientKey() {
  const key = `cpa_${crypto.randomBytes(24).toString('base64url')}`
  return { key, keyHash: hashClientKey(key), keyHint: key.slice(-6) }
}

export function normalizeClientAccess(document, channelIds = []) {
  if (document === null || document === undefined) return null
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('clients.local.json must contain an object')
  if (document.schemaVersion !== 1) throw new Error('clients.local.json schemaVersion must be 1')
  if (!Array.isArray(document.groups)) throw new Error('clients.local.json groups must be an array')
  if (!Array.isArray(document.clients)) throw new Error('clients.local.json clients must be an array')
  const knownChannels = new Set(channelIds.map(value => String(value).trim().toLowerCase()))
  const groups = []
  const groupIds = new Set()
  const assigned = new Map()
  for (const [index, value] of document.groups.entries()) {
    const group = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const id = String(group.id ?? '').trim().toLowerCase()
    if (!ID.test(id)) throw new Error(`clients.groups[${index}].id is invalid`)
    if (groupIds.has(id)) throw new Error(`Duplicate client group id: ${id}`)
    groupIds.add(id)
    if (!Array.isArray(group.channels) || !group.channels.length) throw new Error(`clients.groups[${index}].channels must be a non-empty array`)
    const channels = [...new Set(group.channels.map(item => String(item).trim().toLowerCase()))]
    for (const channel of channels) {
      if (!ID.test(channel) || (knownChannels.size && !knownChannels.has(channel))) throw new Error(`clients.groups[${index}] references unknown channel ${channel}`)
      if (group.enabled !== false && assigned.has(channel)) throw new Error(`Enabled client groups overlap on channel ${channel}`)
      if (group.enabled !== false) assigned.set(channel, id)
    }
    if (group.enabled !== undefined && typeof group.enabled !== 'boolean') throw new Error(`clients.groups[${index}].enabled must be boolean`)
    groups.push({ id, channels, enabled: group.enabled !== false })
  }
  const clients = []
  const clientIds = new Set()
  const keyHashes = new Set()
  for (const [index, value] of document.clients.entries()) {
    const client = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    const id = String(client.id ?? '').trim().toLowerCase()
    const group = String(client.group ?? '').trim().toLowerCase()
    const keyHash = String(client.keyHash ?? '').trim().toLowerCase()
    if (!ID.test(id)) throw new Error(`clients.clients[${index}].id is invalid`)
    if (clientIds.has(id)) throw new Error(`Duplicate client id: ${id}`)
    if (!groupIds.has(group)) throw new Error(`clients.clients[${index}] references unknown group ${group}`)
    if (!HASH.test(keyHash)) throw new Error(`clients.clients[${index}].keyHash is invalid`)
    if (keyHashes.has(keyHash)) throw new Error(`Duplicate client key hash: ${id}`)
    if (client.enabled !== undefined && typeof client.enabled !== 'boolean') throw new Error(`clients.clients[${index}].enabled must be boolean`)
    clientIds.add(id)
    keyHashes.add(keyHash)
    clients.push({ id, group, keyHash, keyHint: String(client.keyHint ?? '').trim().slice(-12) || undefined, enabled: client.enabled !== false })
  }
  return { schemaVersion: 1, groups, clients }
}

export function publicClientAccess(document) {
  if (!document) return { enabled: false, groups: [], clients: [] }
  return {
    enabled: true,
    groups: document.groups.map(group => ({ id: group.id, channels: [...group.channels], enabled: group.enabled !== false })),
    clients: document.clients.map(client => ({ id: client.id, group: client.group, enabled: client.enabled !== false, keyHint: client.keyHint ?? null }))
  }
}

export function resolveClient(document, providedKey) {
  if (!document) return null
  const hash = hashClientKey(providedKey)
  const client = document.clients.find(item => item.keyHash === hash && item.enabled !== false)
  if (!client) return null
  const group = document.groups.find(item => item.id === client.group && item.enabled !== false)
  if (!group) return null
  return { clientId: client.id, groupId: group.id, allowedChannels: new Set(group.channels) }
}
