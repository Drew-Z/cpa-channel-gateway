export function buildCanaryRequest(protocol, model, prompt) {
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

export function extractCanaryContent(protocol, payload) {
  if (protocol === 'responses') {
    if (typeof payload?.output_text === 'string') return payload.output_text
    return (payload?.output ?? []).flatMap(item => item?.content ?? []).map(item => item?.text ?? '').join('')
  }
  if (protocol === 'chat') return payload?.choices?.[0]?.message?.content
  if (protocol === 'claude') return (payload?.content ?? []).map(item => item?.text ?? '').join('')
  return ''
}
