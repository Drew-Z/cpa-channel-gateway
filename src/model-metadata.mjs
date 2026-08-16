export const MODEL_KINDS = new Set([
  'generation',
  'embedding',
  'rerank',
  'audio',
  'image',
  'video',
  'ocr',
  'moderation'
])

export const STREAMING_MODES = new Set(['both', 'stream-only', 'non-stream-only'])

export function normalizeModelKind(value, modelId) {
  const explicit = String(value ?? '').trim().toLowerCase()
  if (explicit) return MODEL_KINDS.has(explicit) ? explicit : 'generation'
  return inferModelKind(modelId)
}

export function inferModelKind(modelId) {
  const id = String(modelId ?? '').toLowerCase()
  if (/embedding/.test(id)) return 'embedding'
  if (/rerank|reranker/.test(id)) return 'rerank'
  if (/\basr\b|speech|audio|tts/.test(id)) return 'audio'
  if (/ocr/.test(id)) return 'ocr'
  if (/flux|image/.test(id)) return 'image'
  if (/video/.test(id)) return 'video'
  if (/content[-_ ]?safety|moderation/.test(id)) return 'moderation'
  return 'generation'
}

export function normalizeStreamingMode(value) {
  const mode = String(value ?? '').trim().toLowerCase()
  return STREAMING_MODES.has(mode) ? mode : 'both'
}

export function supportsStreaming(model, requestedMode) {
  const mode = normalizeStreamingMode(model?.streaming)
  if (requestedMode === 'stream') return mode !== 'non-stream-only'
  if (requestedMode === 'non-stream') return mode !== 'stream-only'
  return true
}

export function isGenerationModel(model) {
  return model?.kind === 'generation'
}

export function isCanaryEligible(model) {
  return isGenerationModel(model) && model?.canaryEligible !== false
}
