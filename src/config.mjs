import fs from 'node:fs'
import path from 'node:path'
import { readEnvFile } from './env.mjs'
import { MODEL_KINDS, STREAMING_MODES, isGenerationModel, normalizeModelKind, normalizeStreamingMode } from './model-metadata.mjs'
import { isChannelEnvKey } from './providers.mjs'

const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/
const MODEL_NAME = /^[^\s/][^\r\n]{0,254}$/
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,254}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

export function loadConfig(root, { allowExamples = false, allowEmptyEnabledChannels = false } = {}) {
  const gateway = readJson(path.join(root, 'config', 'gateway.json'))
  const routesPath = chooseLocal(root, 'routes.local.json', 'routes.example.json', allowExamples)
  const envPath = chooseLocal(root, 'channels.local.env', 'channels.example.env', allowExamples)
  const providersPath = chooseOptionalLocal(root, 'providers.local.json')
  const routes = readJson(routesPath)
  const env = readEnvFile(envPath)
  const providers = providersPath ? readJson(providersPath) : null
  return validateAndNormalize({ gateway, routes, env, providers, paths: { routesPath, envPath, providersPath }, allowEmptyEnabledChannels })
}

function chooseLocal(root, localName, exampleName, allowExamples) {
  const localPath = path.join(root, 'config', localName)
  if (fs.existsSync(localPath)) return localPath
  if (allowExamples) return path.join(root, 'config', exampleName)
  throw new Error(`Missing private configuration: config/${localName}`)
}

function chooseOptionalLocal(root, localName) {
  const localPath = path.join(root, 'config', localName)
  return fs.existsSync(localPath) ? localPath : null
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

export function validateAndNormalize({ gateway, routes, env, providers = null, paths = {}, allowEmptyEnabledChannels = false }) {
  const errors = []
  if (gateway.schemaVersion !== 1) errors.push('gateway.json schemaVersion must be 1')
  if (routes.schemaVersion !== 1) errors.push('routes schemaVersion must be 1')
  const providerMode = providers !== null
  const providersById = providerMode ? normalizeProviders(providers, errors) : new Map()
  if (providerMode && Object.keys(env).some(isChannelEnvKey)) errors.push('providers.local.json cannot coexist with CHANNEL_* entries in channels.local.env')
  const gatewayKey = requireSecret(env, 'GATEWAY_API_KEY', errors, 32)
  const managementKey = env.CPA_MANAGEMENT_KEY?.trim() ?? ''
  if (managementKey && managementKey.length < 32) errors.push('CPA_MANAGEMENT_KEY must contain at least 32 characters when admin access is enabled')
  const tunnelSettings = gateway.cloudflareTunnel ?? {}
  const tunnelEnabledEnv = String(tunnelSettings.enabledEnv ?? '')
  const tunnelCredentialEnv = String(tunnelSettings.tokenEnv ?? '')
  const tunnelEnabled = parseBoolean(env[tunnelEnabledEnv] ?? 'false', tunnelEnabledEnv || 'cloudflareTunnel.enabledEnv', errors)
  const tunnelCredential = tunnelEnabled
    ? requireSecret(env, tunnelCredentialEnv, errors, 32)
    : env[tunnelCredentialEnv]?.trim() ?? ''
  const seenChannels = new Set()
  const seenAliases = new Set()
  const channelById = new Map()
  const channels = []

  for (const [index, routeChannel] of (routes.channels ?? []).entries()) {
    const id = String(routeChannel.id ?? '').toLowerCase()
    if (!CHANNEL_ID.test(id)) errors.push(`channels[${index}].id is invalid`)
    if (seenChannels.has(id)) errors.push(`Duplicate channel id: ${id}`)
    seenChannels.add(id)
    const provider = providerMode ? providersById.get(id) : null
    if (providerMode && !provider) errors.push(`channels[${index}] references unknown provider ${id}`)
    const envPrefix = `CHANNEL_${id.toUpperCase().replaceAll('-', '_')}`
    const baseUrlText = providerMode ? String(provider?.baseUrl ?? '').trim() : env[`${envPrefix}_BASE_URL`]?.trim() ?? ''
    let upstream
    try {
      upstream = new URL(baseUrlText)
      if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('unsupported scheme')
      if (upstream.username || upstream.password || upstream.hash || upstream.search) throw new Error('credentials/query/fragment are forbidden')
    } catch {
      errors.push(`${envPrefix}_BASE_URL must be a clean http(s) URL`)
    }
    const secret = providerMode
      ? requireProviderSecret(provider, id, errors, 8)
      : requireSecret(env, `${envPrefix}_API_KEY`, errors, 8)
    const protocol = String(providerMode ? provider?.protocol ?? '' : env[`${envPrefix}_PROTOCOL`] || 'openai-compatible').trim()
    if (!['openai-compatible', 'responses', 'claude'].includes(protocol)) errors.push(`${envPrefix}_PROTOCOL is not supported: ${protocol}`)
    const enabledByEnv = providerMode
      ? Boolean(provider?.enabled)
      : parseBoolean(env[`${envPrefix}_ENABLED`] ?? 'true', `${envPrefix}_ENABLED`, errors)
    const staged = routeChannel.staged ?? false
    if (typeof staged !== 'boolean') errors.push(`${id}.staged must be boolean`)
    if (!providerMode && staged && routeChannel.enabled === true) errors.push(`${id} cannot be both enabled and staged`)
    const channelPriority = optionalInteger(providerMode ? provider?.priority : routeChannel.priority, `${id}.priority`, errors) ?? 0
    const models = []
    for (const [modelIndex, model] of (routeChannel.models ?? []).entries()) {
      const upstreamModel = String(model.upstream ?? '').trim()
      if (!MODEL_NAME.test(upstreamModel)) errors.push(`${id}.models[${modelIndex}].upstream is invalid`)
      const modelProtocol = String(model.protocol ?? protocol).trim()
      if (!['openai-compatible', 'responses', 'claude'].includes(modelProtocol)) errors.push(`${id}.models[${modelIndex}].protocol is not supported: ${modelProtocol}`)
      const aliases = [...new Set((model.aliases ?? []).map(value => String(value).trim()))]
      if (!aliases.length) aliases.push(`${id}/${upstreamModel}`)
      else if (!aliases.includes(`${id}/${upstreamModel}`)) aliases.push(`${id}/${upstreamModel}`)
      for (const alias of aliases) validateAlias(alias, `${id}.models[${modelIndex}]`, seenAliases, errors)
      const status = model.status ?? 'active'
      if (!['active', 'stale', 'disabled'].includes(status)) errors.push(`${id}.models[${modelIndex}].status is not supported: ${status}`)
      const kind = normalizeModelKind(model.kind, upstreamModel)
      if (model.kind !== undefined && !MODEL_KINDS.has(String(model.kind).trim().toLowerCase())) errors.push(`${id}.models[${modelIndex}].kind is not supported: ${model.kind}`)
      const streaming = normalizeStreamingMode(model.streaming)
      if (model.streaming !== undefined && !STREAMING_MODES.has(String(model.streaming).trim().toLowerCase())) errors.push(`${id}.models[${modelIndex}].streaming is not supported: ${model.streaming}`)
      const canaryEligible = model.canaryEligible === undefined ? isGenerationModel({ kind, canaryEligible: true }) : model.canaryEligible
      if (typeof canaryEligible !== 'boolean') errors.push(`${id}.models[${modelIndex}].canaryEligible must be boolean`)
      models.push({
        upstream: upstreamModel,
        protocol: modelProtocol,
        aliases,
        priority: optionalInteger(model.priority, `${id}.${upstreamModel}.priority`, errors) ?? channelPriority,
        displayName: model.displayName ? String(model.displayName) : undefined,
        maxContextLength: optionalPositiveInteger(model.maxContextLength, `${id}.${upstreamModel}.maxContextLength`, errors),
        inputModalities: normalizeModalities(model.inputModalities, ['text']),
        outputModalities: normalizeModalities(model.outputModalities, ['text']),
        thinkingLevels: normalizeThinking(model.thinkingLevels),
        kind,
        streaming,
        canaryEligible,
        status
      })
    }
    const enabled = (providerMode || Boolean(routeChannel.enabled ?? true)) && enabledByEnv && !staged
    if (enabled && models.length === 0 && !allowEmptyEnabledChannels) errors.push(`Enabled channel ${id} has no models`)
    const channel = {
      id,
      name: String(providerMode ? provider?.name ?? '' : env[`${envPrefix}_NAME`] ?? '').trim() || id,
      enabled,
      staged: Boolean(staged),
      runtimeEnabled: (enabled || Boolean(staged)),
      upstream,
      apiKey: secret,
      protocol,
      priority: channelPriority,
      models
    }
    channels.push(channel)
    channelById.set(id, channel)
  }

  const stableAliases = normalizeAliasRoutes(routes.stableAliases, 'stableAliases', false)
  const pinnedAliases = normalizeAliasRoutes(routes.pinnedAliases, 'pinnedAliases', true)

  function normalizeAliasRoutes(entries = [], field, pinned) {
    return entries.map((entry, index) => {
      const alias = String(entry.alias ?? '').trim()
      validateAlias(alias, `${field}[${index}]`, seenAliases, errors)
      const channelId = String(entry.channel ?? '').trim().toLowerCase()
      const model = String(entry.model ?? '').trim()
      const channel = channelById.get(channelId)
      if (!channel) errors.push(`${field}[${index}] references unknown channel ${channelId}`)
      else {
        const target = channel.models.find(item => item.upstream === model)
        if (!target) errors.push(`${field}[${index}] references unknown model ${channelId}/${model}`)
        else if (!isGenerationModel(target)) errors.push(`${field}[${index}] must reference a generation model: ${channelId}/${model}`)
      }
      const approvalRef = String(entry.approvalRef ?? '').trim()
      if (pinned && !approvalRef) errors.push(`${field}[${index}] requires approvalRef`)
      return { alias, channel: channelId, model, approvalRef: pinned ? approvalRef : undefined }
    })
  }

  validateGateway(gateway, errors)
  if (errors.length) throw new Error(`Configuration validation failed:\n- ${errors.join('\n- ')}`)
  return {
    gateway,
    routes,
    env,
    paths,
    providerMode,
    providers,
    gatewayKey,
    managementKey,
    channels,
    stableAliases,
    pinnedAliases,
    cloudflareTunnel: {
      enabled: tunnelEnabled,
      credential: tunnelCredential,
      metricsHost: tunnelSettings.metricsHost,
      metricsPort: tunnelSettings.metricsPort,
      readyTimeoutMs: tunnelSettings.readyTimeoutSeconds * 1000
    }
  }
}

function normalizeProviders(document, errors) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    errors.push('providers.local.json must contain an object')
    return new Map()
  }
  if (document.schemaVersion !== 1) errors.push('providers.local.json schemaVersion must be 1')
  if (!Array.isArray(document.providers)) {
    errors.push('providers.local.json providers must be an array')
    return new Map()
  }
  const result = new Map()
  for (const [index, providerValue] of document.providers.entries()) {
    const provider = providerValue && typeof providerValue === 'object' && !Array.isArray(providerValue) ? providerValue : {}
    const id = String(provider.id ?? '').trim().toLowerCase()
    if (!CHANNEL_ID.test(id)) errors.push(`providers[${index}].id is invalid`)
    if (result.has(id)) errors.push(`Duplicate provider id: ${id}`)
    if (id) result.set(id, { ...provider, id })
    if (typeof provider.name !== 'string' || !provider.name.trim() || provider.name.length > 80) errors.push(`providers[${index}].name is invalid`)
    if (typeof provider.baseUrl !== 'string') errors.push(`providers[${index}].baseUrl must be a string`)
    if (typeof provider.apiKey !== 'string') errors.push(`providers[${index}].apiKey must be a string`)
    if (typeof provider.protocol !== 'string') errors.push(`providers[${index}].protocol must be a string`)
    if (typeof provider.enabled !== 'boolean') errors.push(`providers[${index}].enabled must be boolean`)
    if (provider.priority !== undefined && !Number.isSafeInteger(provider.priority)) errors.push(`providers[${index}].priority must be an integer`)
  }
  return result
}

function requireProviderSecret(provider, id, errors, minLength) {
  const value = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : ''
  if (!value || value.includes('replace-me') || value.includes('replace-with')) errors.push(`providers.${id}.apiKey is missing or still an example`)
  else if (value.length < minLength) errors.push(`providers.${id}.apiKey must contain at least ${minLength} characters`)
  return value
}

function requireSecret(env, key, errors, minLength) {
  const value = env[key]?.trim() ?? ''
  if (!value || value.includes('replace-me') || value.includes('replace-with')) errors.push(`${key} is missing or still an example`)
  else if (value.length < minLength) errors.push(`${key} must contain at least ${minLength} characters`)
  return value
}

function parseBoolean(value, field, errors) {
  if (/^(true|1)$/i.test(value)) return true
  if (/^(false|0)$/i.test(value)) return false
  errors.push(`${field} must be true/false or 1/0`)
  return false
}

function validateAlias(alias, field, seen, errors) {
  if (!ALIAS.test(alias)) errors.push(`${field} alias is invalid: ${alias}`)
  if (seen.has(alias)) errors.push(`Duplicate client alias: ${alias}`)
  seen.add(alias)
}

function optionalPositiveInteger(value, field, errors) {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${field} must be a positive integer`)
  return value
}

function optionalInteger(value, field, errors) {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value)) errors.push(`${field} must be an integer`)
  return value
}

function normalizeModalities(values, fallback) {
  if (!Array.isArray(values) || values.length === 0) return fallback
  return [...new Set(values.map(value => String(value).trim().toLowerCase()).filter(Boolean))]
}

function normalizeThinking(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined
  return [...new Set(values.map(value => String(value).trim().toLowerCase()).filter(Boolean))]
}

function validateGateway(gateway, errors) {
  const q = gateway.queue ?? {}
  const tunnel = gateway.cloudflareTunnel ?? {}
  const cpa = gateway.cpa ?? {}
  if (typeof gateway.cpa?.localModelCatalog !== 'boolean') errors.push('cpa.localModelCatalog must be boolean')
  if (cpa.disableCodexCloaking !== undefined && typeof cpa.disableCodexCloaking !== 'boolean') errors.push('cpa.disableCodexCloaking must be boolean')
  if (!ENV_NAME.test(tunnel.enabledEnv ?? '')) errors.push('cloudflareTunnel.enabledEnv must be an environment variable name')
  if (!ENV_NAME.test(tunnel.tokenEnv ?? '')) errors.push('cloudflareTunnel.tokenEnv must be an environment variable name')
  if (tunnel.metricsHost !== '127.0.0.1') errors.push('cloudflareTunnel.metricsHost must be 127.0.0.1')
  if (q.maxConnectionsPerChannel !== 1) errors.push('queue.maxConnectionsPerChannel must be exactly 1')
  for (const [name, value] of Object.entries({
    'queue.maxQueuedPerChannel': q.maxQueuedPerChannel,
    'queue.timeoutSeconds': q.timeoutSeconds,
    'internal.cpaPort': gateway.internal?.cpaPort,
    'internal.firstChannelPort': gateway.internal?.firstChannelPort,
    'control.maxRequestBytes': gateway.control?.maxRequestBytes,
    'control.busyRetryAfterSeconds': gateway.control?.busyRetryAfterSeconds,
    'cloudflareTunnel.metricsPort': tunnel.metricsPort,
    'cloudflareTunnel.readyTimeoutSeconds': tunnel.readyTimeoutSeconds
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${name} must be a positive integer`)
  }
}
