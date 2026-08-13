import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCanaryRequest, extractCanaryContent } from '../src/canary.mjs'

test('builds meaningful canary requests for every supported client protocol', () => {
  const responses = buildCanaryRequest('responses', 'coding-main', 'write a poem')
  assert.equal(responses.path, '/v1/responses')
  assert.equal(responses.body.input, 'write a poem')
  const chat = buildCanaryRequest('chat', 'coding-fast', 'write a poem')
  assert.equal(chat.path, '/v1/chat/completions')
  assert.equal(chat.body.messages[0].content, 'write a poem')
  const claude = buildCanaryRequest('claude', 'claude-main', 'write a poem')
  assert.equal(claude.path, '/v1/messages')
  assert.equal(claude.body.messages[0].content, 'write a poem')
  assert.throws(() => buildCanaryRequest('invalid', 'model', 'prompt'), /Unsupported/)
})

test('extracts text without logging response bodies', () => {
  assert.equal(extractCanaryContent('responses', { output_text: 'poem' }), 'poem')
  assert.equal(extractCanaryContent('responses', { output: [{ content: [{ text: 'po' }, { text: 'em' }] }] }), 'poem')
  assert.equal(extractCanaryContent('chat', { choices: [{ message: { content: 'poem' } }] }), 'poem')
  assert.equal(extractCanaryContent('claude', { content: [{ text: 'poem' }] }), 'poem')
})
