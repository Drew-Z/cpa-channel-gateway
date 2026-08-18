import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.mjs'
import { createConfigRevisionStore, diffSnapshots, digestSnapshot } from './config-revisions.mjs'
import { parseEnv, serializeEnv } from './env.mjs'
import { fetchChannelModels, selectChannelsForSync, synchronizeRouteModels } from './model-sync.mjs'
import { isGenerationModel, normalizeModelKind, normalizeStreamingMode } from './model-metadata.mjs'
import { collectLegacyChannelEntries, providerEnvPrefix, stripLegacyChannelEnv } from './providers.mjs'
import { createClientKey, normalizeClientAccess, publicClientAccess } from './client-access.mjs'

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

export function createPrivateConfigManager(config, { fetchImpl = fetch, revisionStore: revisionStoreOption = null } = {}) {
  if (!config.paths?.routesPath || !config.paths?.envPath) return null
  const routesPath = config.paths.routesPath
  const envPath = config.paths.envPath
  const root = path.dirname(path.dirname(routesPath))
  const providersPath = config.paths.providersPath ?? path.join(path.dirname(routesPath), 'providers.local.json')
  const clientsPath = config.paths.clientsPath ?? path.join(path.dirname(routesPath), 'clients.local.json')
  const revisionStore = revisionStoreOption ?? createConfigRevisionStore({ root })
  let pendingManifest = initialRevision()
  let loadedRevision = pendingManifest.revision
  let modelSyncActive = false

  return {
    status() {
      const pendingRevision = refreshCurrentRevision().revision
      const protectedRevisions = [loadedRevision, pendingRevision]
      const storageOptions = revisionStore.inventoryOptions?.({ keeps: [20, 50, 100], protectedRevisions }) ?? null
      const revisionStorage = storageOptions?.['50'] ?? revisionStore.inventory?.({ keep: 50, protectedRevisions }) ?? null
      return {
        revision: pendingRevision,
        loadedRevision,
        pendingRevision,
        restartRequired: pendingRevision !== loadedRevision,
        revisionStorage: revisionStorage ? { ...revisionStorage, plans: storageOptions ?? { '50': revisionStorage } } : null
      }
    },
    markApplied(releaseDigest = config.digest ?? null) {
      const previousRevision = loadedRevision
      loadedRevision = refreshCurrentRevision().revision
      try {
        if (releaseDigest && revisionStore.linkRelease) {
          pendingManifest = revisionStore.linkRelease(loadedRevision, releaseDigest)
        }
        return this.status()
      } catch (error) {
        loadedRevision = previousRevision
        throw error
      }
    },
    revisions(options) {
      return revisionStore.list(options)
    },
    revisionStorage({ keep = 50 } = {}) {
      const pendingRevision = refreshCurrentRevision().revision
      return revisionStore.inventory?.({ keep, protectedRevisions: [loadedRevision, pendingRevision] }) ?? null
    },
    pruneRevisions({ keep = 50 } = {}) {
      const pendingRevision = refreshCurrentRevision().revision
      if (!revisionStore.prune) throw new ConfigMutationError('revision_prune_unavailable', 409, 'Configuration revision pruning is unavailable')
      return {
        ...revisionStore.prune({ keep, protectedRevisions: [loadedRevision, pendingRevision] }),
        revision: pendingRevision,
        restartRequired: pendingRevision !== loadedRevision
      }
    },
    revision(revision) {
      return revisionStore.read(revision).manifest
    },
    revisionDiff(revision) {
      const current = refreshCurrentRevision()
      const target = revisionStore.read(revision)
      return {
        from: current,
        to: target.manifest,
        diff: diffSnapshots(revisionStore.snapshotCurrent(), target.snapshot)
      }
    },
    prepareRollback(revision) {
      const parentManifest = refreshCurrentRevision()
      const currentSnapshot = revisionStore.snapshotCurrent()
      const target = revisionStore.read(revision)
      if (target.manifest.contentDigest === parentManifest.contentDigest) {
        return {
          changed: false,
          revision: parentManifest.revision,
          previousManifest: parentManifest,
          previousSnapshot: currentSnapshot,
          targetRevision: target.manifest.revision
        }
      }
      const diff = diffSnapshots(currentSnapshot, target.snapshot)
      let phase = 'write'
      let manifest
      try {
        writeCurrentSnapshot(target.snapshot)
        phase = 'validate'
        loadConfig(root, { allowEmptyEnabledChannels: true })
        phase = 'revision'
        manifest = revisionStore.create({
          parentRevision: parentManifest.revision,
          operation: 'runtime-rollback',
          affected: affectedFromDiff(diff),
          snapshot: target.snapshot
        })
      } catch (error) {
        restoreAfterFailure(currentSnapshot)
        throw mutationFailure(error, phase)
      }
      pendingManifest = manifest
      return {
        changed: true,
        revision: manifest.revision,
        previousManifest: parentManifest,
        previousSnapshot: currentSnapshot,
        targetRevision: target.manifest.revision
      }
    },
    restoreRollback(transaction) {
      if (!transaction?.changed) return
      writeCurrentSnapshot(transaction.previousSnapshot)
      loadConfig(root, { allowEmptyEnabledChannels: true })
      pendingManifest = transaction.previousManifest
    },
    routing() {
      const current = loadConfig(root, { allowEmptyEnabledChannels: true })
      return {
        channels: current.channels.map(channel => ({
          id: channel.id,
          name: channel.name,
          baseUrl: channel.upstream.toString(),
          enabled: channel.enabled,
          staged: channel.staged,
          runtimeEnabled: channel.runtimeEnabled,
          protocol: channel.protocol,
          priority: channel.priority ?? 0,
          modelCount: channel.models.length,
          hasApiKey: Boolean(channel.apiKey)
        })),
        stableAliases: current.stableAliases.map(item => item.logicalModel
          ? { alias: item.alias, logicalModel: item.logicalModel }
          : { alias: item.alias, channel: item.channel, model: item.model }),
        pinnedAliases: current.pinnedAliases.map(({ alias, channel, model, approvalRef }) => ({ alias, channel, model, approvalRef })),
        logicalModels: current.logicalModels.map(item => ({
          id: item.id,
          enabled: item.enabled,
          candidates: item.candidates.map(candidate => ({ ...candidate }))
        })),
        models: current.channels.flatMap(channel => (channel.models ?? []).map(model => {
          const kind = normalizeModelKind(model.kind, model.upstream)
          return {
            channel: channel.id,
            model: model.upstream,
            protocol: model.protocol ?? channel.protocol ?? 'openai-compatible',
            priority: model.priority ?? channel.priority ?? 0,
            staged: channel.staged === true,
            channelEnabled: channel.enabled,
            status: model.status ?? 'active',
            kind,
            streaming: normalizeStreamingMode(model.streaming),
            canaryEligible: model.canaryEligible ?? isGenerationModel({ kind })
          }
        }))
      }
    },
    access() {
      const snapshot = revisionStore.snapshotCurrent()
      const document = snapshot.clientsText === null ? null : JSON.parse(snapshot.clientsText)
      return publicClientAccess(document)
    },
    createClient(input = {}) {
      const generated = createClientKey()
      const result = mutate('client-create', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id))
        const id = normalizeClientId(input.id)
        const group = normalizeClientId(input.group)
        if (document.clients.some(item => item.id === id)) throw new ConfigMutationError('client_exists', 409, `Client already exists: ${id}`)
        if (!document.groups.some(item => item.id === group)) throw new ConfigMutationError('client_group_not_found', 404, `Unknown client group: ${group}`)
        document.clients.push({ id, group, keyHash: generated.keyHash, keyHint: generated.keyHint, enabled: input.enabled !== false })
        clients.value = document
        return { id, group, enabled: input.enabled !== false, key: generated.key }
      }, result => ({ clientIds: [result.id], groupIds: [result.group] }), { createClients: true })
      return result
    },
    rotateClient(idValue) {
      const generated = createClientKey()
      return mutate('client-rotate', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id))
        const id = normalizeClientId(idValue)
        const client = document.clients.find(item => item.id === id)
        if (!client) throw new ConfigMutationError('client_not_found', 404, `Unknown client: ${id}`)
        client.keyHash = generated.keyHash
        client.keyHint = generated.keyHint
        clients.value = document
        return { id, group: client.group, enabled: client.enabled !== false, key: generated.key }
      }, result => ({ clientIds: [result.id] }), { createClients: true })
    },
    updateClient(idValue, input = {}) {
      return mutate('client-update', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id))
        const id = normalizeClientId(idValue)
        const client = document.clients.find(item => item.id === id)
        if (!client) throw new ConfigMutationError('client_not_found', 404, `Unknown client: ${id}`)
        if (input.group !== undefined) {
          const group = normalizeClientId(input.group)
          if (!document.groups.some(item => item.id === group)) throw new ConfigMutationError('client_group_not_found', 404, `Unknown client group: ${group}`)
          client.group = group
        }
        if (input.enabled !== undefined) {
          if (typeof input.enabled !== 'boolean') throw new ConfigMutationError('invalid_client_enabled', 400, 'Client enabled must be a boolean')
          client.enabled = input.enabled
        }
        clients.value = document
        return { id, group: client.group, enabled: client.enabled !== false, keyHint: client.keyHint ?? null }
      }, result => ({ clientIds: [result.id], groupIds: [result.group] }), { createClients: true })
    },
    deleteClient(idValue) {
      return mutate('client-delete', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id))
        const id = normalizeClientId(idValue)
        const index = document.clients.findIndex(item => item.id === id)
        if (index < 0) throw new ConfigMutationError('client_not_found', 404, `Unknown client: ${id}`)
        const [deleted] = document.clients.splice(index, 1)
        clients.value = document
        return { id, group: deleted.group, deleted: true }
      }, result => ({ clientIds: [result.id], groupIds: [result.group] }), { createClients: true })
    },
    createClientGroup(input = {}) {
      return mutate('client-group-create', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id), { allowMissing: true })
        const id = normalizeClientId(input.id)
        if (document.groups.some(item => item.id === id)) throw new ConfigMutationError('client_group_exists', 409, `Client group already exists: ${id}`)
        const group = normalizeGroupInput(input, config.channels.map(channel => channel.id))
        if (group.id !== id) throw new ConfigMutationError('invalid_client_group_id', 400, 'Client group id does not match request')
        document.groups.push(group)
        clients.value = document
        return { ...group }
      }, result => ({ groupIds: [result.id], channelIds: result.channels }), { createClients: true })
    },
    updateClientGroup(idValue, input = {}) {
      return mutate('client-group-update', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id))
        const id = normalizeClientId(idValue)
        const group = document.groups.find(item => item.id === id)
        if (!group) throw new ConfigMutationError('client_group_not_found', 404, `Unknown client group: ${id}`)
        const next = normalizeGroupInput({ ...group, ...input, id }, config.channels.map(channel => channel.id))
        Object.assign(group, next)
        clients.value = document
        return { ...group }
      }, result => ({ groupIds: [result.id], channelIds: result.channels }), { createClients: true })
    },
    deleteClientGroup(idValue) {
      return mutate('client-group-delete', ({ clients }) => {
        const document = normalizeClientDocument(clients, config.channels.map(channel => channel.id))
        const id = normalizeClientId(idValue)
        if (document.clients.some(item => item.group === id)) throw new ConfigMutationError('client_group_has_clients', 409, 'Move clients before deleting the group')
        const index = document.groups.findIndex(item => item.id === id)
        if (index < 0) throw new ConfigMutationError('client_group_not_found', 404, `Unknown client group: ${id}`)
        document.groups.splice(index, 1)
        clients.value = document
        return { id, deleted: true }
      }, result => ({ groupIds: [result.id] }), { createClients: true })
    },
    migrateRoutesSchema() {
      return mutate('routes-schema-migrate', ({ routes }) => {
        const fromSchemaVersion = routes.schemaVersion
        const hadLogicalModels = Array.isArray(routes.logicalModels)
        routes.schemaVersion = 2
        routes.logicalModels ??= []
        return {
          changed: fromSchemaVersion !== 2 || !hadLogicalModels,
          fromSchemaVersion,
          toSchemaVersion: 2,
          logicalModelCount: routes.logicalModels.length
        }
      }, () => ({ logicalModelIds: [] }))
    },
    discoverChannels() {
      const env = parseEnv(fs.readFileSync(envPath, 'utf8'))
      const diskRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
      const diskIds = new Set((diskRoutes.channels ?? []).map(channel => String(channel.id).toLowerCase()))
      const runtimeIds = new Set(config.channels.map(channel => channel.id))
      const providers = fs.existsSync(providersPath) ? JSON.parse(fs.readFileSync(providersPath, 'utf8')) : null
      const grouped = providers
        ? (providers.providers ?? []).map(provider => ({
            id: String(provider.id).toLowerCase(),
            values: {
              NAME: provider.name,
              BASE_URL: provider.baseUrl,
              API_KEY: provider.apiKey,
              PROTOCOL: provider.protocol,
              ENABLED: String(provider.enabled)
            }
          }))
        : collectLegacyChannelEntries(env)
      const unregistered = []
      const pendingRestart = []
      for (const entry of grouped) {
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
      return mutate('channel-create', ({ routes, env, providers }) => {
        const id = normalizeChannelId(input.id)
        if ((routes.channels ?? []).some(channel => channel.id === id)) {
          throw new ConfigMutationError('channel_exists', 409, `Channel already exists: ${id}`)
        }
        const values = validateChannelInput(input, { requireApiKey: true })
        if (providers) {
          providers.providers ??= []
          providers.providers.push({ id, name: values.name, baseUrl: values.baseUrl, apiKey: values.apiKey, protocol: values.protocol, enabled: false, priority: values.priority })
        } else {
          const prefix = providerEnvPrefix(id)
          env[`${prefix}_NAME`] = values.name
          env[`${prefix}_BASE_URL`] = values.baseUrl
          env[`${prefix}_API_KEY`] = values.apiKey
          env[`${prefix}_PROTOCOL`] = values.protocol
          env[`${prefix}_ENABLED`] = 'false'
        }
        routes.channels ??= []
        routes.channels.push(providers ? { id, staged: true, models: [] } : { id, enabled: false, staged: true, priority: values.priority, models: [] })
        return { id, name: values.name, enabled: false, staged: true, protocol: values.protocol, priority: values.priority, modelCount: 0, hasApiKey: true }
      }, result => ({ channelIds: [result.id] }))
    },
    importChannel(idValue) {
      return mutate('channel-import', ({ routes, env, providers }) => {
        const id = normalizeChannelId(idValue)
        if ((routes.channels ?? []).some(channel => channel.id === id)) {
          throw new ConfigMutationError('channel_exists', 409, `Channel already exists: ${id}`)
        }
        const prefix = providerEnvPrefix(id)
        const provider = providers?.providers?.find(item => String(item.id).toLowerCase() === id)
        const values = validateChannelInput({
          name: providers ? provider?.name : env[`${prefix}_NAME`],
          baseUrl: providers ? provider?.baseUrl : env[`${prefix}_BASE_URL`],
          apiKey: providers ? provider?.apiKey : env[`${prefix}_API_KEY`],
          protocol: providers ? provider?.protocol : env[`${prefix}_PROTOCOL`] || 'openai-compatible',
          priority: providers ? provider?.priority ?? 0 : 0
        }, { requireApiKey: true })
        if (providers) {
          if (!provider) throw new ConfigMutationError('channel_not_found', 404, `Unknown provider: ${id}`)
          provider.enabled = false
        } else {
          env[`${prefix}_ENABLED`] = 'false'
        }
        routes.channels ??= []
        routes.channels.push(providers ? { id, staged: true, models: [] } : { id, enabled: false, staged: true, priority: values.priority, models: [] })
        return { id, name: values.name, enabled: false, staged: true, protocol: values.protocol, priority: values.priority, modelCount: 0, hasApiKey: true }
      }, result => ({ channelIds: [result.id] }))
    },
    updateChannel(idValue, input) {
      return mutate('channel-update', ({ routes, env, providers }) => {
        const id = normalizeChannelId(idValue)
        const channel = (routes.channels ?? []).find(item => item.id === id)
        if (!channel) throw new ConfigMutationError('channel_not_found', 404, `Unknown channel: ${id}`)
        const prefix = providerEnvPrefix(id)
        const provider = providers?.providers?.find(item => String(item.id).toLowerCase() === id)
        if (providers && !provider) throw new ConfigMutationError('channel_not_found', 404, `Unknown provider: ${id}`)
        const values = validateChannelInput(input, { partial: true, requireApiKey: false })
        if (values.name !== undefined) providers ? provider.name = values.name : env[`${prefix}_NAME`] = values.name
        if (values.baseUrl !== undefined) providers ? provider.baseUrl = values.baseUrl : env[`${prefix}_BASE_URL`] = values.baseUrl
        if (values.apiKey !== undefined) providers ? provider.apiKey = values.apiKey : env[`${prefix}_API_KEY`] = values.apiKey
        if (values.protocol !== undefined) providers ? provider.protocol = values.protocol : env[`${prefix}_PROTOCOL`] = values.protocol
        if (values.enabled !== undefined) {
          if (providers) provider.enabled = values.enabled
          else {
            channel.enabled = values.enabled
            env[`${prefix}_ENABLED`] = String(values.enabled)
          }
        }
        if (values.staged !== undefined) {
          channel.staged = values.staged
          if (values.staged) {
            if (providers) provider.enabled = false
            else {
              channel.enabled = false
              env[`${prefix}_ENABLED`] = 'false'
            }
          }
        }
        if (values.priority !== undefined) {
          if (providers) provider.priority = values.priority
          else channel.priority = values.priority
        }
        if (providers) {
          delete channel.enabled
          delete channel.priority
        }
        return {
          id,
          name: providers ? provider.name || id : env[`${prefix}_NAME`] || id,
          enabled: providers ? Boolean(provider.enabled) : Boolean(channel.enabled),
          staged: Boolean(channel.staged),
          protocol: providers ? provider.protocol || 'openai-compatible' : env[`${prefix}_PROTOCOL`] || 'openai-compatible',
          priority: providers ? provider.priority ?? 0 : channel.priority ?? 0,
          modelCount: (channel.models ?? []).length,
          hasApiKey: Boolean(providers ? provider.apiKey : env[`${prefix}_API_KEY`])
        }
      }, result => ({ channelIds: [result.id] }))
    },
    updateModelStatus(channelValue, modelValue, statusValue) {
      return mutate('model-update', ({ routes }) => {
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
          const logicalReferences = (routes.logicalModels ?? [])
            .filter(group => group.enabled !== false)
            .flatMap(group => (group.candidates ?? [])
              .filter(candidate => candidate.channel === channelId && candidate.model === modelId && candidate.enabled !== false)
              .map(() => group.id))
          references.push(...logicalReferences.map(id => `logical:${id}`))
          if (references.length) {
            throw new ConfigMutationError('model_has_aliases', 409, `Move aliases before disabling this model: ${references.join(', ')}`)
          }
        }
        model.status = status
        return { channel: channelId, model: modelId, status }
      }, result => ({ channelIds: [result.channel], modelIds: [`${result.channel}/${result.model}`] }))
    },
    setStableAlias(aliasValue, channelValue, modelValue) {
      return mutate('alias-update', ({ routes }) => {
        const alias = normalizeAlias(aliasValue)
        const target = channelValue && typeof channelValue === 'object'
          ? channelValue
          : { channel: channelValue, model: modelValue }
        if (target.logicalModel !== undefined) {
          const logicalModel = normalizeLogicalModelId(target.logicalModel)
          const group = (routes.logicalModels ?? []).find(item => item.id === logicalModel)
          if (!group) throw new ConfigMutationError('logical_model_not_found', 404, `Unknown logical model: ${logicalModel}`)
          if (group.enabled === false) throw new ConfigMutationError('logical_model_disabled', 409, 'A disabled logical model cannot receive a stable alias')
          routes.schemaVersion = 2
          routes.stableAliases ??= []
          const current = routes.stableAliases.find(item => item.alias === alias)
          if (!current) {
            const conflicts = [
              ...(routes.pinnedAliases ?? []).map(item => item.alias),
              ...(routes.channels ?? []).flatMap(item => (item.models ?? []).flatMap(entry => entry.aliases ?? [])),
              ...(routes.logicalModels ?? []).map(item => item.id)
            ]
            if (conflicts.includes(alias)) throw new ConfigMutationError('alias_conflict', 409, `Alias is already in use: ${alias}`)
            routes.stableAliases.push({ alias, logicalModel })
          } else {
            delete current.channel
            delete current.model
            current.logicalModel = logicalModel
          }
          return { alias, logicalModel }
        }
        const channelId = normalizeChannelId(target.channel)
        const modelId = normalizeModelId(target.model)
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
            ...(routes.channels ?? []).flatMap(item => (item.models ?? []).flatMap(entry => entry.aliases ?? [])),
            ...(routes.logicalModels ?? []).map(item => item.id)
          ]
          if (conflicts.includes(alias)) throw new ConfigMutationError('alias_conflict', 409, `Alias is already in use: ${alias}`)
          routes.stableAliases.push({ alias, channel: channelId, model: modelId })
        } else {
          delete current.logicalModel
          current.channel = channelId
          current.model = modelId
        }
        return { alias, channel: channelId, model: modelId }
      }, result => result.logicalModel
        ? { logicalModelIds: [result.logicalModel] }
        : { channelIds: [result.channel], modelIds: [`${result.channel}/${result.model}`] })
    },
    createLogicalModel(input) {
      return mutate('logical-model-create', ({ routes }) => {
        const id = normalizeLogicalModelId(input?.id)
        if ((routes.logicalModels ?? []).some(item => item.id === id)) {
          throw new ConfigMutationError('logical_model_exists', 409, `Logical model already exists: ${id}`)
        }
        routes.schemaVersion = 2
        routes.logicalModels ??= []
        const group = normalizeLogicalModelMutation(routes, { ...input, id }, { requireCandidates: true })
        routes.logicalModels.push(group)
        return { ...group }
      }, result => ({ logicalModelIds: [result.id], modelIds: result.candidates.map(candidate => `${candidate.channel}/${candidate.model}`) }))
    },
    updateLogicalModel(idValue, input) {
      return mutate('logical-model-update', ({ routes }) => {
        const id = normalizeLogicalModelId(idValue)
        const group = (routes.logicalModels ?? []).find(item => item.id === id)
        if (!group) throw new ConfigMutationError('logical_model_not_found', 404, `Unknown logical model: ${id}`)
        routes.schemaVersion = 2
        const patch = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
        if (patch.enabled !== undefined) {
          if (typeof patch.enabled !== 'boolean') throw new ConfigMutationError('invalid_logical_model_enabled', 400, 'Logical model enabled must be a boolean')
          group.enabled = patch.enabled
        }
        if (patch.candidates !== undefined) {
          const next = normalizeLogicalModelMutation(routes, { id, enabled: group.enabled, candidates: patch.candidates }, { requireCandidates: true })
          group.candidates = next.candidates
        }
        if (group.enabled !== false && !(group.candidates ?? []).some(candidate => candidate.enabled !== false)) {
          throw new ConfigMutationError('logical_model_empty', 400, 'An enabled logical model must have an enabled candidate')
        }
        return { ...group, candidates: group.candidates.map(candidate => ({ ...candidate })) }
      }, result => ({ logicalModelIds: [result.id], modelIds: result.candidates.map(candidate => `${candidate.channel}/${candidate.model}`) }))
    },
    deleteLogicalModel(idValue) {
      return mutate('logical-model-delete', ({ routes }) => {
        const id = normalizeLogicalModelId(idValue)
        const index = (routes.logicalModels ?? []).findIndex(item => item.id === id)
        if (index < 0) throw new ConfigMutationError('logical_model_not_found', 404, `Unknown logical model: ${id}`)
        if ([...(routes.stableAliases ?? []), ...(routes.pinnedAliases ?? [])].some(route => route.logicalModel === id)) {
          throw new ConfigMutationError('logical_model_has_aliases', 409, 'Move stable aliases before deleting the logical model')
        }
        const [deleted] = routes.logicalModels.splice(index, 1)
        return { id, deleted: true, candidates: deleted.candidates ?? [] }
      }, result => ({ logicalModelIds: [result.id], modelIds: result.candidates.map(candidate => `${candidate.channel}/${candidate.model}`) }))
    },
    deleteChannel(idValue) {
      return mutate('channel-delete', ({ routes, env, providers }) => {
        const id = normalizeChannelId(idValue)
        const index = (routes.channels ?? []).findIndex(item => item.id === id)
        if (index < 0) throw new ConfigMutationError('channel_not_found', 404, `Unknown channel: ${id}`)
        const channel = routes.channels[index]
        const prefix = providerEnvPrefix(id)
        const provider = providers?.providers?.find(item => String(item.id).toLowerCase() === id)
        const enabledBySource = providers ? provider?.enabled === true : !/^(false|0)$/i.test(env[`${prefix}_ENABLED`] ?? 'true')
        if ((channel.enabled !== false && enabledBySource) || channel.staged === true) {
          throw new ConfigMutationError('channel_must_be_disabled', 409, 'Disable the channel before deleting it')
        }
        if ([...(routes.stableAliases ?? []), ...(routes.pinnedAliases ?? [])].some(route => route.channel === id)) {
          throw new ConfigMutationError('channel_has_aliases', 409, 'Move stable and pinned aliases before deleting the channel')
        }
        if ((routes.logicalModels ?? []).some(group => (group.candidates ?? []).some(candidate => candidate.channel === id))) {
          throw new ConfigMutationError('channel_has_logical_models', 409, 'Remove logical model candidates before deleting the channel')
        }
        routes.channels.splice(index, 1)
        if (providers) providers.providers = providers.providers.filter(item => String(item.id).toLowerCase() !== id)
        else for (const key of Object.keys(env)) if (key.startsWith(`${prefix}_`)) delete env[key]
        return { id, deleted: true }
      }, result => ({ channelIds: [result.id] }))
    },
    async syncModels(requestedIds = []) {
      if (modelSyncActive) throw new ConfigMutationError('model_sync_in_progress', 409, 'A model synchronization is already in progress')
      modelSyncActive = true
      try {
        const parentManifest = refreshCurrentRevision()
        const originalSnapshot = revisionStore.snapshotCurrent()
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
        const nextRoutes = JSON.stringify(routes, null, 2) + '\n'
        const nextSnapshot = { ...originalSnapshot, routesText: nextRoutes }
        if (digestSnapshot(nextSnapshot) === parentManifest.contentDigest) {
          return {
            changed: false,
            channels: summaries,
            revision: parentManifest.revision,
            restartRequired: parentManifest.revision !== loadedRevision
          }
        }
        let manifest
        let phase = 'write'
        try {
          writeCurrentSnapshot(nextSnapshot)
          phase = 'validate'
          loadConfig(root, { allowEmptyEnabledChannels: true })
          phase = 'revision'
          manifest = revisionStore.create({
            parentRevision: parentManifest.revision,
            operation: 'model-sync',
            affected: {
              channelIds: selected.map(channel => channel.id),
              modelIds: changedModelIds(current.routes, routes, selected.map(channel => channel.id))
            },
            snapshot: nextSnapshot
          })
        } catch (error) {
          restoreAfterFailure(originalSnapshot)
          throw mutationFailure(error, phase)
        }
        pendingManifest = manifest
        return {
          changed: true,
          channels: summaries,
          revision: manifest.revision,
          restartRequired: manifest.revision !== loadedRevision
        }
      } finally {
        modelSyncActive = false
      }
    },
    applyCanaryAudit(report, { stableAliases = {} } = {}) {
      if (!report || !Array.isArray(report.results)) throw new ConfigMutationError('invalid_canary_audit', 400, 'Canary audit results are required')
      return mutate('canary-audit', ({ routes, env, providers }) => {
        const byChannel = new Map()
        for (const item of report.results) {
          const channelId = normalizeChannelId(item.channel)
          const modelId = normalizeModelId(item.model)
          const channel = (routes.channels ?? []).find(entry => entry.id === channelId)
          const model = channel?.models?.find(entry => entry.upstream === modelId)
          if (!channel || !model) continue
          const entry = { ...item, channelId, modelId, ok: item.ok === true }
          const values = byChannel.get(channelId) ?? []
          values.push(entry)
          byChannel.set(channelId, values)
        }
        const changedModels = []
        const changedChannels = []
        for (const [channelId, entries] of byChannel) {
          const channel = (routes.channels ?? []).find(item => item.id === channelId)
          if (!channel) continue
          const successful = entries.filter(item => item.ok)
          const hasSuccess = successful.length > 0
          const definiteFailures = entries.filter(item => !item.ok && item.error !== 'timeout' && item.error !== 'transport_error')
          const failedModels = hasSuccess ? entries.filter(item => !item.ok) : definiteFailures
          for (const item of failedModels) {
            const model = channel.models.find(entry => entry.upstream === item.modelId)
            if (model && model.status !== 'disabled') {
              model.status = 'disabled'
              changedModels.push(`${channelId}/${item.modelId}`)
            }
          }
          const shouldProduce = hasSuccess
          const shouldDisableChannel = !hasSuccess
          if (shouldProduce) {
            if (channel.staged !== false || channel.enabled === false) changedChannels.push(channelId)
            channel.staged = false
            if (providers) {
              const provider = providers.providers?.find(item => String(item.id).toLowerCase() === channelId)
              if (provider) provider.enabled = true
              delete channel.enabled
            } else {
              channel.enabled = true
              env[`${providerEnvPrefix(channelId)}_ENABLED`] = 'true'
            }
          } else if (shouldDisableChannel) {
            if (channel.enabled !== false || channel.staged) changedChannels.push(channelId)
            channel.staged = false
            channel.enabled = false
            if (providers) {
              const provider = providers.providers?.find(item => String(item.id).toLowerCase() === channelId)
              if (provider) provider.enabled = false
              delete channel.enabled
            } else {
              env[`${providerEnvPrefix(channelId)}_ENABLED`] = 'false'
            }
          }
        }
        const aliasResults = []
        for (const [alias, targetValue] of Object.entries(stableAliases)) {
          const target = targetValue && typeof targetValue === 'object' ? targetValue : {}
          const channelId = normalizeChannelId(target.channel)
          const modelId = normalizeModelId(target.model)
          const channel = (routes.channels ?? []).find(item => item.id === channelId)
          const model = channel?.models?.find(item => item.upstream === modelId)
          const result = byChannel.get(channelId)?.find(item => item.modelId === modelId && item.ok)
          if (!channel || !model || !result) throw new ConfigMutationError('canary_alias_target_unverified', 409, `Stable alias target was not verified: ${channelId}/${modelId}`)
          if (model.status === 'disabled') model.status = 'active'
          routes.stableAliases ??= []
          const current = routes.stableAliases.find(item => item.alias === alias)
          if (current) {
            delete current.logicalModel
            current.channel = channelId
            current.model = modelId
          } else {
            routes.stableAliases.push({ alias, channel: channelId, model: modelId })
          }
          aliasResults.push({ alias, channel: channelId, model: modelId })
        }
        return {
          tested: report.results.length,
          successful: report.results.filter(item => item.ok).length,
          changedChannels: [...new Set(changedChannels)].sort(),
          disabledModels: [...new Set(changedModels)].sort(),
          aliases: aliasResults
        }
      }, result => ({
        channelIds: result.changedChannels,
        modelIds: result.disabledModels
      }))
    }
  }

  function mutate(operation, change, affected, { createClients = false } = {}) {
    if (modelSyncActive) throw new ConfigMutationError('model_sync_in_progress', 409, 'Configuration changes are paused while model synchronization is in progress')
    const parentManifest = refreshCurrentRevision()
    const originalSnapshot = revisionStore.snapshotCurrent()
    const providerMode = originalSnapshot.providersText !== null
    const env = parseEnv(originalSnapshot.envText)
    const routes = JSON.parse(originalSnapshot.routesText)
    const providers = providerMode ? JSON.parse(originalSnapshot.providersText) : null
    const clientState = {
      value: originalSnapshot.clientsText === null
        ? { schemaVersion: 1, groups: [], clients: [] }
        : JSON.parse(originalSnapshot.clientsText),
      existed: originalSnapshot.clientsText !== null
    }
    const result = change({ routes, env, providers, clients: clientState })
    const nextEnv = serializeEnv(providerMode ? stripLegacyChannelEnv(env) : env)
    const nextRoutes = JSON.stringify(routes, null, 2) + '\n'
    const nextProviders = providerMode ? JSON.stringify(providers, null, 2) + '\n' : null
    const nextClients = clientState.existed || createClients ? JSON.stringify(clientState.value, null, 2) + '\n' : null
    const nextSnapshot = { envText: nextEnv, routesText: nextRoutes, providersText: nextProviders, clientsText: nextClients }
    if (digestSnapshot(nextSnapshot) === parentManifest.contentDigest) {
      return { ...result, revision: parentManifest.revision, restartRequired: parentManifest.revision !== loadedRevision }
    }
    let manifest
    let phase = 'write'
    try {
      writeCurrentSnapshot(nextSnapshot)
      phase = 'validate'
      loadConfig(root)
      phase = 'revision'
      manifest = revisionStore.create({
        parentRevision: parentManifest.revision,
        operation,
        affected: affected(result),
        snapshot: nextSnapshot
      })
    } catch (error) {
      restoreAfterFailure(originalSnapshot)
      throw mutationFailure(error, phase)
    }
    pendingManifest = manifest
    return { ...result, revision: manifest.revision, restartRequired: manifest.revision !== loadedRevision }
  }

  function initialRevision() {
    const snapshot = revisionStore.snapshotCurrent()
    const existing = revisionStore.findByDigest(digestSnapshot(snapshot))
    const manifest = existing ?? revisionStore.create({ operation: 'startup-baseline', snapshot })
    if (config.digest && revisionStore.linkRelease) return revisionStore.linkRelease(manifest.revision, config.digest)
    return manifest
  }

  function refreshCurrentRevision() {
    const snapshot = revisionStore.snapshotCurrent()
    const contentDigest = digestSnapshot(snapshot)
    if (contentDigest === pendingManifest.contentDigest) return pendingManifest
    loadConfig(root, { allowEmptyEnabledChannels: true })
    pendingManifest = revisionStore.create({
      parentRevision: pendingManifest.revision,
      operation: 'external-change',
      snapshot
    })
    return pendingManifest
  }

  function writeCurrentSnapshot(snapshot) {
    if (snapshot.providersText === null) {
      if (fs.existsSync(providersPath)) fs.rmSync(providersPath)
    } else {
      atomicWrite(providersPath, snapshot.providersText)
    }
    if (snapshot.clientsText === null) {
      if (fs.existsSync(clientsPath)) fs.rmSync(clientsPath)
    } else {
      atomicWrite(clientsPath, snapshot.clientsText)
    }
    atomicWrite(envPath, snapshot.envText)
    atomicWrite(routesPath, snapshot.routesText)
  }

  function restoreAfterFailure(snapshot) {
    try {
      writeCurrentSnapshot(snapshot)
    } catch {
      throw new ConfigMutationError('configuration_restore_failed', 500, 'Private configuration could not be restored')
    }
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

function normalizeClientId(value) {
  const id = String(value ?? '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new ConfigMutationError('invalid_client_id', 400, 'Client id must match [a-z][a-z0-9-]{0,63}')
  return id
}

function normalizeClientDocument(state, channelIds, { allowMissing = false } = {}) {
  const value = state?.value ?? state
  if (allowMissing && value === null) return { schemaVersion: 1, groups: [], clients: [] }
  try {
    return normalizeClientAccess(value ?? { schemaVersion: 1, groups: [], clients: [] }, channelIds)
  } catch (error) {
    throw new ConfigMutationError('invalid_client_access', 400, error instanceof Error ? error.message : 'Client access configuration is invalid')
  }
}

function normalizeGroupInput(input, channelIds) {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ConfigMutationError('invalid_client_group', 400, 'Client group body must be an object')
  const id = normalizeClientId(input.id)
  if (!Array.isArray(input.channels) || !input.channels.length) throw new ConfigMutationError('invalid_client_group_channels', 400, 'Client group must contain at least one channel')
  const known = new Set(channelIds.map(value => String(value).toLowerCase()))
  const channels = [...new Set(input.channels.map(value => String(value).trim().toLowerCase()))]
  if (channels.some(channel => !/^[a-z][a-z0-9-]{0,31}$/.test(channel) || (known.size && !known.has(channel)))) {
    throw new ConfigMutationError('unknown_client_group_channel', 404, 'Client group references an unknown channel')
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new ConfigMutationError('invalid_client_group_enabled', 400, 'Client group enabled must be a boolean')
  return { id, channels, enabled: input.enabled !== false }
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

function normalizeLogicalModelId(value) {
  const id = String(value ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,254}$/.test(id)) {
    throw new ConfigMutationError('invalid_logical_model_id', 400, 'Logical model id is invalid')
  }
  return id
}

function normalizeLogicalModelMutation(routes, input, { requireCandidates = false } = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new ConfigMutationError('invalid_logical_model', 400, 'Logical model body must be an object')
  }
  const id = normalizeLogicalModelId(input.id)
  const enabled = input.enabled === undefined ? true : input.enabled
  if (typeof enabled !== 'boolean') throw new ConfigMutationError('invalid_logical_model_enabled', 400, 'Logical model enabled must be a boolean')
  if (requireCandidates && !Array.isArray(input.candidates)) {
    throw new ConfigMutationError('invalid_logical_candidates', 400, 'Logical model candidates must be an array')
  }
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const seen = new Set()
  const normalized = []
  for (const candidateValue of candidates) {
    if (!candidateValue || Array.isArray(candidateValue) || typeof candidateValue !== 'object') {
      throw new ConfigMutationError('invalid_logical_candidate', 400, 'Logical model candidates must be objects')
    }
    const channel = normalizeChannelId(candidateValue.channel)
    const model = normalizeModelId(candidateValue.model)
    const key = `${channel}\0${model}`
    if (seen.has(key)) throw new ConfigMutationError('duplicate_logical_candidate', 409, `Duplicate logical candidate: ${channel}/${model}`)
    seen.add(key)
    const routeChannel = (routes.channels ?? []).find(item => item.id === channel)
    if (!routeChannel) throw new ConfigMutationError('logical_candidate_not_found', 404, `Unknown channel: ${channel}`)
    const routeModel = (routeChannel.models ?? []).find(item => item.upstream === model)
    if (!routeModel) throw new ConfigMutationError('logical_candidate_not_found', 404, `Unknown model: ${channel}/${model}`)
    if (!isGenerationModel({ kind: normalizeModelKind(routeModel.kind, routeModel.upstream) })) {
      throw new ConfigMutationError('logical_candidate_not_generation', 409, `Logical candidates must be generation models: ${channel}/${model}`)
    }
    const candidateEnabled = candidateValue.enabled === undefined ? true : candidateValue.enabled
    if (typeof candidateEnabled !== 'boolean') throw new ConfigMutationError('invalid_logical_candidate_enabled', 400, 'Logical candidate enabled must be a boolean')
    if (candidateEnabled && routeModel.status === 'disabled') throw new ConfigMutationError('logical_candidate_disabled', 409, `Disabled model cannot be an enabled logical candidate: ${channel}/${model}`)
    const priority = candidateValue.priority === undefined ? routeModel.priority ?? routeChannel.priority ?? 0 : candidateValue.priority
    if (!Number.isSafeInteger(priority)) throw new ConfigMutationError('invalid_logical_candidate_priority', 400, 'Logical candidate priority must be an integer')
    normalized.push({ channel, model, enabled: candidateEnabled, priority })
  }
  if (enabled && !normalized.some(candidate => candidate.enabled)) {
    throw new ConfigMutationError('logical_model_empty', 400, `Enabled logical model must have an enabled candidate: ${id}`)
  }
  return { id, enabled, candidates: normalized }
}

function changedModelIds(beforeRoutes, afterRoutes, channelIds) {
  const changed = []
  for (const channelId of channelIds) {
    const before = modelsByUpstream(beforeRoutes, channelId)
    const after = modelsByUpstream(afterRoutes, channelId)
    for (const modelId of new Set([...before.keys(), ...after.keys()])) {
      if (JSON.stringify(before.get(modelId) ?? null) !== JSON.stringify(after.get(modelId) ?? null)) {
        changed.push(`${channelId}/${modelId}`)
      }
    }
  }
  return changed.sort((left, right) => left.localeCompare(right))
}

function affectedFromDiff(diff) {
  return {
    channelIds: [
      ...(diff.channels?.added ?? []),
      ...(diff.channels?.removed ?? []),
      ...(diff.channels?.changed ?? []).map(item => item.id)
    ],
    modelIds: [
      ...(diff.models?.added ?? []),
      ...(diff.models?.removed ?? []),
      ...(diff.models?.changed ?? []).map(item => item.id)
    ],
    logicalModelIds: [
      ...(diff.logicalModels?.added ?? []),
      ...(diff.logicalModels?.removed ?? []),
      ...(diff.logicalModels?.changed ?? []).map(item => item.id)
    ],
    clientIds: [
      ...(diff.clients?.clients?.added ?? []),
      ...(diff.clients?.clients?.removed ?? []),
      ...(diff.clients?.clients?.changed ?? []).map(item => item.id)
    ],
    groupIds: [
      ...(diff.clients?.groups?.added ?? []),
      ...(diff.clients?.groups?.removed ?? []),
      ...(diff.clients?.groups?.changed ?? []).map(item => item.id)
    ]
  }
}

function modelsByUpstream(routes, channelId) {
  const channel = (routes.channels ?? []).find(item => item.id === channelId)
  const models = new Map()
  for (const model of channel?.models ?? []) {
    const entries = models.get(model.upstream) ?? []
    entries.push(model)
    models.set(model.upstream, entries)
  }
  return models
}

function mutationFailure(error, phase) {
  if (error instanceof ConfigMutationError) return error
  if (phase === 'validate') {
    return new ConfigMutationError('configuration_validation_failed', 400, 'Configuration validation failed')
  }
  if (phase === 'revision') {
    return new ConfigMutationError('configuration_revision_failed', 500, 'Configuration revision could not be written')
  }
  return new ConfigMutationError('configuration_write_failed', 500, 'Private configuration could not be written')
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}
