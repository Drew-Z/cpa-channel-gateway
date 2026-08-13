import fs from 'node:fs'
import path from 'node:path'
import { readEnvFile } from './env.mjs'

const CHANNEL_ID = /^[a-z][a-z0-9-]{0,31}$/
const MODEL_NAME = /^[^\s/][^\r\n]{0,254}$/
const ALIAS = /^[a-z0-9][a-z0-9._/-]{0,127}$/

export function loadConfig(root, { allowExamples = false } = {}) {
  const gateway = readJson(path.join(root, 'config', 'gateway.json'))
  const routesPath = chooseLocal(root, 'routes.local.json', 'routes.example.json', allowExamples)
  const envPath = chooseLocal(root, 'channels.local.env', 'channels.example.env', allowExamples)
  const routes = readJson(routesPath)
  const env = readEnvFile(envPath)
  return validateAndNormalize({ gateway, routes, env, paths: { routesPath, envPath } })
}

function chooseLocal(root, localName, exampleName, allowExamples) {
  const localPath = path.join(root, 'config', localName)
  if (fs.existsSync(localPath)) return localPath
  if (allowExamples) return path.join(root, 'config', exampleName)
  throw new Error(`Missing private configuration: config/${localName}`)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function validateAndNormalize({ gateway, routes, env, paths }) {
  const errors = []
  if (gateway.schemaVersion !== 1) errors.push('gateway.json schemaVersion must be 1')
  if (routes.schemaVersion !== 1) errors.push('routes schemaVersion must be 1')
  const gatewayKey = requireSecret(env, 'GATEWAY_API_KEY', errors, 32)
  const managementKey = env.CPA_MANAGEMENT_KEY?.trim() ?? ''
  const seenChannels = new Set()
  const seenAliases = new Set()
  const channelById = new Map()
  const channels = []

  for (const [index, routeChannel] of (routes.channels ?? []).entries()) {
    const id = String(routeChannel.id ?? '').toLowerCase()
    if (!CHANNEL_ID.test(id)) errors.push(`channels[${index}].id is invalid`)
    if (seenChannels.has(id)) errors.push(`Duplicate channel id: ${id}`)
    seenChannels.add(id)
    const envPrefix = `CHANNEL_${id.toUpperCase().replaceAll('-', '_')}`
    const baseUrlText = env[`${envPrefix}_BASE_URL`]?.trim() ?? ''
    let upstream
    try {
      upstream = new URL(baseUrlText)
      if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('unsupported scheme')
      if (upstream.username || upstream.password || upstream.hash || upstream.search) throw new Error('credentials/query/fragment are forbidden')
    } catch {
      errors.push(`${envPrefix}_BASE_URL must be a clean http(s) URL`)
    }
    const secret = requireSecret(env, `${envPrefix}_API_KEY`, errors, 8)
    const protocol = (env[`${envPrefix}_PROTOCOL`] || 'openai-compatible').trim()
    if (!['openai-compatible', 'responses', 'claude'].includes(protocol)) errors.push(`${envPrefix}_PROTOCOL is not supported: ${protocol}`)
    const enabledByEnv = parseBoolean(env[`${envPrefix}_ENABLED`] ?? 'true', `${envPrefix}_ENABLED`, errors)
    const models = []
    for (const [modelIndex, model] of (routeChannel.models ?? []).entries()) {
      const upstreamModel = String(model.upstream ?? '').trim()
      if (!MODEL_NAME.test(upstreamModel)) errors.push(`${id}.models[${modelIndex}].upstream is invalid`)
      const modelProtocol = String(model.protocol ?? protocol).trim()
      if (!['openai-compatible', 'responses', 'claude'].includes(modelProtocol)) errors.push(`${id}.models[${modelIndex}].protocol is not supported: ${modelProtocol}`)
      const aliases = [...new Set((model.aliases ?? []).map(value => String(value).trim()))]
      if (!aliases.length) aliases.push(`${id}/${upstreamModel}`)
      for (const alias of aliases) validateAlias(alias, `${id}.models[${modelIndex}]`, seenAliases, errors)
      models.push({
        upstream: upstreamModel,
        protocol: modelProtocol,
        aliases,
        displayName: model.displayName ? String(model.displayName) : undefined,
        maxContextLength: optionalPositiveInteger(model.maxContextLength, `${id}.${upstreamModel}.maxContextLength`, errors),
        inputModalities: normalizeModalities(model.inputModalities, ['text']),
        outputModalities: normalizeModalities(model.outputModalities, ['text']),
        thinkingLevels: normalizeThinking(model.thinkingLevels)
      })
    }
    const enabled = Boolean(routeChannel.enabled ?? true) && enabledByEnv
    if (enabled && models.length === 0) errors.push(`Enabled channel ${id} has no models`)
    const channel = {
      id,
      name: env[`${envPrefix}_NAME`]?.trim() || id,
      enabled,
      upstream,
      apiKey: secret,
      protocol,
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
      else if (!channel.enabled) errors.push(`${field}[${index}] references disabled channel ${channelId}`)
      else if (!channel.models.some(item => item.upstream === model)) errors.push(`${field}[${index}] references unknown model ${channelId}/${model}`)
      const approvalRef = String(entry.approvalRef ?? '').trim()
      if (pinned && !approvalRef) errors.push(`${field}[${index}] requires approvalRef`)
      return { alias, channel: channelId, model, approvalRef: pinned ? approvalRef : undefined }
    })
  }

  validateGateway(gateway, errors)
  if (errors.length) throw new Error(`Configuration validation failed:\n- ${errors.join('\n- ')}`)
  return { gateway, routes, env, paths, gatewayKey, managementKey, channels, stableAliases, pinnedAliases }
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
  if (q.maxConnectionsPerChannel !== 1) errors.push('queue.maxConnectionsPerChannel must be exactly 1')
  for (const [name, value] of Object.entries({
    'queue.maxQueuedPerChannel': q.maxQueuedPerChannel,
    'queue.timeoutSeconds': q.timeoutSeconds,
    'internal.firstChannelPort': gateway.internal?.firstChannelPort
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) errors.push(`${name} must be a positive integer`)
  }
}
