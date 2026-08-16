import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.mjs'
import { parseEnv, serializeEnv } from './env.mjs'
import { fetchChannelModels, selectChannelsForSync, synchronizeRouteModels } from './model-sync.mjs'
import { isGenerationModel, normalizeModelKind, normalizeStreamingMode } from './model-metadata.mjs'

const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/
const MODEL_ID = /^[^\s/][^\r\n]{0,254}$/
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}$/
const PROTOCOLS = new Set(['openai-compatible', 'responses', 'claude'])
const MODEL_STATUSES = new Set(['active', 'stale', 'disabled'])

export class ConfigMutationError extends Error {
  constructor(code, statusCode, message) {
    super(message)
    this.name = 'ConfigMutationError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function createPrivateConfigManager(config, { fetchImpl = fetch } = {}) {
  if (!config.paths?.routesPath || !config.paths?.envPath) return null
  const routesPath = config.paths.routesPath
  const envPath = config.paths.envPath
  const root = path.dirname(path.dirname(routesPath))
  let loadedRevision = currentRevision()
  let modelSyncActive = false

  return {
    status() {
      const pendingRevision = currentRevision()
      return {
        revision: pendingRevision,
        loadedRevision,
        pendingRevision,
        restartRequired: pendingRevision !== loadedRevision
      }
    },
    markApplied() {
      const previousRevision = loadedRevision
      loadedRevision = currentRevision()
      try {
        return this.status()
      } catch (error) {
        loadedRevision = previousRevision
        throw error
      }
    },
    routing() {
      const routes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
      const env = parseEnv(fs.readFileSync(envPath, 'utf8'))
      return {
        stableAliases: (routes.stableAliases ?? []).map(({ alias, channel, model }) => ({ alias, channel, model })),
        pinnedAliases: (routes.pinnedAliases ?? []).map(({ alias, channel, model, approvalRef }) => ({ alias, channel, model, approvalRef })),
        models: (routes.channels ?? []).flatMap(channel => (channel.models ?? []).map(model => {
          const kind = normalizeModelKind(model.kind, model.upstream)
          const prefix = envPrefix(channel.id)
          return {
            channel: channel.id,
            model: model.upstream,
            protocol: model.protocol ?? env[`${prefix}_PROTOCOL`] ?? 'openai-compatible',
            priority: model.priority ?? channel.priority ?? 0,
            staged: channel.staged === true,
            channelEnabled: channel.enabled !== false && !channel.staged,
            status: model.status ?? 'active',
            kind,
            streaming: normalizeStreamingMode(model.streaming),
            canaryEligible: model.canaryEligible ?? isGenerationModel({ kind })
          }
        }))
      }
    },
    discoverChannels() {
      const env = parseEnv(fs.readFileSync(envPath, 'utf8'))
      const diskRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
      const diskIds = new Set((diskRoutes.channels ?? []).map(channel => String(channel.id).toLowerCase()))
      const runtimeIds = new Set(config.channels.map(channel => channel.id))
      const grouped = new Map()
      for (const key of Object.keys(env)) {
        const match = /^CHANNEL_([A-Z][A-Z0-9_]*)_(NAME|BASE_URL|API_KEY|PROTOCOL|ENABLED)$/.exec(key)
        if (!match) continue
        const id = match[1].toLowerCase().replaceAll('_', '-')
        const entry = grouped.get(id) ?? { id, prefix: match[1], values: {} }
        entry.values[match[2]] = env[key]?.trim() ?? ''
        grouped.set(id, entry)
      }
      const unregistered = []
      const pendingRestart = []
      for (const entry of grouped.values()) {
        const values = entry.values
        const missing = []
        if (!values.NAME) missing.push('NAME')
        if (!values.BASE_URL) missing.push('BASE_URL')
        if (!values.API_KEY || values.API_KEY.includes('replace-me') || values.API_KEY.includes('replace-with')) missing.push('API_KEY')
        if (!values.PROTOCOL) missing.push('PROTOCOL')
        if (values.BASE_URL) {
          try {
            const url = new URL(values.BASE_URL)
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) missing.push('BASE_URL')
          } catch {
            missing.push('BASE_URL')
          }
        }
        if (values.PROTOCOL && !PROTOCOLS.has(values.PROTOCOL)) missing.push('PROTOCOL')
        const summary = {
          id: entry.id,
          name: values.NAME || entry.id,
          baseUrl: values.BASE_URL || '',
          protocol: values.PROTOCOL || 'openai-compatible',
          enabledByEnv: !/^(false|0)$/i.test(values.ENABLED ?? 'true'),
          hasApiKey: Boolean(values.API_KEY),
          ready: missing.length === 0,
          missing
        }
        if (!diskIds.has(entry.id)) unregistered.push(summary)
        else if (!runtimeIds.has(entry.id)) pendingRestart.push(summary)
      }
      return {
        unregistered: unregistered.sort((left, right) => left.id.localeCompare(right.id)),
        pendingRestart: pendingRestart.sort((left, right) => left.id.localeCompare(right.id)),
        restartRequired: this.status().restartRequired
      }
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
        routes.channels.push({ id, enabled: false, staged: true, priority: values.priority, models: [] })
        return { id, name: values.name, enabled: false, staged: true, protocol: values.protocol, priority: values.priority, modelCount: 0, hasApiKey: true }
      })
    },
    importChannel(idValue) {
      return mutate(({ routes, env }) => {
        const id = normalizeChannelId(idValue)
        if ((routes.channels ?? []).some(channel => channel.id === id)) {
          throw new ConfigMutationError('channel_exists', 409, `Channel already exists: ${id}`)
        }
        const prefix = envPrefix(id)
        const values = validateChannelInput({
          name: env[`${prefix}_NAME`],
          baseUrl: env[`${prefix}_BASE_URL`],
          apiKey: env[`${prefix}_API_KEY`],
          protocol: env[`${prefix}_PROTOCOL`] || 'openai-compatible',
          priority: 0
        }, { requireApiKey: true })
        env[`${prefix}_ENABLED`] = 'false'
        routes.channels ??= []
        routes.channels.push({ id, enabled: false, staged: true, priority: values.priority, models: [] })
        return { id, name: values.name, enabled: false, staged: true, protocol: values.protocol, priority: values.priority, modelCount: 0, hasApiKey: true }
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
        if (values.staged !== undefined) {
          channel.staged = values.staged
          if (values.staged) {
            channel.enabled = false
            env[`${prefix}_ENABLED`] = 'false'
          }
        }
        if (values.priority !== undefined) channel.priority = values.priority
        return {
          id,
          name: env[`${prefix}_NAME`] || id,
          enabled: Boolean(channel.enabled),
          staged: Boolean(channel.staged),
          protocol: env[`${prefix}_PROTOCOL`] || 'openai-compatible',
          priority: channel.priority ?? 0,
          modelCount: (channel.models ?? []).length,
          hasApiKey: Boolean(env[`${prefix}_API_KEY`])
        }
      })
    },
    updateModelStatus(channelValue, modelValue, statusValue) {
      return mutate(({ routes }) => {
        const channelId = normalizeChannelId(channelValue)
        const modelId = normalizeModelId(modelValue)
        const status = String(statusValue ?? '').trim()
        if (!MODEL_STATUSES.has(status)) throw new ConfigMutationError('invalid_model_status', 400, `Unsupported model status: ${status}`)
        const channel = (routes.channels ?? []).find(item => item.id === channelId)
        if (!channel) throw new ConfigMutationError('channel_not_found', 404, `Unknown channel: ${channelId}`)
        const model = (channel.models ?? []).find(item => item.upstream === modelId)
        if (!model) throw new ConfigMutationError('model_not_found', 404, `Unknown model: ${channelId}/${modelId}`)
        if (status === 'disabled') {
          const references = [...(routes.stableAliases ?? []), ...(routes.pinnedAliases ?? [])]
            .filter(route => route.channel === channelId && route.model === modelId)
            .map(route => route.alias)
          if (references.length) {
            throw new ConfigMutationError('model_has_aliases', 409, `Move aliases before disabling this model: ${references.join(', ')}`)
          }
        }
        model.status = status
        return { channel: channelId, model: modelId, status }
      })
    },
    setStableAlias(aliasValue, channelValue, modelValue) {
      return mutate(({ routes }) => {
        const alias = normalizeAlias(aliasValue)
        const channelId = normalizeChannelId(channelValue)
        const modelId = normalizeModelId(modelValue)
        const channel = (routes.channels ?? []).find(item => item.id === channelId)
        if (!channel) throw new ConfigMutationError('channel_not_found', 404, `Unknown channel: ${channelId}`)
        const model = (channel.models ?? []).find(item => item.upstream === modelId)
        if (!model) throw new ConfigMutationError('model_not_found', 404, `Unknown model: ${channelId}/${modelId}`)
        if (!isGenerationModel({ kind: normalizeModelKind(model.kind, model.upstream) })) {
          throw new ConfigMutationError('model_not_generation', 409, 'Only generation models can receive a stable alias')
        }
        if (model.status === 'disabled') throw new ConfigMutationError('model_disabled', 409, 'A disabled model cannot receive a stable alias')
        routes.stableAliases ??= []
        const current = routes.stableAliases.find(item => item.alias === alias)
        if (!current) {
          const conflicts = [
            ...(routes.pinnedAliases ?? []).map(item => item.alias),
            ...(routes.channels ?? []).flatMap(item => (item.models ?? []).flatMap(entry => entry.aliases ?? []))
          ]
          if (conflicts.includes(alias)) throw new ConfigMutationError('alias_conflict', 409, `Alias is already in use: ${alias}`)
          routes.stableAliases.push({ alias, channel: channelId, model: modelId })
        } else {
          current.channel = channelId
          current.model = modelId
        }
        return { alias, channel: channelId, model: modelId }
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
        if ((channel.enabled !== false && enabledByEnv) || channel.staged === true) {
          throw new ConfigMutationError('channel_must_be_disabled', 409, 'Disable the channel before deleting it')
        }
        if ([...(routes.stableAliases ?? []), ...(routes.pinnedAliases ?? [])].some(route => route.channel === id)) {
          throw new ConfigMutationError('channel_has_aliases', 409, 'Move stable and pinned aliases before deleting the channel')
        }
        routes.channels.splice(index, 1)
        for (const key of Object.keys(env)) if (key.startsWith(`${prefix}_`)) delete env[key]
        return { id, deleted: true }
      })
    },
    async syncModels(requestedIds = []) {
      if (modelSyncActive) throw new ConfigMutationError('model_sync_in_progress', 409, 'A model synchronization is already in progress')
      modelSyncActive = true
      try {
        const current = loadConfig(root, { allowEmptyEnabledChannels: true })
        let selected
        try {
          selected = selectChannelsForSync(current.channels, requestedIds)
        } catch (error) {
          throw new ConfigMutationError('invalid_sync_channels', 400, error instanceof Error ? error.message : 'Invalid channels requested for synchronization')
        }
        if (!selected.length) throw new ConfigMutationError('no_sync_channels', 400, 'No channels are available for model synchronization')
        const discoveries = new Map()
        try {
          for (const channel of selected) discoveries.set(channel.id, await fetchChannelModels(channel, { fetchImpl }))
        } catch (error) {
          throw new ConfigMutationError('model_sync_failed', 502, error instanceof Error ? error.message : 'Model synchronization failed')
        }
        const { routes, summaries } = synchronizeRouteModels(current.routes, discoveries)
        const originalRoutes = fs.readFileSync(routesPath, 'utf8')
        const nextRoutes = JSON.stringify(routes, null, 2) + '\n'
        if (nextRoutes === originalRoutes) {
          const revision = currentRevision()
          return { changed: false, channels: summaries, revision, restartRequired: revision !== loadedRevision }
        }
        const revision = digest(fs.readFileSync(envPath, 'utf8'), nextRoutes)
        const backupDir = path.join(root, 'runtime', 'config-revisions', `${timestamp()}-${revision}`)
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(path.join(backupDir, 'routes.local.json'), originalRoutes, { mode: 0o600 })
        try {
          atomicWrite(routesPath, nextRoutes)
          loadConfig(root, { allowEmptyEnabledChannels: true })
        } catch (error) {
          atomicWrite(routesPath, originalRoutes)
          throw new ConfigMutationError('configuration_validation_failed', 400, error instanceof Error ? error.message : 'Configuration validation failed')
        }
        return {
          changed: true,
          channels: summaries,
          backup: path.relative(root, path.join(backupDir, 'routes.local.json')).replaceAll('\\', '/'),
          revision,
          restartRequired: revision !== loadedRevision
        }
      } finally {
        modelSyncActive = false
      }
    }
  }

  function mutate(change) {
    if (modelSyncActive) throw new ConfigMutationError('model_sync_in_progress', 409, 'Configuration changes are paused while model synchronization is in progress')
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
    return { ...result, revision, restartRequired: revision !== loadedRevision }
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
  if (input.staged !== undefined) {
    if (typeof input.staged !== 'boolean') throw new ConfigMutationError('invalid_staged', 400, 'Channel staged must be a boolean')
    result.staged = input.staged
  }
  return result
}

function normalizeChannelId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  if (!CHANNEL_ID.test(id)) throw new ConfigMutationError('invalid_channel_id', 400, 'Channel id must match [a-z][a-z0-9-]{0,31}')
  return id
}

function normalizeModelId(value) {
  const model = String(value ?? '').trim()
  if (!MODEL_ID.test(model)) throw new ConfigMutationError('invalid_model_id', 400, 'Model id is invalid')
  return model
}

function normalizeAlias(value) {
  const alias = String(value ?? '').trim()
  if (!ALIAS.test(alias)) throw new ConfigMutationError('invalid_alias', 400, 'Alias is invalid')
  return alias
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
