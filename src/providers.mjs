export const PROVIDER_SCHEMA_VERSION = 1
export const CHANNEL_ENV_PATTERN = /^CHANNEL_([A-Z][A-Z0-9_]*)_(NAME|BASE_URL|API_KEY|PROTOCOL|ENABLED)$/

export function isChannelEnvKey(key) {
  return CHANNEL_ENV_PATTERN.test(String(key))
}
export function providerEnvPrefix(id) {
  return `CHANNEL_${String(id).toUpperCase().replaceAll('-', '_')}`
}

export function collectLegacyChannelEntries(env) {
  const grouped = new Map()
  for (const [key, value] of Object.entries(env ?? {})) {
    const match = CHANNEL_ENV_PATTERN.exec(key)
    if (!match) continue
    const id = match[1].toLowerCase().replaceAll('_', '-')
    const entry = grouped.get(id) ?? { id, prefix: match[1], values: {} }
    entry.values[match[2]] = String(value ?? '').trim()
    grouped.set(id, entry)
  }
  return [...grouped.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function stripLegacyChannelEnv(env) {
  const next = { ...(env ?? {}) }
  for (const key of Object.keys(next)) if (isChannelEnvKey(key)) delete next[key]
  return next
}

export function providerDocumentFromLegacy({ env, routes }) {
  const routeById = new Map((routes?.channels ?? []).map(channel => [String(channel.id).toLowerCase(), channel]))
  const providers = collectLegacyChannelEntries(env).map(entry => {
    const route = routeById.get(entry.id)
    const values = entry.values
    const enabledByEnv = !/^(false|0)$/i.test(values.ENABLED ?? 'true')
    return {
      id: entry.id,
      name: values.NAME || entry.id,
      baseUrl: values.BASE_URL || '',
      apiKey: values.API_KEY || '',
      protocol: values.PROTOCOL || 'openai-compatible',
      enabled: route ? Boolean(route.enabled ?? true) && enabledByEnv && route.staged !== true : enabledByEnv,
      priority: Number.isSafeInteger(route?.priority) ? route.priority : 0
    }
  })
  return { schemaVersion: PROVIDER_SCHEMA_VERSION, providers }
}

export function routeDocumentForProviders(routes) {
  const next = structuredClone(routes)
  for (const channel of next.channels ?? []) {
    delete channel.enabled
    delete channel.priority
  }
  return next
}
