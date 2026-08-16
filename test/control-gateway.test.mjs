import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createControlGateway } from '../src/control-gateway.mjs'
import { createControlState } from '../src/control-state.mjs'

test('native Responses forwarding preserves reviewed client headers and replaces secrets', async t => {
  let captured
  const upstream = http.createServer(async (request, response) => {
    captured = {
      path: request.url,
      headers: request.headers,
      body: await jsonBody(request)
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
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
})

test('models endpoint exposes logical, stable, and direct ids', async t => {
  const gateway = createControlGateway(fixtureConfig(19001))
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const result = await request({
    port: address.port,
    method: 'GET',
    path: '/v1/models',
    headers: { 'x-api-key': GATEWAY_KEY }
  })
  assert.equal(result.statusCode, 200)
  const ids = JSON.parse(result.body).data.map(item => item.id)
  assert.deepEqual(ids, ['coding-main', 'free/shared-model', 'shared-model'])
  assert.doesNotMatch(result.body, /upstream\.example\.test/)
})

test('channel updates enter drain mode before the pending restart', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const configManager = {
    status: () => ({ revision: 'pending-revision', restartRequired: true }),
    routing: () => ({ stableAliases: config.stableAliases, pinnedAliases: [], models: [] }),
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
  const configManager = {
    status: () => ({ revision: 'release-b', loadedRevision, restartRequired: loadedRevision !== 'release-b' }),
    markApplied: () => { marks += 1; loadedRevision = 'release-b' }
  }
  const gateway = createControlGateway(config, { configManager })
  const next = { ...config, digest: 'release-b' }

  gateway.reloadConfig(next, { markApplied: false })
  assert.equal(marks, 0)
  assert.equal(configManager.status().restartRequired, true)
  gateway.markConfigApplied()
  assert.equal(marks, 1)
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
  assert.equal(JSON.parse(status.body).channels[0].baseUrl, 'https://upstream.example.test/v1')

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

test('admin API updates model status and stable aliases through the private config manager', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const calls = []
  const configManager = {
    status: () => ({ revision: 'pending-revision', restartRequired: true }),
    routing: () => ({
      stableAliases: [{ alias: 'coding-main', channel: 'free', model: 'shared-model' }],
      pinnedAliases: [],
      models: [
        { channel: 'free', model: 'shared-model', status: 'disabled' },
        { channel: 'future', model: 'pending-model', protocol: 'responses', kind: 'generation', streaming: 'both', canaryEligible: true, staged: true, channelEnabled: false, status: 'active' }
      ]
    }),
    updateModelStatus: (channel, model, status) => {
      calls.push({ operation: 'model', channel, model, status })
      return { channel, model, status, revision: 'next-model-revision', restartRequired: true }
    },
    setStableAlias: (alias, channel, model) => {
      calls.push({ operation: 'alias', alias, channel, model })
      return { alias, channel, model, revision: 'next-alias-revision', restartRequired: true }
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
  assert.deepEqual(calls, [
    { operation: 'model', channel: 'free', model: 'shared-model', status: 'active' },
    { operation: 'alias', alias: 'coding-backup', channel: 'free', model: 'shared-model' }
  ])
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

test('admin page is no-store and uses a per-response CSP nonce', async t => {
  const config = fixtureConfig(19001)
  config.managementKey = 'fixture_management_key_that_is_long_enough_123456'
  const gateway = createControlGateway(config)
  const address = await gateway.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => gateway.close())
  const first = await request({ port: address.port, method: 'GET', path: '/admin' })
  const second = await request({ port: address.port, method: 'GET', path: '/admin' })
  assert.equal(first.statusCode, 200)
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.match(first.headers['content-security-policy'], /script-src 'nonce-/)
  assert.notEqual(first.headers['content-security-policy'], second.headers['content-security-policy'])
  assert.match(first.body, /id="addChannelForm"/)
  assert.match(first.body, /新增并同步模型/)
  assert.match(first.body, /<select id="syncChannelIds"/)
  assert.match(first.body, /<select id="model"/)
  assert.match(first.body, /设为 coding-main/)
  assert.match(first.body, /\/admin\/api\/stable-aliases/)
  assert.match(first.body, /method:'PATCH'/)
  assert.match(first.body, /healthLabel/)
  assert.match(first.body, /candidate\.channel\+'\/'/)
  assert.match(first.body, /请先从下拉框选择一个精确模型/)
  assert.match(first.body, /忙碌或已禁用模型不能测活/)
  assert.match(first.body, /id="usage"/)
  assert.match(first.body, /channel-discovery/)
  assert.match(first.body, /\/admin\/api\/usage/)
  assert.match(first.body, /\/admin\/api\/model-sync/)
  assert.match(first.body, /待测试渠道/)
  assert.match(first.body, /<th>Base URL<\/th>/)
  assert.match(first.body, /mode:'same-origin'/)
  assert.match(first.body, /headers\['x-csrf-token'\]=csrf/)
  assert.match(first.body, /客户端连接/)
  assert.match(first.body, /id="applyButton"/)
  assert.match(first.body, /\/admin\/api\/runtime\/apply/)
  assert.match(first.body, /复制 Base URL/)
  assert.match(first.body, /复制 API key/)
  assert.doesNotMatch(first.body, new RegExp(GATEWAY_KEY))
  const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(first.body)?.[1]
  assert.ok(script)
  assert.doesNotThrow(() => new vm.Script(script))
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
