import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createControlGateway } from '../src/control-gateway.mjs'
import { createControlState } from '../src/control-state.mjs'
import { hashClientKey } from '../src/client-access.mjs'

test('native Responses forwarding preserves reviewed client headers and replaces secrets', async t => {
  let captured
  const upstream = http.createServer(async (request, response) => {
    captured = {
      path: request.url,
      headers: request.headers,
      body: await jsonBody(request)
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      connection: 'close',
      'retry-after': '7',
      'set-cookie': 'cpa_admin=upstream-value; Path=/admin; Secure; HttpOnly'
    })
    response.write('data: {"type":"response.output_text.delta","delta":"秋"}\n\n')
    response.end('data: [DONE]\n\n')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))

  const gateway = createControlGateway(fixtureConfig(upstreamAddress.port))
  const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const result = await request({
    port: gatewayAddress.port,
    path: '/v1/responses',
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      cookie: 'private-cookie=must-not-leak',
      'x-forwarded-for': '203.0.113.10',
      'cf-ray': 'private-edge-value',
      'x-request-id': 'private phrase not safe',
      'user-agent': 'real-client/1.0',
      'openai-beta': 'responses=v1'
    },
    body: { model: 'coding-main', input: '写一首秋夜读书的七言绝句', stream: true }
  })

  assert.equal(result.statusCode, 200)
  assert.match(result.body, /response\.output_text\.delta/)
  assert.equal(captured.path, '/v1/responses')
  assert.equal(captured.body.model, 'shared-model')
  assert.equal(captured.headers.authorization, 'Bearer fixture-upstream-key')
  assert.equal(captured.headers['user-agent'], 'real-client/1.0')
  assert.equal(captured.headers['openai-beta'], 'responses=v1')
  assert.equal(captured.headers.cookie, undefined)
  assert.equal(captured.headers['x-forwarded-for'], undefined)
  assert.equal(captured.headers['cf-ray'], undefined)
  assert.match(captured.headers['x-request-id'], /^[a-f0-9-]{36}$/)
  assert.equal(result.headers['set-cookie'], undefined)
  assert.equal(result.headers['retry-after'], '7')
})

test('embeddings forward directly to the configured upstream with the native model id', async t => {
  let captured
  let upstreamCalls = 0
  const upstream = http.createServer(async (request, response) => {
    upstreamCalls += 1
    captured = {
      path: request.url,
      headers: request.headers,
      body: await jsonBody(request)
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [], model: captured.body.model }))
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))

  const config = fixtureConfig(19001)
  config.channels[0].upstream = new URL(`http://127.0.0.1:${upstreamAddress.port}/proxy/v1`)
  config.channels[0].protocol = 'openai-compatible'
  config.channels[0].models.push({
    upstream: 'text-embedding-3-small',
    protocol: 'openai-compatible',
    kind: 'embedding',
    aliases: ['free/text-embedding-3-small']
  })
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const result = await request({
    port: address.port,
    path: '/v1/embeddings?encoding_format=float',
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'user-agent': 'embedding-client/1.0' },
    body: { model: 'free/text-embedding-3-small', input: ['秋夜读书'] }
  })

  assert.equal(result.statusCode, 200)
  assert.equal(captured.path, '/proxy/v1/embeddings?encoding_format=float')
  assert.equal(captured.body.model, 'text-embedding-3-small')
  assert.equal(captured.body.input[0], '秋夜读书')
  assert.equal(captured.headers.authorization, 'Bearer fixture-upstream-key')
  assert.equal(captured.headers['user-agent'], 'embedding-client/1.0')
  const wrongChatEndpoint = await request({
    port: address.port,
    path: '/v1/chat/completions',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'free/text-embedding-3-small', messages: [{ role: 'user', content: 'wrong endpoint' }] }
  })
  const wrongEmbeddingEndpoint = await request({
    port: address.port,
    path: '/v1/embeddings',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'free/shared-model', input: 'wrong endpoint' }
  })
  assert.equal(wrongChatEndpoint.statusCode, 422)
  assert.equal(JSON.parse(wrongChatEndpoint.body).error.code, 'model_endpoint_mismatch')
  assert.equal(wrongEmbeddingEndpoint.statusCode, 422)
  assert.equal(JSON.parse(wrongEmbeddingEndpoint.body).error.code, 'model_endpoint_mismatch')
  assert.equal(upstreamCalls, 1)
  const usage = gateway.usageMonitor.snapshot()
  assert.equal(usage.physicalModels.find(item => item.id === 'free/text-embedding-3-small').total, 1)
})

test('records a 2xx outcome only after the complete upstream response ends', async t => {
  let releaseResponse
  let upstreamHeadersSent
  const headersSent = new Promise(resolve => { upstreamHeadersSent = resolve })
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"output_text":"partial')
    upstreamHeadersSent()
    releaseResponse = () => response.end('"}')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const gateway = createControlGateway(fixtureConfig(upstreamAddress.port))
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const pending = request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'complete response' }
  })
  await headersSent
  assert.equal(gateway.scheduler.snapshot().candidates['free\0shared-model\0responses'], undefined)
  releaseResponse()
  assert.equal((await pending).statusCode, 200)
  const evidence = gateway.scheduler.snapshot().candidates['free\0shared-model\0responses'].evidence
  assert.equal(evidence.sampleCount, 1)
  assert.equal(evidence.successCount, 1)
})

test('records a stream interruption as one transient failure', async t => {
  let upstreamHeadersSent
  const headersSent = new Promise(resolve => { upstreamHeadersSent = resolve })
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: partial\\n\\n')
    upstreamHeadersSent()
    setImmediate(() => response.destroy())
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const gateway = createControlGateway(fixtureConfig(upstreamAddress.port))
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const pending = request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'stream interruption', stream: true }
  })
  await headersSent
  await assert.rejects(pending)
  await waitFor(() => gateway.scheduler.snapshot().reservations.length === 0)
  const evidence = gateway.scheduler.snapshot().candidates['free\0shared-model\0responses'].evidence
  assert.equal(evidence.sampleCount, 1)
  assert.equal(evidence.failureCount, 1)
  assert.equal(evidence.consecutiveTransientFailures, 1)
})

test('production usage keeps an explicit logical group across upstream ids', async t => {
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"ok"}')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))

  const config = fixtureConfig(upstreamAddress.port)
  config.logicalModels = [{
    id: 'coding-pool',
    enabled: true,
    candidates: [{ channel: 'free', model: 'shared-model', enabled: true, priority: 10 }]
  }]
  config.stableAliases = [{ alias: 'coding-main', logicalModel: 'coding-pool' }]
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const result = await request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'coding-main', input: 'logical usage test' }
  })
  assert.equal(result.statusCode, 200)
  const usage = gateway.usageMonitor.snapshot()
  assert.deepEqual(usage.logicalModels.map(item => [item.id, item.total]), [['coding-pool', 1]])
  assert.equal(usage.physicalModels[0].id, 'free/shared-model')
})

test('rejects unsupported streaming mode before contacting the upstream', async t => {
  let upstreamCalls = 0
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"unexpected"}')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const config = fixtureConfig(upstreamAddress.port)
  config.channels[0].models[0].streaming = 'non-stream-only'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const result = await request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'coding-main', input: 'streaming request', stream: true }
  })
  assert.equal(result.statusCode, 422)
  assert.equal(JSON.parse(result.body).error.code, 'streaming_not_supported')
  assert.equal(upstreamCalls, 0)
  assert.equal(gateway.usageMonitor.snapshot().summary.failure, 1)
})

test('adapted traffic targets the exact CPA alias instead of another channel candidate', async t => {
  let captured
  const cpa = http.createServer(async (request, response) => {
    captured = { path: request.url, headers: request.headers, body: await jsonBody(request) }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"choices":[{"message":{"content":"ok"}}]}')
  })
  const cpaAddress = await listen(cpa)
  t.after(() => close(cpa))
  const config = fixtureConfig(19001)
  config.gateway.internal.cpaPort = cpaAddress.port
  config.channels[0].protocol = 'openai-compatible'
  config.channels[0].models[0].protocol = 'openai-compatible'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const result = await request({
    port: address.port,
    path: '/v1/responses?trace=1',
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'user-agent': 'real-client/1.0' },
    body: { model: 'shared-model', input: 'task' }
  })
  assert.equal(result.statusCode, 200)
  assert.equal(captured.path, '/v1/responses?trace=1')
  assert.equal(captured.body.model, 'free/shared-model')
  assert.equal(captured.headers.authorization, `Bearer ${GATEWAY_KEY}`)
  assert.equal(captured.headers['user-agent'], 'real-client/1.0')
})

test('adapted Chat Completions preserves non-stream and stream request semantics', async t => {
  const captures = []
  const cpa = http.createServer(async (request, response) => {
    captures.push({ path: request.url, headers: request.headers, body: await jsonBody(request) })
    response.writeHead(200, { 'content-type': captures.length === 1 ? 'application/json' : 'text/event-stream', connection: 'close' })
    if (captures.length === 1) response.end('{"choices":[{"message":{"content":"ok"}}]}')
    else response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n')
  })
  const cpaAddress = await listen(cpa)
  t.after(() => close(cpa))
  const config = fixtureConfig(19001)
  config.gateway.internal.cpaPort = cpaAddress.port
  config.channels[0].protocol = 'openai-compatible'
  config.channels[0].models[0].protocol = 'openai-compatible'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const nonStream = await request({ port: address.port, path: '/v1/chat/completions', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: { model: 'shared-model', messages: [{ role: 'user', content: 'task' }], stream: false } })
  const stream = await request({ port: address.port, path: '/v1/chat/completions', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: { model: 'shared-model', messages: [{ role: 'user', content: 'task' }], stream: true } })
  assert.equal(nonStream.statusCode, 200)
  assert.equal(stream.statusCode, 200)
  assert.equal(captures[0].path, '/v1/chat/completions')
  assert.equal(captures[0].body.stream, false)
  assert.equal(captures[1].body.stream, true)
  assert.equal(captures[0].body.model, 'free/shared-model')
})

test('adapted Claude Messages replaces credentials and preserves response headers', async t => {
  let captured
  const cpa = http.createServer(async (request, response) => {
    captured = { path: request.url, headers: request.headers, body: await jsonBody(request) }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close', 'x-upstream-trace': 'safe' })
    response.end('{"content":[{"type":"text","text":"ok"}]}')
  })
  const cpaAddress = await listen(cpa)
  t.after(() => close(cpa))
  const config = fixtureConfig(19001)
  config.gateway.internal.cpaPort = cpaAddress.port
  config.channels[0].protocol = 'claude'
  config.channels[0].models[0].protocol = 'claude'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const result = await request({
    port: address.port,
    path: '/v1/messages',
    headers: { authorization: `Bearer ${GATEWAY_KEY}`, 'x-api-key': 'client-secret', connection: 'x-remove-me', 'x-remove-me': 'private' },
    body: { model: 'shared-model', messages: [{ role: 'user', content: 'task' }], stream: false }
  })
  assert.equal(result.statusCode, 200)
  assert.equal(result.headers['x-upstream-trace'], 'safe')
  assert.equal(captured.path, '/v1/messages')
  assert.equal(captured.body.model, 'free/shared-model')
  assert.equal(captured.headers.authorization, `Bearer ${GATEWAY_KEY}`)
  assert.equal(captured.headers['x-api-key'], undefined)
  assert.equal(captured.headers['x-remove-me'], undefined)
})

test('busy channels return 429 without creating another upstream request', async t => {
  let upstreamCalls = 0
  let releaseFirst
  let firstArrived
  const firstArrival = new Promise(resolve => { firstArrived = resolve })
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1
    request.resume()
    if (upstreamCalls === 1) {
      firstArrived()
      releaseFirst = () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"output_text":"ok"}')
      }
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"output_text":"ok"}')
    }
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const gateway = createControlGateway(fixtureConfig(upstreamAddress.port))
  const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const firstRequest = request({
    port: gatewayAddress.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'first' }
  })
  await firstArrival
  const busy = await request({
    port: gatewayAddress.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'second' }
  })
  assert.equal(busy.statusCode, 429)
  assert.equal(JSON.parse(busy.body).error.code, 'all_candidates_busy')
  assert.equal(busy.headers['retry-after'], '1')
  assert.equal(upstreamCalls, 1)
  releaseFirst()
  assert.equal((await firstRequest).statusCode, 200)
  const afterRelease = await request({
    port: gatewayAddress.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'third' }
  })
  assert.equal(afterRelease.statusCode, 200)
  assert.equal(upstreamCalls, 2)
  const usage = gateway.usageMonitor.snapshot()
  assert.equal(usage.summary.total, 3)
  assert.equal(usage.summary.success, 2)
  assert.equal(usage.summary.failure, 1)
  assert.equal(usage.summary.successRate, 66.67)
  assert.equal(usage.logicalModels[0].total, 3)
  assert.equal(usage.physicalModels[0].total, 2)
})

test('client disconnect releases the channel reservation', async t => {
  let upstreamCalls = 0
  let firstArrived
  const firstArrival = new Promise(resolve => { firstArrived = resolve })
  const upstream = http.createServer((request, response) => {
    upstreamCalls += 1
    request.resume()
    if (upstreamCalls === 1) {
      firstArrived()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"ok"}')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const gateway = createControlGateway(fixtureConfig(upstreamAddress.port))
  const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const payload = Buffer.from(JSON.stringify({ model: 'shared-model', input: 'disconnect' }))
  const abandoned = http.request({
    host: '127.0.0.1',
    port: gatewayAddress.port,
    method: 'POST',
    path: '/v1/responses',
    headers: {
      authorization: `Bearer ${GATEWAY_KEY}`,
      'content-type': 'application/json',
      'content-length': String(payload.length)
    }
  })
  abandoned.on('error', () => {})
  abandoned.end(payload)
  await firstArrival
  abandoned.destroy()
  await waitFor(() => gateway.scheduler.snapshot().reservations.length === 0)

  const afterDisconnect = await request({
    port: gatewayAddress.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'after-disconnect' }
  })
  assert.equal(afterDisconnect.statusCode, 200)
  assert.equal(upstreamCalls, 2)
  const usage = gateway.usageMonitor.snapshot()
  assert.equal(usage.summary.total, 2)
  assert.equal(usage.summary.success, 1)
  assert.equal(usage.summary.cancelled, 1)
})

test('an upstream transport failure is not replayed on another candidate', async t => {
  let preferredCalls = 0
  let alternateCalls = 0
  const preferred = http.createServer(request => {
    preferredCalls += 1
    request.resume()
    request.socket.destroy()
  })
  const alternate = http.createServer((request, response) => {
    alternateCalls += 1
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"alternate"}')
  })
  const preferredAddress = await listen(preferred)
  const alternateAddress = await listen(alternate)
  t.after(() => close(preferred))
  t.after(() => close(alternate))
  const config = fixtureConfig(preferredAddress.port)
  const alternateChannel = {
    ...config.channels[0],
    id: 'backup',
    name: 'Backup',
    listener: alternateAddress.port,
    priority: 10,
    apiKey: 'fixture-backup-key',
    upstream: new URL('https://backup.example.test/v1'),
    models: [{
      ...config.channels[0].models[0],
      aliases: ['backup/shared-model'],
      priority: 10
    }]
  }
  config.channels.push(alternateChannel)
  const gateway = createControlGateway(config)
  const gatewayAddress = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const result = await request({
    port: gatewayAddress.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'single-attempt' }
  })
  assert.equal(result.statusCode, 502)
  assert.equal(preferredCalls, 1)
  assert.equal(alternateCalls, 0)
  const evidence = gateway.scheduler.snapshot().candidates['free\0shared-model\0responses'].evidence
  assert.equal(evidence.sampleCount, 1)
  assert.equal(evidence.failureCount, 1)
})

test('models endpoint exposes logical, stable, and direct ids', async t => {
  const config = fixtureConfig(19001)
  config.channels[0].models.push({
    upstream: 'text-embedding-3-small',
    protocol: 'openai-compatible',
    kind: 'embedding',
    aliases: ['free/text-embedding-3-small']
  })
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const result = await request({
    port: address.port,
    method: 'GET',
    path: '/v1/models',
    headers: { 'x-api-key': GATEWAY_KEY }
  })
  assert.equal(result.statusCode, 200)
  const models = JSON.parse(result.body).data
  const ids = models.map(item => item.id)
  assert.deepEqual(ids, ['coding-main', 'free/shared-model', 'free/text-embedding-3-small', 'shared-model'])
  assert.deepEqual(models.find(item => item.id === 'free/text-embedding-3-small').endpoints, ['/v1/embeddings'])
  assert.equal(models.find(item => item.id === 'free/text-embedding-3-small').kind, 'embedding')
  assert.doesNotMatch(result.body, /upstream\.example\.test/)
})

test('channel updates enter drain mode before the pending restart', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const configManager = {
    status: () => ({ revision: 'pending-revision', restartRequired: true }),
    routing: () => ({
      channels: [{
        id: 'free',
        name: 'Pending Free',
        baseUrl: 'https://pending.example.test/v1',
        enabled: false,
        staged: false,
        runtimeEnabled: false,
        protocol: 'claude',
        priority: 42,
        modelCount: 1,
        hasApiKey: true
      }],
      stableAliases: config.stableAliases,
      pinnedAliases: [],
      models: []
    }),
    updateChannel: id => ({ id, name: 'Free', enabled: false, staged: false, priority: 100, modelCount: 1 })
  }
  const gateway = createControlGateway(config, { configManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }

  const update = await request({ port: address.port, method: 'PATCH', path: '/admin/api/channels/free', headers, body: { enabled: false } })
  assert.equal(update.statusCode, 202)
  assert.equal(JSON.parse(update.body).enabled, false)
  assert.throws(() => gateway.scheduler.reserve('shared-model'), error => error.code === 'no_eligible_candidates')

  const status = JSON.parse((await request({ port: address.port, method: 'GET', path: '/admin/api/status', headers: { cookie } })).body)
  assert.deepEqual(status.draining, ['free'])
  assert.equal(status.channels[0].draining, true)
  assert.equal(status.channels[0].name, 'Pending Free')
  assert.equal(status.channels[0].protocol, 'claude')
  assert.equal(status.channels[0].priority, 42)
  assert.equal(status.channels[0].hasApiKey, true)
  assert.doesNotMatch(JSON.stringify(status.channels[0]), /fixture-upstream-key/)
  assert.equal(status.controlJobs.recent.at(-1).type, 'channel-update')
  assert.equal(status.controlJobs.recent.at(-1).status, 'completed')
})

test('reloadConfig switches public routing to the new validated catalog', async t => {
  const config = fixtureConfig(19001)
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const next = fixtureConfig(19001)
  next.channels[0].models[0].upstream = 'new-model'
  next.channels[0].models[0].aliases = ['free/new-model']
  next.stableAliases = [{ alias: 'coding-main', channel: 'free', model: 'new-model' }]

  const switched = gateway.reloadConfig(next)
  assert.equal(switched.configRevision, null)
  const models = await request({ port: address.port, path: '/v1/models', method: 'GET', headers: { authorization: `Bearer ${GATEWAY_KEY}` } })
  const ids = JSON.parse(models.body).data.map(item => item.id)
  assert.ok(ids.includes('new-model'))
  assert.ok(!ids.includes('shared-model'))
  assert.equal(gateway.scheduler.catalog.resolve('shared-model'), null)
})

test('reloadConfig restores the previous catalog and revision when validation fails', async t => {
  const config = fixtureConfig(19001)
  config.digest = 'release-a'
  const controlState = createControlState(config)
  const gateway = createControlGateway(config, { controlState })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const invalid = { ...config, digest: 'release-b', channels: null }
  assert.throws(() => gateway.reloadConfig(invalid))
  assert.ok(gateway.scheduler.catalog.resolve('shared-model'))
  assert.equal(controlState.status().configRevision, 'release-a')
})

test('reloadConfig retains canary cooldowns only for models still in the catalog', async t => {
  let canaryCount = 0
  const upstream = http.createServer((request, response) => {
    request.resume()
    canaryCount += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"秋夜读书灯映寒窗"}')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const config = fixtureConfig(upstreamAddress.port)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }
  const testModel = model => request({ port: address.port, path: '/admin/api/tests', headers, body: { model } })

  assert.equal((await testModel('free/shared-model')).statusCode, 200)
  gateway.reloadConfig({ ...config, digest: 'same-model-release' })
  assert.equal((await testModel('free/shared-model')).statusCode, 429)

  const replacement = fixtureConfig(upstreamAddress.port)
  replacement.managementKey = config.managementKey
  replacement.digest = 'replacement-release'
  replacement.channels[0].models[0].upstream = 'replacement-model'
  replacement.channels[0].models[0].aliases = ['free/replacement-model']
  replacement.stableAliases = [{ alias: 'coding-main', channel: 'free', model: 'replacement-model' }]
  gateway.reloadConfig(replacement)
  assert.equal((await testModel('free/replacement-model')).statusCode, 200)
  const restored = fixtureConfig(upstreamAddress.port)
  restored.managementKey = config.managementKey
  restored.digest = 'restored-release'
  gateway.reloadConfig(restored)
  assert.equal((await testModel('free/shared-model')).statusCode, 200)
  assert.equal(canaryCount, 3)
})

test('reloadConfig updates the adapted CPA target and request limit', async t => {
  const responses = []
  const cpaOne = http.createServer((request, response) => {
    request.resume()
    responses.push('one')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"one"}')
  })
  const cpaTwo = http.createServer((request, response) => {
    request.resume()
    responses.push('two')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"two"}')
  })
  const firstAddress = await listen(cpaOne)
  const secondAddress = await listen(cpaTwo)
  t.after(() => close(cpaOne))
  t.after(() => close(cpaTwo))

  const config = fixtureConfig(19001)
  config.channels[0].protocol = 'openai-compatible'
  config.channels[0].models[0].protocol = 'openai-compatible'
  config.gateway.internal.cpaPort = firstAddress.port
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const first = await request({ port: address.port, path: '/v1/responses', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: { model: 'shared-model', input: 'first' } })
  assert.equal(first.statusCode, 200)
  assert.deepEqual(responses, ['one'])

  gateway.reloadConfig({
    ...config,
    gateway: { ...config.gateway, internal: { ...config.gateway.internal, cpaPort: secondAddress.port } }
  })
  const second = await request({ port: address.port, path: '/v1/responses', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: { model: 'shared-model', input: 'second' } })
  assert.equal(second.statusCode, 200)
  assert.deepEqual(responses, ['one', 'two'])

  gateway.reloadConfig({
    ...config,
    gateway: { ...config.gateway, internal: { ...config.gateway.internal, cpaPort: secondAddress.port }, control: { ...config.gateway.control, maxRequestBytes: 64 } }
  })
  const oversized = await request({ port: address.port, path: '/v1/responses', headers: { authorization: `Bearer ${GATEWAY_KEY}` }, body: { model: 'shared-model', input: 'x'.repeat(200) } })
  assert.equal(oversized.statusCode, 413)
})

test('reloadConfig can defer the loaded revision until active release commit', () => {
  const config = fixtureConfig(19001)
  config.digest = 'release-a'
  let loadedRevision = 'release-a'
  let marks = 0
  let markedRelease = null
  const configManager = {
    status: () => ({ revision: 'release-b', loadedRevision, restartRequired: loadedRevision !== 'release-b' }),
    markApplied: releaseDigest => { marks += 1; markedRelease = releaseDigest; loadedRevision = 'release-b' }
  }
  const gateway = createControlGateway(config, { configManager })
  const next = { ...config, digest: 'release-b' }

  gateway.reloadConfig(next, { markApplied: false })
  assert.equal(marks, 0)
  assert.equal(configManager.status().restartRequired, true)
  gateway.markConfigApplied()
  assert.equal(marks, 1)
  assert.equal(markedRelease, 'release-b')
  assert.equal(configManager.status().restartRequired, false)
})

test('runtime apply is a CSRF-protected serialized admin operation', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  let applies = 0
  const runtimeManager = {
    status: () => ({ active: { digest: 'release-a', childCount: 2 }, transitioning: false, available: true }),
    apply: async () => ({ changed: ++applies > 0, release: 'release-b' })
  }
  const gateway = createControlGateway(config, { runtimeManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }
  const missingCsrf = await request({ port: address.port, path: '/admin/api/runtime/apply', headers: { cookie }, body: {} })
  assert.equal(missingCsrf.statusCode, 403)
  const applied = await request({ port: address.port, path: '/admin/api/runtime/apply', headers, body: {} })
  assert.equal(applied.statusCode, 200)
  assert.equal(JSON.parse(applied.body).release, 'release-b')
  assert.equal(applies, 1)
  const status = JSON.parse((await request({ port: address.port, method: 'GET', path: '/admin/api/status', headers: { cookie } })).body)
  assert.equal(status.runtime.active.digest, 'release-a')
  assert.equal(status.controlJobs.recent.at(-1).type, 'runtime-apply')
})

test('restores persisted health and canary summaries into the admin status', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-control-restore-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const config = fixtureConfig(19001)
  config.digest = 'fixture-release'
  config.paths = { routesPath: path.join(root, 'config', 'routes.local.json') }
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const timestamp = Date.now()
  const persisted = createControlState(config, { now: () => timestamp })
  persisted.replaceSchedulerState({
    channels: { free: { health: 'auth-failed', updatedAt: timestamp } }
  })
  persisted.rememberTest('free/shared-model', {
    ok: false,
    status: 'failed',
    error: 'authentication_failed',
    statusCode: 401,
    protocol: 'responses',
    transport: 'native-passthrough',
    latencyMs: 12,
    testedAt: new Date(timestamp).toISOString()
  })

  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({
    port: address.port,
    path: '/admin/api/session',
    body: { key: config.managementKey }
  })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const status = JSON.parse((await request({
    port: address.port,
    method: 'GET',
    path: '/admin/api/status',
    headers: { cookie }
  })).body)

  assert.equal(status.channels[0].health, 'auth-failed')
  assert.equal(status.lastTests['free/shared-model'].error, 'authentication_failed')
  assert.equal(status.controlState.storage, 'persistent')
  const blocked = await request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'shared-model', input: 'must not reach upstream' }
  })
  assert.equal(blocked.statusCode, 503)
})

test('admin session protects status and runs a redacted exact-model canary', async t => {
  let upstreamBody
  const upstream = http.createServer(async (request, response) => {
    upstreamBody = await jsonBody(request)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"output_text":"秋夜读书灯映寒窗"}')
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const config = fixtureConfig(upstreamAddress.port)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const unauthorized = await request({ port: address.port, method: 'GET', path: '/admin/api/status' })
  assert.equal(unauthorized.statusCode, 401)

  const login = await request({
    port: address.port,
    path: '/admin/api/session',
    body: { key: config.managementKey }
  })
  assert.equal(login.statusCode, 200)
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken

  const session = await request({ port: address.port, method: 'GET', path: '/admin/api/session', headers: { cookie } })
  assert.equal(session.statusCode, 200)
  assert.equal(JSON.parse(session.body).csrfToken, csrf)

  const status = await request({ port: address.port, method: 'GET', path: '/admin/api/status', headers: { cookie } })
  assert.equal(status.statusCode, 200)
  assert.equal(status.headers['cache-control'], 'no-store')
  const adminStatus = JSON.parse(status.body)
  assert.equal(adminStatus.channels[0].baseUrl, 'https://upstream.example.test/v1')
  assert.equal(adminStatus.channels[0].protocol, 'responses')
  assert.equal(adminStatus.channels[0].priority, 100)
  assert.equal(adminStatus.channels[0].hasApiKey, true)
  assert.doesNotMatch(status.body, /fixture-upstream-key/)

  const missingCsrf = await request({
    port: address.port,
    path: '/admin/api/tests',
    headers: { cookie, origin: `http://127.0.0.1:${address.port}` },
    body: { model: 'free/shared-model' }
  })
  assert.equal(missingCsrf.statusCode, 403)

  const tested = await request({
    port: address.port,
    path: '/admin/api/tests',
    headers: { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf },
    body: { model: 'free/shared-model' }
  })
  assert.equal(tested.statusCode, 200)
  const summary = JSON.parse(tested.body)
  assert.equal(summary.ok, true)
  assert.equal(summary.transport, 'native-passthrough')
  assert.equal(summary.contentLength, 8)
  assert.equal(summary.content, undefined)
  assert.equal(upstreamBody.model, 'shared-model')
  assert.match(upstreamBody.input, /秋夜读书/)
  const canaryEvidence = gateway.scheduler.snapshot().candidates['free\0shared-model\0responses'].evidence
  assert.equal(canaryEvidence.sampleCount, 1)
  assert.equal(canaryEvidence.successCount, 1)
  const modelGroups = JSON.parse((await request({ port: address.port, method: 'GET', path: '/admin/api/models', headers: { cookie } })).body).data
  const adminCandidate = modelGroups.flatMap(group => group.candidates).find(candidate => candidate.directId === 'free/shared-model')
  assert.deepEqual(Object.keys(adminCandidate.scheduling.evidence).sort(), [
    'circuit',
    'consecutiveTransientFailures',
    'cooldownUntil',
    'ewmaLatencyMs',
    'failureCount',
    'sampleCount',
    'successCount',
    'successRate'
  ])
  assert.equal(adminCandidate.scheduling.evidence.sampleCount, 1)
  assert.deepEqual(adminCandidate.scheduling.reasonCodes, ['candidate-ready'])
  assert.doesNotMatch(JSON.stringify(adminCandidate), /upstream\.example\.test|fixture-upstream-key|秋夜读书/)

  const beforeUsage = await request({ port: address.port, method: 'GET', path: '/admin/api/usage', headers: { cookie } })
  assert.equal(beforeUsage.statusCode, 200)
  assert.equal(JSON.parse(beforeUsage.body).summary.total, 0)

  const production = await request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'coding-main', input: 'real business request' }
  })
  assert.equal(production.statusCode, 200)

  const usageResult = await request({ port: address.port, method: 'GET', path: '/admin/api/usage', headers: { cookie } })
  const usage = JSON.parse(usageResult.body)
  assert.equal(usage.summary.total, 1)
  assert.equal(usage.summary.success, 1)
  assert.equal(usage.models[0].id, 'coding-main')
  assert.equal(usage.logicalModels[0].id, 'shared-model')
  assert.equal(usage.physicalModels[0].id, 'free/shared-model')

  const unknownModel = await request({
    port: address.port,
    path: '/v1/responses',
    headers: { authorization: `Bearer ${GATEWAY_KEY}` },
    body: { model: 'unknown-model', input: 'invalid route' }
  })
  assert.equal(unknownModel.statusCode, 404)
  assert.equal(gateway.usageMonitor.snapshot().summary.total, 1)

  const logicalRejected = await request({
    port: address.port,
    path: '/admin/api/tests',
    headers: { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf },
    body: { model: 'shared-model' }
  })
  assert.equal(logicalRejected.statusCode, 400)
  assert.equal(JSON.parse(logicalRejected.body).error.code, 'exact_model_required')
})

test('admin canary can probe a protocol override and apply it only after success', async t => {
  let captured
  const upstream = http.createServer(async (request, response) => {
    captured = { path: request.url, body: await jsonBody(request), headers: request.headers }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(request.url.endsWith('/messages')
      ? JSON.stringify({ content: [{ type: 'text', text: '秋夜读书灯映寒窗' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 8 } })
      : JSON.stringify({ choices: [{ message: { content: '秋夜读书灯映寒窗' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const config = fixtureConfig(upstreamAddress.port)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const calls = []
  const configManager = {
    status: () => ({ revision: 'loaded', loadedRevision: 'loaded', restartRequired: false }),
    updateModelProtocol: (channel, model, protocol) => { calls.push({ scope: 'model', channel, model, protocol }); return { revision: 'pending-model-protocol', restartRequired: true } }
  }
  const gateway = createControlGateway(config, { configManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }

  const tested = await request({ port: address.port, path: '/admin/api/tests', headers, body: { model: 'free/shared-model', protocolOverride: 'openai-compatible' } })
  assert.equal(tested.statusCode, 200)
  const summary = JSON.parse(tested.body)
  assert.equal(summary.ok, true)
  assert.equal(summary.protocol, 'openai-compatible')
  assert.equal(summary.configuredProtocol, 'responses')
  assert.equal(summary.transport, 'protocol-direct')
  assert.equal(captured.path, '/v1/chat/completions')
  assert.equal(captured.body.messages[0].content.includes('四句七言绝句'), true)
  assert.equal(captured.headers.authorization, 'Bearer fixture-upstream-key')

  const anthropic = await request({ port: address.port, path: '/admin/api/tests', headers, body: { model: 'free/shared-model', protocolOverride: 'claude' } })
  assert.equal(JSON.parse(anthropic.body).ok, true)
  assert.equal(captured.path, '/v1/messages')
  assert.equal(captured.headers['x-api-key'], 'fixture-upstream-key')
  assert.equal(captured.headers['anthropic-version'], '2023-06-01')
  assert.equal(gateway.scheduler.snapshot().candidates['free\\0shared-model\\0responses']?.evidence?.sampleCount ?? 0, 0)

  const applied = await request({
    port: address.port,
    path: '/admin/api/protocols/apply',
    headers,
    body: { scope: 'model', channel: 'free', model: 'shared-model', protocol: 'openai-compatible', confirmTarget: 'free/shared-model', confirmProtocol: 'openai-compatible' }
  })
  assert.equal(applied.statusCode, 202)
  assert.deepEqual(calls, [{ scope: 'model', channel: 'free', model: 'shared-model', protocol: 'openai-compatible' }])

  const channelScope = await request({
    port: address.port,
    path: '/admin/api/protocols/apply',
    headers,
    body: { scope: 'channel', channel: 'free', model: 'shared-model', protocol: 'claude', confirmTarget: 'free', confirmProtocol: 'claude' }
  })
  assert.equal(channelScope.statusCode, 409)
  assert.equal(JSON.parse(channelScope.body).error.code, 'channel_protocol_scope_not_supported')
  assert.deepEqual(calls, [{ scope: 'model', channel: 'free', model: 'shared-model', protocol: 'openai-compatible' }])
})

test('admin can explicitly apply a protocol to an exact non-generation model without a generation canary', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  config.channels[0].models.push({
    upstream: 'text-embedding-3-small',
    protocol: 'responses',
    kind: 'embedding',
    aliases: ['free/text-embedding-3-small']
  })
  const calls = []
  const configManager = {
    status: () => ({ revision: 'loaded', loadedRevision: 'loaded', restartRequired: false }),
    updateModelProtocol: (channel, model, protocol) => {
      calls.push({ channel, model, protocol })
      return { revision: 'pending-embedding-protocol', restartRequired: true }
    }
  }
  const gateway = createControlGateway(config, { configManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }
  const body = {
    scope: 'model',
    channel: 'free',
    model: 'text-embedding-3-small',
    protocol: 'openai-compatible',
    confirmTarget: 'free/text-embedding-3-small',
    confirmProtocol: 'openai-compatible'
  }

  const unconfirmed = await request({ port: address.port, path: '/admin/api/protocols/apply', headers, body })
  assert.equal(unconfirmed.statusCode, 400)
  assert.equal(JSON.parse(unconfirmed.body).error.code, 'non_generation_protocol_confirmation_required')

  const applied = await request({
    port: address.port,
    path: '/admin/api/protocols/apply',
    headers,
    body: { ...body, confirmNonGeneration: true }
  })
  assert.equal(applied.statusCode, 202)
  assert.deepEqual(calls, [{ channel: 'free', model: 'text-embedding-3-small', protocol: 'openai-compatible' }])
})

test('a 2xx canary without final content records candidate failure instead of success', async t => {
  const upstream = http.createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'incomplete', output: [{ type: 'reasoning', summary: [] }], usage: { output_tokens: 512 } }))
  })
  const upstreamAddress = await listen(upstream)
  t.after(() => close(upstream))
  const config = fixtureConfig(upstreamAddress.port)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const tested = await request({
    port: address.port,
    path: '/admin/api/tests',
    headers: { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf },
    body: { model: 'free/shared-model' }
  })
  const summary = JSON.parse(tested.body)
  assert.equal(summary.ok, false)
  assert.equal(summary.error, 'reasoning_only')
  assert.equal(summary.diagnostics.outputItemTypes[0], 'reasoning')
  const evidence = gateway.scheduler.snapshot().candidates['free\0shared-model\0responses'].evidence
  assert.equal(evidence.sampleCount, 1)
  assert.equal(evidence.successCount, 0)
  assert.equal(evidence.failureCount, 1)
})

test('admin API updates model status and stable aliases through the private config manager', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const calls = []
  const configManager = {
    status: () => ({ revision: 'pending-revision', restartRequired: true }),
    routing: () => ({
      stableAliases: [{ alias: 'coding-main', channel: 'free', model: 'shared-model' }],
      pinnedAliases: [],
      logicalModels: [{ id: 'coding-pool', enabled: true, candidates: [{ channel: 'free', model: 'shared-model', enabled: true, priority: 10 }] }],
      models: [
        { channel: 'free', model: 'shared-model', status: 'disabled' },
        { channel: 'future', model: 'pending-model', protocol: 'responses', kind: 'generation', streaming: 'both', canaryEligible: true, staged: true, channelEnabled: false, status: 'active' }
      ]
    }),
    updateModelStatus: (channel, model, status) => {
      calls.push({ operation: 'model', channel, model, status })
      return { channel, model, status, revision: 'next-model-revision', restartRequired: true }
    },
    setStableAlias: (alias, target) => {
      calls.push({ operation: 'alias', alias, target })
      return { alias, ...target, revision: 'next-alias-revision', restartRequired: true }
    },
    createLogicalModel: body => {
      calls.push({ operation: 'logical-create', body })
      return { ...body, revision: 'logical-create-revision', restartRequired: true }
    },
    updateLogicalModel: (id, body) => {
      calls.push({ operation: 'logical-update', id, body })
      return { id, ...body, revision: 'logical-update-revision', restartRequired: true }
    },
    deleteLogicalModel: id => {
      calls.push({ operation: 'logical-delete', id })
      return { id, deleted: true, revision: 'logical-delete-revision', restartRequired: true }
    }
  }
  const gateway = createControlGateway(config, { configManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }

  const status = await request({ port: address.port, method: 'GET', path: '/admin/api/status', headers: { cookie } })
  assert.equal(JSON.parse(status.body).stableAliases[0].alias, 'coding-main')
  assert.equal(JSON.parse(status.body).logicalModels[0].id, 'coding-pool')
  const connection = await request({ port: address.port, method: 'GET', path: '/admin/api/connection', headers: { cookie } })
  const connectionData = JSON.parse(connection.body)
  assert.equal(connection.statusCode, 200)
  assert.equal(connectionData.baseUrl, `http://127.0.0.1:${address.port}/v1`)
  assert.equal(connectionData.apiKey, undefined)
  assert.match(connectionData.apiKeyMasked, /^fixt\*+3456$/)
  const ignoredReveal = await request({ port: address.port, method: 'GET', path: '/admin/api/connection?reveal=1', headers: { cookie } })
  assert.equal(JSON.parse(ignoredReveal.body).apiKey, undefined)
  const rejectedReveal = await request({ port: address.port, path: '/admin/api/connection/reveal', headers: { cookie }, body: {} })
  assert.equal(rejectedReveal.statusCode, 403)
  const revealedConnection = await request({ port: address.port, path: '/admin/api/connection/reveal', headers, body: {} })
  assert.equal(JSON.parse(revealedConnection.body).apiKey, GATEWAY_KEY)
  const models = await request({ port: address.port, method: 'GET', path: '/admin/api/models', headers: { cookie } })
  const modelGroups = JSON.parse(models.body).data
  assert.equal(modelGroups.find(group => group.id === 'shared-model').candidates[0].status, 'disabled')
  assert.equal(modelGroups.find(group => group.id === 'pending-model').candidates[0].directId, 'future/pending-model')

  const blockedTest = await request({
    port: address.port,
    path: '/admin/api/tests',
    headers,
    body: { model: 'free/shared-model' }
  })
  assert.equal(blockedTest.statusCode, 409)
  assert.equal(JSON.parse(blockedTest.body).error.code, 'restart_required')

  const modelUpdate = await request({
    port: address.port,
    method: 'PATCH',
    path: '/admin/api/models',
    headers,
    body: { channel: 'free', model: 'shared-model', status: 'active' }
  })
  assert.equal(modelUpdate.statusCode, 202)
  const aliasUpdate = await request({
    port: address.port,
    method: 'PUT',
    path: '/admin/api/stable-aliases',
    headers,
    body: { alias: 'coding-backup', channel: 'free', model: 'shared-model' }
  })
  assert.equal(aliasUpdate.statusCode, 202)
  const logicalCreate = await request({
    port: address.port,
    path: '/admin/api/logical-models',
    headers,
    body: { id: 'merged-coding', candidates: [{ channel: 'free', model: 'shared-model', enabled: true, priority: 10 }] }
  })
  assert.equal(logicalCreate.statusCode, 202)
  const logicalUpdate = await request({
    port: address.port,
    method: 'PATCH',
    path: '/admin/api/logical-models/merged-coding',
    headers,
    body: { enabled: false }
  })
  assert.equal(logicalUpdate.statusCode, 202)
  const logicalAlias = await request({
    port: address.port,
    method: 'PUT',
    path: '/admin/api/stable-aliases',
    headers,
    body: { alias: 'coding-main', logicalModel: 'coding-pool' }
  })
  assert.equal(logicalAlias.statusCode, 202)
  const logicalDelete = await request({
    port: address.port,
    method: 'DELETE',
    path: '/admin/api/logical-models/merged-coding',
    headers
  })
  assert.equal(logicalDelete.statusCode, 202)
  assert.deepEqual(calls, [
    { operation: 'model', channel: 'free', model: 'shared-model', status: 'active' },
    { operation: 'alias', alias: 'coding-backup', target: { channel: 'free', model: 'shared-model' } },
    { operation: 'logical-create', body: { id: 'merged-coding', candidates: [{ channel: 'free', model: 'shared-model', enabled: true, priority: 10 }] } },
    { operation: 'logical-update', id: 'merged-coding', body: { enabled: false } },
    { operation: 'alias', alias: 'coding-main', target: { logicalModel: 'coding-pool' } },
    { operation: 'logical-delete', id: 'merged-coding' }
  ])
})

test('admin client access API manages groups and one-time keys without returning hashes', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const calls = []
  const configManager = {
    status: () => ({ revision: 'revision-a', loadedRevision: 'revision-a', pendingRevision: 'revision-a', restartRequired: false }),
    routing: () => ({ stableAliases: [], pinnedAliases: [], logicalModels: [], models: [] }),
    access: () => ({ enabled: true, groups: [{ id: 'enterprise', channels: ['free'], enabled: true }], clients: [{ id: 'doc-agent', group: 'enterprise', enabled: true, keyHint: 'abc123' }] }),
    createClientGroup: body => { calls.push(['group-create', body]); return { id: body.id, channels: body.channels, enabled: true, revision: 'revision-b' } },
    updateClientGroup: (id, body) => { calls.push(['group-update', id, body]); return { id, ...body, revision: 'revision-c' } },
    deleteClientGroup: id => { calls.push(['group-delete', id]); return { id, deleted: true, revision: 'revision-d' } },
    createClient: body => { calls.push(['client-create', body]); return { id: body.id, group: body.group, key: 'cpa_one_time_secret', revision: 'revision-e' } },
    rotateClient: id => { calls.push(['client-rotate', id]); return { id, key: 'cpa_rotated_one_time_secret', revision: 'revision-f' } },
    updateClient: (id, body) => { calls.push(['client-update', id, body]); return { id, ...body, revision: 'revision-g' } },
    deleteClient: id => { calls.push(['client-delete', id]); return { id, deleted: true, revision: 'revision-h' } }
  }
  const gateway = createControlGateway(config, { configManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }
  const access = await request({ port: address.port, method: 'GET', path: '/admin/api/access', headers: { cookie } })
  assert.equal(access.statusCode, 200)
  assert.equal(JSON.parse(access.body).clients[0].keyHash, undefined)
  const group = await request({ port: address.port, path: '/admin/api/access/groups', headers, body: { id: 'daily', channels: ['free'] } })
  assert.equal(group.statusCode, 202)
  const client = await request({ port: address.port, path: '/admin/api/access/clients', headers, body: { id: 'daily-agent', group: 'daily' } })
  assert.equal(client.statusCode, 201)
  assert.match(JSON.parse(client.body).key, /^cpa_/)
  const rotated = await request({ port: address.port, path: '/admin/api/access/clients/daily-agent/rotate', headers, body: {} })
  assert.equal(rotated.statusCode, 200)
  assert.match(JSON.parse(rotated.body).key, /^cpa_/)
  assert.deepEqual(calls.slice(0, 3), [
    ['group-create', { id: 'daily', channels: ['free'] }],
    ['client-create', { id: 'daily-agent', group: 'daily' }],
    ['client-rotate', 'daily-agent']
  ])
})

test('revision history and structured diff are authenticated and audit jobs stay redacted', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const revisionId = '20260817T120000000Z-0123456789abcdef-01234567'
  const auditEvents = []
  const configManager = {
    status: () => ({ revision: revisionId, loadedRevision: revisionId, pendingRevision: revisionId, restartRequired: false }),
    routing: () => ({ stableAliases: [], pinnedAliases: [], models: [{ channel: 'free', model: 'shared-model', kind: 'generation', streaming: 'both', canaryEligible: true, status: 'active' }] }),
    revisions: () => [{ revision: revisionId, operation: 'startup-baseline', contentDigest: 'a'.repeat(64), affected: { channelIds: [], modelIds: [] }, valid: true }],
    revisionDiff: () => ({
      from: { revision: revisionId },
      to: { revision: revisionId },
      diff: { channels: { added: [], removed: [], changed: [{ id: 'free', baseUrlChanged: true, apiKeyReplaced: true }] }, models: { added: [], removed: [], changed: [] }, aliases: { stable: { added: [], removed: [], changed: [] }, pinned: { added: [], removed: [], changed: [] } } }
    }),
    updateModelStatus: () => ({ channel: 'free', model: 'shared-model', status: 'active', revision: revisionId })
  }
  const auditStore = {
    record: event => { auditEvents.push(event); return true },
    status: () => ({ storage: 'memory', count: auditEvents.length }),
    list: () => auditEvents.slice()
  }
  const gateway = createControlGateway(config, { configManager, auditStore })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }

  const list = await request({ port: address.port, method: 'GET', path: '/admin/api/revisions', headers: { cookie } })
  assert.equal(list.statusCode, 200)
  assert.equal(JSON.parse(list.body).data[0].revision, revisionId)
  const diff = await request({ port: address.port, method: 'GET', path: `/admin/api/revisions/${revisionId}/diff`, headers: { cookie } })
  assert.equal(diff.statusCode, 200)
  assert.equal(JSON.parse(diff.body).diff.channels.changed[0].apiKeyReplaced, true)
  assert.doesNotMatch(diff.body, /upstream\.example\.test|fixture-upstream-key|fixture_gateway_key/)

  const update = await request({ port: address.port, method: 'PATCH', path: '/admin/api/models', headers, body: { channel: 'free', model: 'shared-model', status: 'active' } })
  assert.equal(update.statusCode, 202)
  await waitFor(() => auditEvents.length === 1)
  assert.deepEqual(auditEvents[0], {
    jobId: auditEvents[0].jobId,
    operation: 'model-update',
    result: 'success',
    revision: revisionId,
    durationMs: auditEvents[0].durationMs
  })
  const audit = await request({ port: address.port, method: 'GET', path: '/admin/api/audit-events?limit=20', headers: { cookie } })
  assert.equal(audit.statusCode, 200)
  assert.equal(JSON.parse(audit.body).data[0].operation, 'model-update')
  assert.doesNotMatch(JSON.stringify(auditEvents), /fixture-upstream-key|fixture_gateway_key/)
})

test('revision pruning requires CSRF and exact keep confirmation and runs through the control queue', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const revisionId = '20260817T120000000Z-0123456789abcdef-01234567'
  const auditEvents = []
  let pruneCalls = 0
  const revisionStorage = { count: 75, validCount: 74, invalidCount: 1, totalBytes: 4096, keep: 50, protectedCount: 1, prunableCount: 25, prunableBytes: 1024, plans: {} }
  const configManager = {
    status: () => ({ revision: revisionId, loadedRevision: revisionId, pendingRevision: revisionId, restartRequired: false, revisionStorage }),
    routing: () => ({ stableAliases: [], pinnedAliases: [], models: [] }),
    pruneRevisions: ({ keep }) => {
      pruneCalls += 1
      return { keep, removedCount: 25, reclaimedBytes: 1024, revision: revisionId, restartRequired: false }
    }
  }
  const auditStore = {
    record: event => { auditEvents.push(event); return true },
    status: () => ({ storage: 'memory', count: auditEvents.length }),
    list: () => auditEvents.slice()
  }
  const gateway = createControlGateway(config, { configManager, auditStore })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }
  const status = await request({ port: address.port, method: 'GET', path: '/admin/api/status', headers: { cookie } })
  assert.equal(JSON.parse(status.body).revisionStorage.prunableCount, 25)

  const unauthenticated = await request({ port: address.port, path: '/admin/api/revisions/prune', body: { keep: 50, confirmKeep: 50 } })
  assert.equal(unauthenticated.statusCode, 401)
  const unconfirmed = await request({ port: address.port, path: '/admin/api/revisions/prune', headers, body: { keep: 50, confirmKeep: 20 } })
  assert.equal(unconfirmed.statusCode, 400)
  assert.equal(JSON.parse(unconfirmed.body).error.code, 'revision_prune_confirmation_required')
  const pruned = await request({ port: address.port, path: '/admin/api/revisions/prune', headers, body: { keep: 50, confirmKeep: 50 } })
  assert.equal(pruned.statusCode, 200)
  assert.equal(JSON.parse(pruned.body).removedCount, 25)
  assert.equal(pruneCalls, 1)
  await waitFor(() => auditEvents.length === 1)
  assert.equal(auditEvents[0].operation, 'revision-prune')
  assert.equal(auditEvents[0].revision, revisionId)
  assert.doesNotMatch(JSON.stringify(auditEvents), /fixture_management_key|fixture-upstream-key/)
})

test('rollback requires explicit confirmation, is serialized, and restores after runtime failure', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const currentRevision = '20260817T120000000Z-0123456789abcdef-01234567'
  const rollbackRevision = '20260817T120001000Z- fedcba9876543210-76543210'.replaceAll(' ', '')
  let prepared = 0
  let restored = 0
  let shouldFail = true
  const configManager = {
    status: () => ({ revision: shouldFail ? currentRevision : rollbackRevision, loadedRevision: shouldFail ? currentRevision : rollbackRevision, pendingRevision: shouldFail ? currentRevision : rollbackRevision, restartRequired: false }),
    routing: () => ({ stableAliases: [], pinnedAliases: [], models: [] }),
    prepareRollback: targetRevision => {
      prepared += 1
      assert.equal(targetRevision, currentRevision)
      return { changed: true, revision: rollbackRevision, previousManifest: { revision: currentRevision }, previousSnapshot: {} }
    },
    restoreRollback: () => { restored += 1 }
  }
  const runtimeManager = {
    apply: async () => {
      if (shouldFail) {
        const error = new Error('private runtime failure')
        error.code = 'runtime_not_ready'
        error.statusCode = 503
        throw error
      }
      return { changed: true, active: { digest: 'rollback-release' } }
    },
    status: () => ({ active: null, transitioning: false, available: true })
  }
  const gateway = createControlGateway(config, { configManager, runtimeManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }
  const pathValue = `/admin/api/revisions/${currentRevision}/rollback`

  const missingConfirmation = await request({ port: address.port, path: pathValue, headers, body: {} })
  assert.equal(missingConfirmation.statusCode, 400)
  assert.equal(prepared, 0)
  const failed = await request({ port: address.port, path: pathValue, headers, body: { confirmRevision: currentRevision } })
  assert.equal(failed.statusCode, 503)
  assert.equal(restored, 1)

  shouldFail = false
  const succeeded = await request({ port: address.port, path: pathValue, headers, body: { confirmRevision: currentRevision } })
  assert.equal(succeeded.statusCode, 202)
  assert.equal(JSON.parse(succeeded.body).rollbackRevision, rollbackRevision)
  assert.equal(restored, 1)
})

test('concurrent runtime apply and rollback execute through the same FIFO', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const targetRevision = '20260817T120000000Z-0123456789abcdef-01234567'
  const rollbackRevision = '20260817T120001000Z-fedcba9876543210-76543210'
  const order = []
  let releaseApply
  let applyCalls = 0
  const runtimeManager = {
    status: () => ({ active: null, transitioning: false, available: true }),
    apply: async () => {
      applyCalls += 1
      if (applyCalls === 1) {
        order.push('apply-start')
        await new Promise(resolve => { releaseApply = resolve })
        order.push('apply-end')
      } else {
        order.push('rollback-runtime')
      }
      return { changed: true, active: { digest: `release-${applyCalls}` } }
    }
  }
  const configManager = {
    status: () => ({ revision: rollbackRevision, loadedRevision: rollbackRevision, pendingRevision: rollbackRevision, restartRequired: false }),
    routing: () => ({ stableAliases: [], pinnedAliases: [], models: [] }),
    prepareRollback: () => {
      order.push('rollback-prepare')
      return { changed: true, revision: rollbackRevision, previousManifest: { revision: targetRevision }, previousSnapshot: {} }
    },
    restoreRollback: () => {}
  }
  const gateway = createControlGateway(config, { configManager, runtimeManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const csrf = JSON.parse(login.body).csrfToken
  const headers = { cookie, origin: `http://127.0.0.1:${address.port}`, 'x-csrf-token': csrf }

  const apply = request({ port: address.port, path: '/admin/api/runtime/apply', headers, body: {} })
  await waitFor(() => order.includes('apply-start'))
  const rollback = request({ port: address.port, path: `/admin/api/revisions/${targetRevision}/rollback`, headers, body: { confirmRevision: targetRevision } })
  await waitFor(() => gateway.controlJobs.status().queued === 1)
  assert.deepEqual(order, ['apply-start'])
  releaseApply()
  assert.equal((await apply).statusCode, 200)
  assert.equal((await rollback).statusCode, 202)
  assert.deepEqual(order, ['apply-start', 'apply-end', 'rollback-prepare', 'rollback-runtime'])
})

test('admin models honor an explicitly empty pending catalog', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const configManager = {
    status: () => ({ revision: 'empty-pending-revision', restartRequired: true }),
    routing: () => ({ stableAliases: [], pinnedAliases: [], models: [] })
  }
  const gateway = createControlGateway(config, { configManager })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const login = await request({ port: address.port, path: '/admin/api/session', body: { key: config.managementKey } })
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const models = await request({ port: address.port, method: 'GET', path: '/admin/api/models', headers: { cookie } })

  assert.equal(models.statusCode, 200)
  assert.deepEqual(JSON.parse(models.body).data, [])
})

test('admin page serves the built app with strict static CSP and immutable assets', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const first = await request({ port: address.port, method: 'GET', path: '/admin' })
  const second = await request({ port: address.port, method: 'GET', path: '/admin' })
  assert.equal(first.statusCode, 200)
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.match(first.headers['content-security-policy'], /script-src 'self'/)
  assert.equal(first.headers['content-security-policy'], second.headers['content-security-policy'])
  assert.match(first.body, /\/admin\/assets\/index-[A-Za-z0-9_-]+\.js/)
  assert.match(first.body, /\/admin\/assets\/index-[A-Za-z0-9_-]+\.css/)
  assert.doesNotMatch(first.body, /management_key|gateway_key|upstream-key/)
  const assetPath = /src="([^\"]+\.js)"/.exec(first.body)?.[1]
  assert.ok(assetPath)
  const asset = await request({ port: address.port, method: 'GET', path: assetPath })
  assert.equal(asset.statusCode, 200)
  assert.match(asset.headers['cache-control'], /immutable/)
  assert.match(asset.headers['content-security-policy'], /default-src 'none'/)
  assert.match(asset.body, /客户端连接/)
  assert.match(asset.body, /current-password/)
  assert.doesNotMatch(asset.body, /autoFocus:!0,autoComplete:"current-password"/)
  assert.match(asset.body, /FormData/)
  assert.match(asset.body, /编辑渠道/)
  assert.match(asset.body, /替换 API key/)
  assert.match(asset.body, /留空保持现有密钥/)
  assert.match(asset.body, /应用到当前模型/)
  assert.doesNotMatch(asset.body, /应用到渠道/)
  assert.match(asset.body, /同一渠道内的模型可以使用不同协议/)
  assert.match(asset.body, /禁用后该模型会从公开目录和生产调度移除/)
  assert.match(asset.body, /删除前必须先移走稳定别名引用/)
  assert.match(asset.body, /现有逻辑模型 ID 不可修改/)
  assert.match(asset.body, /整理 revision 历史/)
  assert.match(asset.body, /删除后不能在管理台恢复/)
  assert.match(asset.body, /\/admin\/api\/revisions\/prune/)
  assert.match(asset.body, /\/admin\/api\/stable-aliases/)
  assert.match(asset.body, /\/admin\/api\/runtime\/apply/)
  assert.match(asset.body, /\/admin\/api\/revisions/)
  assert.doesNotMatch(first.body, new RegExp(GATEWAY_KEY))
})

test('rate limits repeated failed admin logins', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rejected = await request({
      port: address.port,
      path: '/admin/api/session',
      body: { key: 'wrong-management-key' }
    })
    assert.equal(rejected.statusCode, 401)
  }
  const limited = await request({
    port: address.port,
    path: '/admin/api/session',
    body: { key: config.managementKey }
  })
  assert.equal(limited.statusCode, 429)
  assert.equal(JSON.parse(limited.body).error.code, 'admin_login_rate_limited')
  assert.ok(Number(limited.headers['retry-after']) > 0)
})

test('isolates Cloudflare Tunnel login limits by validated connecting IP', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  config.cloudflareTunnel = { enabled: true }
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rejected = await request({
      port: address.port,
      path: '/admin/api/session',
      headers: { 'cf-connecting-ip': '203.0.113.10' },
      body: { key: 'wrong-management-key' }
    })
    assert.equal(rejected.statusCode, 401)
  }
  const blockedSource = await request({
    port: address.port,
    path: '/admin/api/session',
    headers: { 'cf-connecting-ip': '203.0.113.10' },
    body: { key: config.managementKey }
  })
  const differentSource = await request({
    port: address.port,
    path: '/admin/api/session',
    headers: { 'cf-connecting-ip': '2001:db8::20' },
    body: { key: config.managementKey }
  })

  assert.equal(blockedSource.statusCode, 429)
  assert.equal(differentSource.statusCode, 200)
})

test('bounds failed login sources without blocking a valid management key', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config, {
    adminLoginSourceLimit: 2,
    adminClientKey: request => request.headers['x-fixture-client'] ?? 'unknown'
  })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const first = await request({ port: address.port, path: '/admin/api/session', headers: { 'x-fixture-client': 'first' }, body: { key: 'wrong-key' } })
  const second = await request({ port: address.port, path: '/admin/api/session', headers: { 'x-fixture-client': 'second' }, body: { key: 'wrong-key' } })
  const overflow = await request({ port: address.port, path: '/admin/api/session', headers: { 'x-fixture-client': 'overflow' }, body: { key: 'wrong-key' } })
  const valid = await request({ port: address.port, path: '/admin/api/session', headers: { 'x-fixture-client': 'overflow' }, body: { key: config.managementKey } })

  assert.equal(first.statusCode, 401)
  assert.equal(second.statusCode, 401)
  assert.equal(overflow.statusCode, 429)
  assert.equal(JSON.parse(overflow.body).error.code, 'admin_login_rate_limited')
  assert.equal(valid.statusCode, 200)
})

test('bounds active admin sessions and evicts the oldest login', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config, { adminSessionLimit: 2 })
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const cookies = []
  for (let index = 0; index < 3; index += 1) {
    const login = await request({
      port: address.port,
      path: '/admin/api/session',
      body: { key: config.managementKey }
    })
    assert.equal(login.statusCode, 200)
    cookies.push(login.headers['set-cookie'][0].split(';', 1)[0])
  }

  const oldest = await request({
    port: address.port,
    method: 'GET',
    path: '/admin/api/session',
    headers: { cookie: cookies[0] }
  })
  const newest = await request({
    port: address.port,
    method: 'GET',
    path: '/admin/api/session',
    headers: { cookie: cookies[2] }
  })

  assert.equal(oldest.statusCode, 401)
  assert.equal(JSON.parse(oldest.body).error.code, 'admin_unauthorized')
  assert.equal(newest.statusCode, 200)
})

test('client keys replace the public gateway key and filter the model catalog by channel group', async t => {
  const config = fixtureConfig(19001)
  const clientKey = 'cpa_fixture_client_key_that_is_long_enough'
  config.channels.push({
    ...config.channels[0],
    id: 'daily',
    name: 'Daily',
    listener: 19002,
    models: [{ ...config.channels[0].models[0], aliases: ['daily/shared-model'] }]
  })
  config.clientAccess = {
    schemaVersion: 1,
    groups: [{ id: 'daily-group', channels: ['daily'], enabled: true }],
    clients: [{ id: 'ai-daily', group: 'daily-group', keyHash: hashClientKey(clientKey), enabled: true }]
  }
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())

  const legacy = await request({ port: address.port, method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${GATEWAY_KEY}` } })
  assert.equal(legacy.statusCode, 401)
  const response = await request({ port: address.port, method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${clientKey}` } })
  assert.equal(response.statusCode, 200)
  const ids = JSON.parse(response.body).data.map(item => item.id)
  assert.ok(ids.includes('shared-model'))
  assert.ok(ids.includes('daily/shared-model'))
  assert.ok(!ids.includes('free/shared-model'))
  assert.ok(!ids.includes('coding-main'))
})

const GATEWAY_KEY = 'fixture_gateway_key_that_is_long_enough_123456'

function fixtureConfig(listener) {
  const model = {
    upstream: 'shared-model',
    protocol: 'responses',
    aliases: ['free/shared-model'],
    priority: 100,
    inputModalities: ['text'],
    outputModalities: ['text']
  }
  const channel = {
    id: 'free',
    name: 'Free',
    enabled: true,
    listener,
    upstream: new URL('https://upstream.example.test/v1'),
    apiKey: 'fixture-upstream-key',
    protocol: 'responses',
    priority: 100,
    models: [model]
  }
  return {
    gatewayKey: GATEWAY_KEY,
    gateway: {
      public: { host: '127.0.0.1', portEnv: 'SERVER_PORT', defaultPort: 3000 },
      internal: { host: '127.0.0.1', cpaPort: 24675 },
      control: { maxRequestBytes: 1024 * 1024, busyRetryAfterSeconds: 1 },
      timeouts: { serverSeconds: 5 }
    },
    channels: [channel],
    stableAliases: [{ alias: 'coding-main', channel: 'free', model: 'shared-model' }],
    pinnedAliases: []
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function jsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.once('error', reject)
    request.once('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
  })
}

function request({ port, method = 'POST', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const outgoing = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {})
      }
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    outgoing.once('error', reject)
    outgoing.end(payload)
  })
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true before timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
