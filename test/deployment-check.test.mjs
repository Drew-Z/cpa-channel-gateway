import assert from 'node:assert/strict'
import test from 'node:test'
import { runDeploymentCheck } from '../src/deployment-check.mjs'

test('checks persistent runtime, exact canary, and stream modes without returning secrets or bodies', async () => {
  const calls = []
  const fetchImpl = fixtureFetch(calls, {
    '/healthz': json({ ready: true }),
    '/admin/api/session:POST': json({ ok: true, csrfToken: 'fixture-csrf' }, { 'set-cookie': 'cpa_admin=fixture-cookie; Path=/admin; HttpOnly' }),
    '/admin/api/status': json(runtimeStatus()),
    '/admin/api/tests': json({ ok: true, statusCode: 200, protocol: 'responses', transport: 'native-passthrough', latencyMs: 12, contentLength: 24 }),
    '/v1/responses:non-stream': json({ output_text: '秋夜书声映短檠，寒窗月色照幽情。' }),
    '/v1/responses:stream': text('data: {"type":"response.output_text.delta","delta":"秋"}\n\ndata: [DONE]\n\n', 'text/event-stream'),
    '/admin/api/session:DELETE': json({ ok: true })
  })

  const result = await runDeploymentCheck({
    origin: 'https://gateway.example.test',
    managementKey: 'fixture-management-secret',
    gatewayKey: 'fixture-gateway-secret',
    canaryModel: 'free/model-a',
    businessModel: 'free/model-a',
    fetchImpl
  })

  assert.equal(result.runtime.controlStateStorage, 'persistent')
  assert.equal(result.canary.transport, 'native-passthrough')
  assert.equal(result.business.nonStream.statusCode, 200)
  assert.equal(result.business.stream.contentType, 'text/event-stream')
  const serialized = JSON.stringify(result)
  assert.doesNotMatch(serialized, /fixture-management-secret|fixture-gateway-secret|fixture-cookie|fixture-csrf|秋夜书声/)
  assert.equal(calls.at(-1).method, 'DELETE')
})

test('applies an explicitly approved pending revision before checks', async () => {
  const calls = []
  let statusCalls = 0
  const fetchImpl = fixtureFetch(calls, {
    '/healthz': json({ ready: true }),
    '/admin/api/session:POST': json({ ok: true, csrfToken: 'csrf' }, { 'set-cookie': 'cpa_admin=cookie' }),
    '/admin/api/status': () => json(runtimeStatus({ restartRequired: statusCalls++ === 0 })),
    '/admin/api/runtime/apply': json({ changed: true, active: { digest: 'release-b' } }),
    '/admin/api/session:DELETE': json({ ok: true })
  })

  const result = await runDeploymentCheck({
    origin: 'https://gateway.example.test',
    managementKey: 'management-secret',
    apply: true,
    fetchImpl
  })

  assert.equal(result.apply.changed, true)
  assert.equal(result.runtime.restartRequired, false)
  assert.ok(calls.some(call => call.pathname === '/admin/api/runtime/apply'))
})

test('refuses pending revisions and redacts server error bodies', async () => {
  const secretBody = 'Bearer private-token sk-private-value'
  const fetchImpl = fixtureFetch([], {
    '/healthz': json({ ready: true }),
    '/admin/api/session:POST': json({ ok: true, csrfToken: 'csrf' }, { 'set-cookie': 'cpa_admin=cookie' }),
    '/admin/api/status': json(runtimeStatus({ restartRequired: true })),
    '/admin/api/session:DELETE': text(secretBody, 'text/plain')
  })

  await assert.rejects(
    runDeploymentCheck({ origin: 'https://gateway.example.test', managementKey: 'secret', fetchImpl }),
    error => error.code === 'pending_revision' && !error.message.includes(secretBody)
  )
})

test('rejects a stream-shaped request that returns ordinary JSON', async () => {
  const fetchImpl = fixtureFetch([], {
    '/healthz': json({ ready: true }),
    '/admin/api/session:POST': json({ ok: true, csrfToken: 'csrf' }, { 'set-cookie': 'cpa_admin=cookie' }),
    '/admin/api/status': json(runtimeStatus()),
    '/v1/responses:non-stream': json({ output_text: '秋夜书声映短檠，寒窗月色照幽情。' }),
    '/v1/responses:stream': json({ output_text: 'not a stream' }),
    '/admin/api/session:DELETE': json({ ok: true })
  })

  await assert.rejects(
    runDeploymentCheck({
      origin: 'https://gateway.example.test',
      managementKey: 'management-secret',
      gatewayKey: 'gateway-secret',
      businessModel: 'free/model-a',
      fetchImpl
    }),
    error => error.code === 'business_stream_invalid'
  )
})

function runtimeStatus({ restartRequired = false } = {}) {
  return {
    ready: true,
    loadedRevision: 'revision-a',
    pendingRevision: restartRequired ? 'revision-b' : 'revision-a',
    restartRequired,
    runtime: { available: true, active: { digest: restartRequired ? 'release-a' : 'release-b' }, transitioning: false },
    controlState: { storage: 'persistent' }
  }
}

function fixtureFetch(calls, routes) {
  return async (url, options = {}) => {
    const target = new URL(url)
    const method = options.method ?? 'GET'
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push({ pathname: target.pathname, method, headers: options.headers, body })
    let key = `${target.pathname}:${method}`
    if (target.pathname === '/v1/responses') key = `${target.pathname}:${body?.stream ? 'stream' : 'non-stream'}`
    const route = routes[key] ?? routes[target.pathname]
    if (!route) throw new Error(`Missing fixture route: ${key}`)
    return typeof route === 'function' ? route() : route
  }
}

function json(value, headers = {}) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } })
}

function text(value, contentType) {
  return new Response(value, { status: 200, headers: { 'content-type': contentType } })
}
