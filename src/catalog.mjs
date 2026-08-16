export function buildModelCatalog(config) {
  const logicalModels = new Map()
  const exactAliases = new Map()
  const stagedExactAliases = new Map()
  const routeAliases = new Map()
  const candidatesByKey = new Map()
  const allModels = new Map()

  for (const channel of config.channels.filter(item => item.runtimeEnabled ?? item.enabled)) {
    for (const model of channel.models) {
      const candidate = {
        key: `${channel.id}\0${model.upstream}\0${model.protocol}`,
        channelId: channel.id,
        channelName: channel.name,
        upstreamModel: model.upstream,
        protocol: model.protocol,
        priority: model.priority ?? channel.priority ?? 0,
        directAlias: `${channel.id}/${model.upstream}`,
        channel,
        model
      }
      if (!allModels.has(model.upstream)) allModels.set(model.upstream, [])
      allModels.get(model.upstream).push(candidate)
      if (model.status === 'disabled') continue
      candidatesByKey.set(candidate.key, candidate)
      if (channel.enabled) {
        if (!logicalModels.has(model.upstream)) logicalModels.set(model.upstream, [])
        logicalModels.get(model.upstream).push(candidate)
        for (const alias of model.aliases) exactAliases.set(alias, candidate)
      } else if (channel.staged) {
        stagedExactAliases.set(candidate.directAlias, candidate)
      }
    }
  }

  for (const route of [...config.stableAliases, ...config.pinnedAliases]) {
    const candidate = findCandidate(config, candidatesByKey, route.channel, route.model)
    if (candidate) routeAliases.set(route.alias, candidate)
  }

  for (const candidates of logicalModels.values()) candidates.sort(compareCandidates)

  return {
    resolve(modelId) {
      const routeCandidate = routeAliases.get(modelId)
      if (routeCandidate) return { requestedModel: modelId, kind: 'route-alias', candidates: [routeCandidate] }
      const logicalCandidates = logicalModels.get(modelId)
      if (logicalCandidates) return { requestedModel: modelId, kind: 'logical', candidates: [...logicalCandidates] }
      const exactCandidate = exactAliases.get(modelId)
      if (exactCandidate) return { requestedModel: modelId, kind: 'direct', candidates: [exactCandidate] }
      const stagedCandidate = stagedExactAliases.get(modelId)
      if (stagedCandidate) return { requestedModel: modelId, kind: 'staged-direct', candidates: [stagedCandidate] }
      return null
    },
    listPublicModels() {
      const ids = new Set([
        ...logicalModels.keys(),
        ...routeAliases.keys(),
        ...exactAliases.keys()
      ])
      return [...ids].sort((left, right) => left.localeCompare(right)).map(id => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'cpa-channel-gateway'
      }))
    },
    logicalModels,
    allModels,
    exactAliases,
    routeAliases,
    stagedExactAliases
  }
}

export function compareCandidates(left, right) {
  return (right.priority - left.priority)
    || left.channelId.localeCompare(right.channelId)
    || left.upstreamModel.localeCompare(right.upstreamModel)
    || left.protocol.localeCompare(right.protocol)
}

function findCandidate(config, candidatesByKey, channelId, upstreamModel) {
  const channel = config.channels.find(item => item.enabled && item.id === channelId)
  if (!channel) return null
  const model = channel.models.find(item => item.upstream === upstreamModel)
  if (!model) return null
  return candidatesByKey.get(`${channel.id}\0${model.upstream}\0${model.protocol}`) ?? null
}
