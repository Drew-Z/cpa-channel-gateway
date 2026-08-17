import { isGenerationModel, normalizeModelKind, normalizeStreamingMode } from './model-metadata.mjs'

export function buildModelCatalog(config) {
  const logicalModels = new Map()
  const exactAliases = new Map()
  const stagedExactAliases = new Map()
  const routeAliases = new Map()
  const candidatesByKey = new Map()
  const allModels = new Map()

  for (const channel of config.channels.filter(item => item.runtimeEnabled ?? item.enabled)) {
    for (const model of channel.models) {
      const kind = normalizeModelKind(model.kind, model.upstream)
      const candidate = {
        key: `${channel.id}\0${model.upstream}\0${model.protocol}`,
        channelId: channel.id,
        channelName: channel.name,
        upstreamModel: model.upstream,
        protocol: model.protocol,
        priority: model.priority ?? channel.priority ?? 0,
        directAlias: `${channel.id}/${model.upstream}`,
        kind,
        streaming: normalizeStreamingMode(model.streaming),
        canaryEligible: model.canaryEligible ?? isGenerationModel({ kind }),
        channel,
        model
      }
      if (!allModels.has(model.upstream)) allModels.set(model.upstream, [])
      allModels.get(model.upstream).push(candidate)
      if (model.status === 'disabled') continue
      candidatesByKey.set(candidate.key, candidate)
      if (channel.enabled && isGenerationModel(candidate)) {
        if (!logicalModels.has(model.upstream)) logicalModels.set(model.upstream, [])
        logicalModels.get(model.upstream).push(candidate)
        for (const alias of model.aliases) exactAliases.set(alias, candidate)
      } else if (channel.staged) {
        if (isGenerationModel(candidate)) stagedExactAliases.set(candidate.directAlias, candidate)
      }
    }
  }

  // Exact upstream IDs remain automatically grouped for backward compatibility.
  // An explicit logical model replaces the automatic group with the same public
  // ID, while still allowing its candidates to participate in other groups.
  for (const candidates of logicalModels.values()) candidates.sort(compareCandidates)
  for (const logical of config.logicalModels ?? []) {
    const selected = []
    for (const reference of logical.candidates ?? []) {
      if (reference.enabled === false) continue
      const candidate = findCandidateByModel(candidatesByKey, reference.channel, reference.model)
      if (!candidate || !candidate.channel.enabled || candidate.model.status === 'disabled' || !isGenerationModel(candidate)) continue
      selected.push({
        ...candidate,
        logicalModelId: logical.id,
        priority: reference.priority ?? candidate.priority
      })
    }
    if (!logical.enabled) {
      logicalModels.delete(logical.id)
    } else if (selected.length) {
      logicalModels.set(logical.id, selected.sort(compareCandidates))
    } else {
      logicalModels.delete(logical.id)
    }
  }

  for (const route of [...config.stableAliases, ...config.pinnedAliases]) {
    if (route.logicalModel) {
      const candidates = logicalModels.get(route.logicalModel)
      if (candidates?.length) routeAliases.set(route.alias, {
        kind: 'logical-alias',
        logicalModelId: route.logicalModel,
        candidates: [...candidates]
      })
      continue
    }
    const candidate = findCandidate(config, candidatesByKey, route.channel, route.model)
    if (candidate && isGenerationModel(candidate)) routeAliases.set(route.alias, {
      kind: 'route-alias',
      logicalModelId: candidate.upstreamModel,
      candidates: [candidate]
    })
  }

  return {
    resolve(modelId) {
      const route = routeAliases.get(modelId)
      if (route) return {
        requestedModel: modelId,
        kind: route.kind,
        logicalModelId: route.logicalModelId,
        candidates: [...route.candidates]
      }
      const logicalCandidates = logicalModels.get(modelId)
      if (logicalCandidates) return { requestedModel: modelId, kind: 'logical', logicalModelId: modelId, candidates: [...logicalCandidates] }
      const exactCandidate = exactAliases.get(modelId)
      if (exactCandidate) return { requestedModel: modelId, kind: 'direct', logicalModelId: exactCandidate.upstreamModel, candidates: [exactCandidate] }
      const stagedCandidate = stagedExactAliases.get(modelId)
      if (stagedCandidate) return { requestedModel: modelId, kind: 'staged-direct', logicalModelId: stagedCandidate.upstreamModel, candidates: [stagedCandidate] }
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

function findCandidateByModel(candidatesByKey, channelId, upstreamModel) {
  return [...candidatesByKey.values()].find(candidate => candidate.channelId === channelId && candidate.upstreamModel === upstreamModel) ?? null
}
