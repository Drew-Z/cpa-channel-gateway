const LEGACY_SUFFIXES = ['', '1', '2', '3', '4', '5', '6', '7', '8', '9']

const PROTOCOL_ALIASES = new Map([
  ['openai-compatible', 'openai-compatible'],
  ['openai', 'openai-compatible'],
  ['chat/completion', 'openai-compatible'],
  ['chat/completions', 'openai-compatible'],
  ['chat_completions', 'openai-compatible'],
  ['responses', 'responses'],
  ['claude', 'claude']
])

export function readLegacyChannels(values) {
  const channels = []
  for (const suffix of LEGACY_SUFFIXES) {
    const providerKey = suffix ? `PROVIDER_NAME${suffix}` : 'AI_PROVIDER_NAME'
    const baseUrlKey = suffix ? `BASE_URL${suffix}` : 'AI_BASE_URL'
    const apiKeyKey = suffix ? `API_KEY${suffix}` : 'AI_API_KEY'
    const protocolKey = suffix ? `API_PROTOCOL${suffix}` : 'AI_API_PROTOCOL'
    const provider = values[providerKey]?.trim() ?? ''
    const baseUrl = values[baseUrlKey]?.trim() ?? ''
    const apiKey = values[apiKeyKey]?.trim() ?? ''
    if (!provider && !baseUrl && !apiKey) continue
    if (!provider || !baseUrl || !apiKey) throw new Error(`Incomplete legacy channel suffix ${suffix || '0'}`)
    const id = slugify(provider)
    if (channels.some(item => item.id === id)) throw new Error(`Duplicate generated channel id: ${id}`)
    const rawProtocol = values[protocolKey]?.trim() || 'openai-compatible'
    const protocol = normalizeProtocol(rawProtocol)
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, protocol)
    channels.push({ id, name: provider, baseUrl: normalizedBaseUrl, rawBaseUrl: baseUrl, apiKey, protocol, rawProtocol })
  }
  if (!channels.length) throw new Error('No legacy channels found')
  return channels
}

export function mergeLegacyConfig({ currentEnv, currentRoutes, legacyChannels }) {
  const env = { ...currentEnv }
  const routes = {
    schemaVersion: currentRoutes.schemaVersion,
    channels: Array.isArray(currentRoutes.channels) ? currentRoutes.channels.map(channel => ({ ...channel })) : [],
    logicalModels: Array.isArray(currentRoutes.logicalModels) ? currentRoutes.logicalModels.map(group => ({
      ...group,
      candidates: Array.isArray(group.candidates) ? group.candidates.map(candidate => ({ ...candidate })) : []
    })) : undefined,
    stableAliases: Array.isArray(currentRoutes.stableAliases) ? currentRoutes.stableAliases.map(alias => ({ ...alias })) : [],
    pinnedAliases: Array.isArray(currentRoutes.pinnedAliases) ? currentRoutes.pinnedAliases.map(alias => ({ ...alias })) : []
  }
  const routeById = new Map(routes.channels.map(channel => [String(channel.id).toLowerCase(), channel]))
  const added = []
  const updated = []
  const normalizedProtocols = []
  const normalizedBaseUrls = []

  for (const channel of legacyChannels) {
    const prefix = `CHANNEL_${channel.id.toUpperCase().replaceAll('-', '_')}`
    const route = routeById.get(channel.id)
    env[`${prefix}_NAME`] = channel.name
    env[`${prefix}_BASE_URL`] = channel.baseUrl
    env[`${prefix}_API_KEY`] = channel.apiKey
    env[`${prefix}_PROTOCOL`] = channel.protocol
    if (!(`${prefix}_ENABLED` in env)) env[`${prefix}_ENABLED`] = 'false'
    if (channel.rawProtocol !== channel.protocol) normalizedProtocols.push(channel.id)
    if (channel.rawBaseUrl !== channel.baseUrl) normalizedBaseUrls.push(channel.id)

    if (route) {
      updated.push(channel.id)
      continue
    }
    const nextRoute = { id: channel.id, enabled: false, models: [] }
    routes.channels.push(nextRoute)
    routeById.set(channel.id, nextRoute)
    added.push(channel.id)
  }

  return { env, routes, report: { added, updated, normalizedProtocols, normalizedBaseUrls } }
}

export function slugify(value) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!result) throw new Error(`Cannot derive channel id from ${value}`)
  return result.slice(0, 32)
}

function normalizeProtocol(value) {
  const normalized = PROTOCOL_ALIASES.get(value.toLowerCase())
  if (!normalized) throw new Error(`Unsupported legacy protocol: ${value}`)
  return normalized
}

function normalizeBaseUrl(value, protocol) {
  let target
  try {
    target = new URL(value)
  } catch {
    throw new Error('Legacy channel Base URL is invalid')
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('Legacy channel Base URL must be a clean http(s) URL')
  }
  const suffix = protocol === 'openai-compatible'
    ? '/chat/completions'
    : protocol === 'responses'
      ? '/responses'
      : '/messages'
  const pathname = target.pathname.replace(/\/+$/, '')
  if (pathname.endsWith(suffix)) target.pathname = pathname.slice(0, -suffix.length) || '/'
  return target.toString()
}
