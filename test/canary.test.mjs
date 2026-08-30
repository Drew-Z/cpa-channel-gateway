import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCanaryRequest, diagnoseCanaryResponse, extractCanaryContent, resolveCanaryUrl } from '../src/canary.mjs'

test('builds meaningful canary requests for every supported client protocol', () => {
  const responses = buildCanaryRequest('responses', 'coding-main', 'write a poem')
  assert.equal(responses.path, '/v1/responses')
  assert.equal(responses.body.input, 'write a poem')
  const chat = buildCanaryRequest('chat', 'coding-fast', 'write a poem')
  assert.equal(chat.path, '/v1/chat/completions')
  assert.equal(chat.body.messages[0].content, 'write a poem')
  const compatible = buildCanaryRequest('openai-compatible', 'coding-backup', 'write a poem')
  assert.equal(compatible.path, '/v1/chat/completions')
  const claude = buildCanaryRequest('claude', 'claude-main', 'write a poem')
  assert.equal(claude.path, '/v1/messages')
  assert.equal(claude.body.messages[0].content, 'write a poem')
  assert.throws(() => buildCanaryRequest('invalid', 'model', 'prompt'), /Unsupported/)
})

test('extracts text without logging response bodies', () => {
  assert.equal(extractCanaryContent('responses', { output_text: 'poem' }), 'poem')
  assert.equal(extractCanaryContent('responses', { output: [{ content: [{ text: 'po' }, { text: 'em' }] }] }), 'poem')
  assert.equal(extractCanaryContent('chat', { choices: [{ message: { content: 'poem' } }] }), 'poem')
  assert.equal(extractCanaryContent('chat', { choices: [{ message: { content: [{ type: 'text', text: 'poem' }] } }] }), 'poem')
  assert.equal(extractCanaryContent('chat', { choices: [{ text: 'legacy poem' }] }), 'legacy poem')
  assert.equal(extractCanaryContent('openai-compatible', { choices: [{ message: { content: 'poem' } }] }), 'poem')
  assert.equal(extractCanaryContent('claude', { content: [{ text: 'poem' }] }), 'poem')
})

test('classifies empty and reasoning-only canary responses without retaining content', () => {
  assert.deepEqual(diagnoseCanaryResponse('responses', ''), {
    ok: false,
    error: 'empty_body',
    diagnostics: { bodyBytes: 0 }
  })
  assert.equal(diagnoseCanaryResponse('responses', '<html>bad gateway</html>').error, 'invalid_json')
  assert.equal(diagnoseCanaryResponse('chat', JSON.stringify({ choices: [] })).error, 'missing_choices')
  assert.equal(diagnoseCanaryResponse('chat', JSON.stringify({ choices: [{ message: { content: null } }] })).error, 'content_null')
  const reasoning = diagnoseCanaryResponse('chat', JSON.stringify({
    choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'private chain of thought' } }],
    usage: { prompt_tokens: 20, completion_tokens: 512, completion_tokens_details: { reasoning_tokens: 512 } }
  }))
  assert.equal(reasoning.error, 'reasoning_only')
  assert.equal(reasoning.diagnostics.reasoningPresent, true)
  assert.equal(reasoning.diagnostics.usage.reasoningTokens, 512)
  assert.equal(JSON.stringify(reasoning).includes('private chain of thought'), false)
})

test('returns only low-sensitivity metadata for successful protocol responses', () => {
  const result = diagnoseCanaryResponse('claude', JSON.stringify({
    content: [{ type: 'text', text: '秋灯照卷夜初长，静听疏钟过短墙。' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 25, output_tokens: 20 }
  }))
  assert.equal(result.ok, true)
  assert.ok(result.contentLength >= 8)
  assert.equal(result.diagnostics.stopReason, 'end_turn')
  assert.deepEqual(result.diagnostics.contentTypes, ['text'])
  assert.equal(result.diagnostics.usage.outputTokens, 20)
  assert.equal(JSON.stringify(result).includes('秋灯'), false)
})

test('targets either the local or an explicitly configured remote gateway', () => {
  assert.equal(resolveCanaryUrl(undefined, 3000, '/v1/responses'), 'http://127.0.0.1:3000/v1/responses')
  assert.equal(resolveCanaryUrl('https://gateway.example.test', 3000, '/v1/messages'), 'https://gateway.example.test/v1/messages')
  assert.throws(() => resolveCanaryUrl('https://' + 'user:secret@gateway.example.test', 3000, '/v1/responses'), /clean http\(s\) URL/)
  assert.throws(() => resolveCanaryUrl('file:///tmp/gateway', 3000, '/v1/responses'), /clean http\(s\) URL/)
})
