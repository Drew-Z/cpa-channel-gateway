import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.mjs'
import { parseEnv, serializeEnv } from './env.mjs'

const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/
const PROTOCOLS = new Set(['openai-compatible', 'responses', 'claude'])

export class ConfigMutationError extends Error {
  constructor(code, statusCode, message) {
    super(message)
    this.name = 'ConfigMutationError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function createPrivateConfigManager(config) {
  if (!config.paths?.routesPath || !config.paths?.envPath) return null
  const routesPath = config.paths.routesPath
  const envPath = config.paths.envPath
  const root = path.dirname(path.dirname(routesPath))
  const initialRevision = currentRevision()

  return {
    status() {
      const revision = currentRevision()
      return { revision, restartRequired: revision !== initialRevision }
    },
    createChannel(input) {
      return mutate(({ routes, env }) => {
        const id = normalizeChannelId(input.id)
        if ((routes.channels ?? []).some(channel => channel.id === id)) {
          throw new ConfigMutationError('channel_exists', 409, `Channel already exists: ${id}`)
        }
        const values = validateChannelInput(input, { requireApiKey: true })
        const prefix = envPrefix(id)
        env[`${prefix}_NAME`] = values.name
        env[`${prefix}_BASE_URL`] = values.baseUrl
        env[`${prefix}_API_KEY`] = values.apiKey
        env[`${prefix}_PROTOCOL`] = values.protocol
        env[`${prefix}_ENABLED`] = 'false'
        routes.channels ??= []
        routes.channels.push({ id, enabled: false, priority: values.priority, models: [] })
        return { id, name: values.name, enabled: false, protocol: values.protocol, priority: values.priority, modelCount: 0, hasApiKey: true }
      })
    },
    updateChannel(idValue, input) {
      return mutate(({ routes, env }) => {
        const id = normalizeChannelId(idValue)
        const channel = (routes.channels ?? []).find(item => item.id === id)
        if (!channel) throw new ConfigMutationError('channel_not_found', 404, `Unknown channel: ${id}`)
        const prefix = envPrefix(id)
        const values = validateChannelInput(input, { partial: true, requireApiKey: false })
        if (values.name !== undefined) env[`${prefix}_NAME`] = values.name
        if (values.baseUrl !== undefined) env[`${prefix}_BASE_URL`] = values.baseUrl
        if (values.apiKey !== undefined) env[`${prefix}_API_KEY`] = values.apiKey
        if (values.protocol !== undefined) env[`${prefix}_PROTOCOL`] = values.protocol
        if (values.enabled !== undefined) {
          channel.enabled = values.enabled
          env[`${prefix}_ENABLED`] = String(values.enabled)
        }
        if (values.priority !== undefined) channel.priority = values.priority
        return {
          id,
          name: env[`${prefix}_NAME`] || id,
          enabled: Boolean(channel.enabled),
          protocol: env[`${prefix}_PROTOCOL`] || 'openai-compatible',
          priority: channel.priority ?? 0,
          modelCount: (channel.models ?? []).length,
          hasApiKey: Boolean(env[`${prefix}_API_KEY`])
        }
      })
    },
    deleteChannel(idValue) {
      return mutate(({ routes, env }) => {
        const id = normalizeChannelId(idValue)
        const index = (routes.channels ?? []).findIndex(item => item.id === id)
        if (index < 0) throw new ConfigMutationError('channel_not_found', 404, `Unknown channel: ${id}`)
        const channel = routes.channels[index]
        const prefix = envPrefix(id)
        const enabledByEnv = !/^(false|0)$/i.test(env[`${prefix}_ENABLED`] ?? 'true')
        if (channel.enabled !== false && enabledByEnv) {
          throw new ConfigMutationError('channel_must_be_disabled', 409, 'Disable the channel before deleting it')
        }
        if ([...(routes.stableAliases ?? []), ...(routes.pinnedAliases ?? [])].some(route => route.channel === id)) {
          throw new ConfigMutationError('channel_has_aliases', 409, 'Move stable and pinned aliases before deleting the channel')
        }
        routes.channels.splice(index, 1)
        for (const key of Object.keys(env)) if (key.startsWith(`${prefix}_`)) delete env[key]
        return { id, deleted: true }
      })
    }
  }

  function mutate(change) {
    const originalEnv = fs.readFileSync(envPath, 'utf8')
    const originalRoutes = fs.readFileSync(routesPath, 'utf8')
    const env = parseEnv(originalEnv)
    const routes = JSON.parse(originalRoutes)
    const result = change({ routes, env })
    const nextEnv = serializeEnv(env)
    const nextRoutes = JSON.stringify(routes, null, 2) + '\n'
    const revision = digest(nextEnv, nextRoutes)
    const backupDir = path.join(root, 'runtime', 'config-revisions', `${timestamp()}-${revision}`)
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(backupDir, 'channels.local.env'), originalEnv, { mode: 0o600 })
    fs.writeFileSync(path.join(backupDir, 'routes.local.json'), originalRoutes, { mode: 0o600 })
    try {
      atomicWrite(envPath, nextEnv)
      atomicWrite(routesPath, nextRoutes)
      loadConfig(root)
    } catch (error) {
      atomicWrite(envPath, originalEnv)
      atomicWrite(routesPath, originalRoutes)
      if (error instanceof ConfigMutationError) throw error
      throw new ConfigMutationError('configuration_validation_failed', 400, error instanceof Error ? error.message : 'Configuration validation failed')
    }
    return { ...result, revision, restartRequired: revision !== initialRevision }
  }

  function currentRevision() {
    return digest(fs.readFileSync(envPath, 'utf8'), fs.readFileSync(routesPath, 'utf8'))
  }
}

function validateChannelInput(input, { partial = false, requireApiKey = false } = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ConfigMutationError('invalid_request', 400, 'Channel body must be an object')
  const result = {}
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim()
    if (!name || name.length > 80) throw new ConfigMutationError('invalid_channel_name', 400, 'Channel name is required and must be at most 80 characters')
    result.name = name
  }
  if (!partial || input.baseUrl !== undefined) {
    const baseUrl = String(input.baseUrl ?? '').trim()
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid')
    } catch {
      throw new ConfigMutationError('invalid_base_url', 400, 'Base URL must be a clean http(s) URL')
    }
    result.baseUrl = baseUrl
  }
  if (requireApiKey || input.apiKey !== undefined) {
    const apiKey = String(input.apiKey ?? '').trim()
    if (apiKey.length < 8) throw new ConfigMutationError('invalid_api_key', 400, 'Channel API key must contain at least 8 characters')
    result.apiKey = apiKey
  }
  if (!partial || input.protocol !== undefined) {
    const protocol = String(input.protocol ?? '').trim()
    if (!PROTOCOLS.has(protocol)) throw new ConfigMutationError('invalid_protocol', 400, `Unsupported protocol: ${protocol}`)
    result.protocol = protocol
  }
  if (input.priority !== undefined || !partial) {
    const priority = input.priority ?? 0
    if (!Number.isSafeInteger(priority)) throw new ConfigMutationError('invalid_priority', 400, 'Channel priority must be an integer')
    result.priority = priority
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new ConfigMutationError('invalid_enabled', 400, 'Channel enabled must be a boolean')
    result.enabled = input.enabled
  }
  return result
}

function normalizeChannelId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  if (!CHANNEL_ID.test(id)) throw new ConfigMutationError('invalid_channel_id', 400, 'Channel id must match [a-z][a-z0-9-]{0,31}')
  return id
}

function envPrefix(id) {
  return `CHANNEL_${id.toUpperCase().replaceAll('-', '_')}`
}

function digest(envText, routesText) {
  return crypto.createHash('sha256').update(envText).update('\0').update(routesText).digest('hex').slice(0, 16)
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
}
