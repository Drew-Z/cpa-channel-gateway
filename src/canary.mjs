export function buildCanaryRequest(protocol, model, prompt) {
  protocol = normalizeCanaryProtocol(protocol)
  if (protocol === 'responses') {
    return { path: '/v1/responses', body: { model, input: prompt, stream: false, max_output_tokens: 512 } }
  }
  if (protocol === 'chat') {
    return { path: '/v1/chat/completions', body: { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 512 } }
  }
  if (protocol === 'claude') {
    return { path: '/v1/messages', body: { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 512 } }
  }
  throw new Error(`Unsupported CANARY_PROTOCOL: ${protocol}`)
}

export function resolveCanaryUrl(baseUrl, port, requestPath) {
  const target = new URL(baseUrl || `http://127.0.0.1:${port}`)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
    throw new Error('GATEWAY_BASE_URL must be a clean http(s) URL')
  }
  return new URL(requestPath, target).toString()
}

export function extractCanaryContent(protocol, payload) {
  protocol = normalizeCanaryProtocol(protocol)
  if (protocol === 'responses') {
    if (typeof payload?.output_text === 'string') return payload.output_text
    return arrayValue(payload?.output)
      .flatMap(item => arrayValue(item?.content))
      .map(textFromContentPart)
      .join('')
  }
  if (protocol === 'chat') {
    const choice = arrayValue(payload?.choices)[0]
    const content = choice?.message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(textFromContentPart).join('')
    return typeof choice?.text === 'string' ? choice.text : ''
  }
  if (protocol === 'claude') return arrayValue(payload?.content).map(textFromContentPart).join('')
  return ''
}

export function diagnoseCanaryResponse(protocol, body) {
  const protocolName = normalizeCanaryProtocol(protocol)
  const source = typeof body === 'string' ? body : ''
  const diagnostics = { bodyBytes: Buffer.byteLength(source) }
  if (!source.trim()) return { ok: false, error: 'empty_body', diagnostics }

  let payload
  try {
    payload = JSON.parse(source)
  } catch {
    return { ok: false, error: 'invalid_json', diagnostics }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'invalid_json', diagnostics }
  }

  Object.assign(diagnostics, responseMetadata(protocolName, payload))
  const content = extractCanaryContent(protocolName, payload)
  const contentLength = typeof content === 'string' ? content.trim().length : 0
  if (contentLength >= 8) return { ok: true, contentLength, diagnostics }
  if (contentLength > 0) return { ok: false, error: 'short_content', contentLength, diagnostics }
  return { ok: false, error: emptyContentReason(protocolName, payload), diagnostics }
}

export function normalizeCanaryProtocol(protocol) {
  return protocol === 'openai-compatible' ? 'chat' : protocol
}

function emptyContentReason(protocol, payload) {
  if (protocol === 'chat') {
    const choices = arrayValue(payload?.choices)
    if (!choices.length) return 'missing_choices'
    const choice = choices[0]
    const message = choice?.message
    if (hasReasoning(message) || hasReasoning(choice)) return 'reasoning_only'
    if (message?.refusal || arrayValue(message?.tool_calls).length || choice?.finish_reason === 'tool_calls') return 'refusal_or_tool_call'
    if (message?.content === null) return 'content_null'
    if (Array.isArray(message?.content) && message.content.length) return 'structured_content_unsupported'
    return 'empty_content'
  }
  if (protocol === 'responses') {
    const output = arrayValue(payload?.output)
    const parts = output.flatMap(item => arrayValue(item?.content))
    if (output.some(item => item?.type === 'reasoning') || parts.some(item => item?.type === 'reasoning') || hasReasoning(payload)) return 'reasoning_only'
    if (output.some(item => ['function_call', 'tool_call'].includes(item?.type)) || parts.some(item => item?.type === 'refusal')) return 'refusal_or_tool_call'
    if (parts.length) return 'structured_content_unsupported'
    return 'empty_content'
  }
  if (protocol === 'claude') {
    const content = arrayValue(payload?.content)
    if (content.some(item => item?.type === 'thinking') || hasReasoning(payload)) return 'reasoning_only'
    if (content.some(item => item?.type === 'tool_use') || payload?.stop_reason === 'tool_use') return 'refusal_or_tool_call'
    if (content.length) return 'structured_content_unsupported'
    return 'empty_content'
  }
  return 'empty_content'
}

function responseMetadata(protocol, payload) {
  const metadata = {}
  const usage = usageSummary(payload?.usage)
  if (Object.keys(usage).length) metadata.usage = usage
  if (protocol === 'chat') {
    const choice = arrayValue(payload?.choices)[0]
    if (typeof choice?.finish_reason === 'string') metadata.finishReason = safeLabel(choice.finish_reason)
    const content = choice?.message?.content
    if (Array.isArray(content)) metadata.contentTypes = safeTypes(content)
    metadata.reasoningPresent = hasReasoning(choice?.message) || hasReasoning(choice)
  } else if (protocol === 'responses') {
    if (typeof payload?.status === 'string') metadata.responseStatus = safeLabel(payload.status)
    const output = arrayValue(payload?.output)
    metadata.outputItemTypes = safeTypes(output)
    metadata.contentTypes = safeTypes(output.flatMap(item => arrayValue(item?.content)))
    metadata.reasoningPresent = output.some(item => item?.type === 'reasoning') || hasReasoning(payload)
  } else if (protocol === 'claude') {
    if (typeof payload?.stop_reason === 'string') metadata.stopReason = safeLabel(payload.stop_reason)
    metadata.contentTypes = safeTypes(arrayValue(payload?.content))
    metadata.reasoningPresent = arrayValue(payload?.content).some(item => item?.type === 'thinking') || hasReasoning(payload)
  }
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== false && (!Array.isArray(value) || value.length)))
}

function usageSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const fields = {
    inputTokens: value.input_tokens ?? value.prompt_tokens,
    outputTokens: value.output_tokens ?? value.completion_tokens,
    totalTokens: value.total_tokens,
    reasoningTokens: value.output_tokens_details?.reasoning_tokens ?? value.completion_tokens_details?.reasoning_tokens
  }
  return Object.fromEntries(Object.entries(fields).filter(([, count]) => Number.isSafeInteger(count) && count >= 0))
}

function textFromContentPart(item) {
  if (typeof item === 'string') return item
  if (typeof item?.text === 'string') return item.text
  if (typeof item?.text?.value === 'string') return item.text.value
  return ''
}

function hasReasoning(value) {
  return typeof value?.reasoning_content === 'string' && value.reasoning_content.trim().length > 0
}

function safeTypes(values) {
  return [...new Set(values.map(item => safeLabel(item?.type)).filter(Boolean))].slice(0, 16)
}

function safeLabel(value) {
  const label = String(value ?? '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(label) ? label : undefined
}

function arrayValue(value) {
  return Array.isArray(value) ? value : []
}
