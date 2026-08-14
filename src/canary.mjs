export function buildCanaryRequest(protocol, model, prompt) {
  protocol = normalizeCanaryProtocol(protocol)
  if (protocol === 'responses') {
    return { path: '/v1/responses', body: { model, input: prompt, stream: false, max_output_tokens: 256 } }
  }
  if (protocol === 'chat') {
    return { path: '/v1/chat/completions', body: { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 256 } }
  }
  if (protocol === 'claude') {
    return { path: '/v1/messages', body: { model, messages: [{ role: 'user', content: prompt }], stream: false, max_tokens: 256 } }
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
    return (payload?.output ?? []).flatMap(item => item?.content ?? []).map(item => item?.text ?? '').join('')
  }
  if (protocol === 'chat') return payload?.choices?.[0]?.message?.content
  if (protocol === 'claude') return (payload?.content ?? []).map(item => item?.text ?? '').join('')
  return ''
}

export function normalizeCanaryProtocol(protocol) {
  return protocol === 'openai-compatible' ? 'chat' : protocol
}
