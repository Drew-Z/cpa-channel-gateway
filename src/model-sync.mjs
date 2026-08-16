const MODEL_ID = /^[^\s/][^\r\n]{0,254}$/

export function buildModelCatalogUrl(upstream) {
  const target = new URL(upstream)
  const basePath = target.pathname.replace(/\/+$/, '')
  target.pathname = `${basePath}/models`
  target.search = ''
  target.hash = ''
  return target
}

export function selectChannelsForSync(channels, requestedIds = []) {
  const ids = [...new Set(requestedIds.map(value => String(value).trim().toLowerCase()).filter(Boolean))]
  if (!ids.length) return channels.filter(channel => channel.enabled)
  const byId = new Map(channels.map(channel => [channel.id, channel]))
  const unknown = ids.filter(id => !byId.has(id))
  if (unknown.length) throw new Error(`Unknown channels requested for model synchronization: ${unknown.join(', ')}`)
  return ids.map(id => byId.get(id))
}

export async function fetchChannelModels(channel, { fetchImpl = fetch, timeoutMs = 30_000, maxPages = 20 } = {}) {
  const target = buildModelCatalogUrl(channel.upstream)
  const models = []
  const seen = new Set()

  for (let page = 1; page <= maxPages; page += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let payload
    try {
      const response = await fetchImpl(target, {
        headers: catalogHeaders(channel),
        signal: controller.signal
      })
      if (!response.ok) throw new Error(`Channel ${channel.id} model catalog returned HTTP ${response.status}`)
      try {
        payload = await response.json()
      } catch (error) {
        throw new Error(`Channel ${channel.id} model catalog returned invalid JSON`, { cause: error })
      }
    } catch (error) {
      if (error?.message?.startsWith(`Channel ${channel.id} model catalog`)) throw error
      const reason = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : 'request failed'
      throw new Error(`Channel ${channel.id} model catalog ${reason}`, { cause: error })
    } finally {
      clearTimeout(timer)
    }

    for (const id of modelIds(payload)) {
      if (!MODEL_ID.test(id)) throw new Error(`Channel ${channel.id} returned an invalid model id`)
      if (!seen.has(id)) {
        seen.add(id)
        models.push(id)
      }
    }

    if (!payload?.has_more) break
    const after = String(payload.last_id ?? '').trim()
    if (!after) throw new Error(`Channel ${channel.id} model catalog pagination is missing last_id`)
    target.searchParams.set('after_id', after)
    if (page === maxPages) throw new Error(`Channel ${channel.id} model catalog exceeded ${maxPages} pages`)
  }

  if (!models.length) throw new Error(`Channel ${channel.id} model catalog returned no models`)
  return models
}

export function synchronizeRouteModels(routes, discoveries) {
  const referenced = referencedModels(routes)
  const summaries = []
  const channels = (routes.channels ?? []).map(channel => {
    const discovered = discoveries.get(channel.id)
    if (!discovered) return channel

    const discoveredSet = new Set(discovered)
    const existing = channel.models ?? []
    const existingByUpstream = new Map()
    for (const model of existing) {
      const entries = existingByUpstream.get(model.upstream) ?? []
      entries.push(model)
      existingByUpstream.set(model.upstream, entries)
    }

    const stale = [...existingByUpstream.keys()].filter(model => !discoveredSet.has(model))
    const preserved = stale.filter(model => referenced.has(`${channel.id}\0${model}`))
    const removed = stale.filter(model => !referenced.has(`${channel.id}\0${model}`))
    const synchronized = new Set([...discoveredSet, ...preserved])

    let added = 0
    const models = []
    for (const upstream of [...synchronized].sort()) {
      const prior = existingByUpstream.get(upstream)
      if (!prior?.length) {
        added += 1
        models.push({ upstream, aliases: [canonicalModelAlias(channel.id, upstream)], status: 'active' })
        continue
      }

      const canonical = canonicalModelAlias(channel.id, upstream)
      const hasCanonical = prior.some(model => (model.aliases ?? []).includes(canonical))
      for (const [index, model] of prior.entries()) {
        if (index === 0 && !hasCanonical) {
          models.push({ ...model, aliases: [...new Set([...(model.aliases ?? []), canonical])], status: synchronizedModelStatus(model) })
        } else {
          models.push({ ...model, status: synchronizedModelStatus(model) })
        }
      }
    }

    for (const model of preserved) {
      const prior = existingByUpstream.get(model)
      if (!prior) continue
      const first = models.find(item => item.upstream === model)
      if (first && first.status !== 'disabled') first.status = 'stale'
    }

    summaries.push({
      channel: channel.id,
      before: existing.length,
      discovered: discoveredSet.size,
      added,
      removed: removed.length,
      preservedReferenced: preserved.length,
      after: models.length
    })
    return { ...channel, models }
  })

  return { routes: { ...routes, channels }, summaries }
}

function synchronizedModelStatus(model) {
  return model.status === 'disabled' ? 'disabled' : 'active'
}

export function canonicalModelAlias(channelId, upstream) {
  return `${channelId}/${upstream}`
}

function catalogHeaders(channel) {
  const headers = { Authorization: `Bearer ${channel.apiKey}` }
  if (channel.protocol === 'claude') {
    headers['x-api-key'] = channel.apiKey
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

function modelIds(payload) {
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : []
  return entries
    .map(item => typeof item === 'string' ? item : item?.id)
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim())
}

function referencedModels(routes) {
  return new Set([
    ...(routes.stableAliases ?? []),
    ...(routes.pinnedAliases ?? [])
  ].map(route => `${route.channel}\0${route.model}`))
}
