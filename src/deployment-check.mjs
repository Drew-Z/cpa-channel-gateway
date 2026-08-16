import { buildCanaryRequest, extractCanaryContent } from './canary.mjs'

const FIXED_TASK = '请写一首四句七言绝句，主题是秋夜读书。只输出诗题和诗句。'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export async function runDeploymentCheck({
  origin,
  managementKey,
  gatewayKey = null,
  canaryModel = null,
  businessModel = null,
  apply = false,
  fetchImpl = fetch
} = {}) {
  const base = cleanOrigin(origin)
  if (typeof managementKey !== 'string' || managementKey.length < 1) throw new TypeError('CPA_MANAGEMENT_KEY is required')
  if (businessModel && !gatewayKey) throw new TypeError('GATEWAY_API_KEY is required for business stream checks')

  const result = {
    ok: true,
    origin: base.origin,
    health: null,
    runtime: null,
    apply: null,
    canary: null,
    business: null
  }
  let session = null
  try {
    const health = await request(fetchImpl, new URL('/healthz', base), { method: 'GET' }, 'health')
    result.health = { statusCode: health.response.status }

    const login = await request(fetchImpl, new URL('/admin/api/session', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: managementKey })
    }, 'admin_login')
    const cookie = sessionCookie(login.response.headers.get('set-cookie'))
    const csrfToken = typeof login.data?.csrfToken === 'string' ? login.data.csrfToken : ''
    if (!cookie || !csrfToken) throw checkError('admin_login_invalid', null, 'Admin login returned an invalid session')
    session = { cookie, csrfToken }

    let status = await adminStatus(fetchImpl, base, session)
    assertRuntimeStatus(status)

    if (status.restartRequired) {
      if (!apply) throw checkError('pending_revision', 409, 'A pending revision must be applied before deployment checks')
      const applied = await adminMutation(fetchImpl, base, session, '/admin/api/runtime/apply', {}, 'runtime_apply')
      result.apply = {
        changed: applied.changed === true,
        activeDigest: stringOrNull(applied.active?.digest)
      }
      status = await adminStatus(fetchImpl, base, session)
      assertRuntimeStatus(status)
      if (status.restartRequired) throw checkError('runtime_apply_incomplete', 503, 'Runtime apply did not commit the pending revision')
    }
    result.runtime = publicRuntimeStatus(status)

    if (canaryModel) {
      const canary = await adminMutation(fetchImpl, base, session, '/admin/api/tests', { model: canaryModel }, 'model_canary')
      if (canary.ok !== true) throw checkError('model_canary_failed', canary.statusCode ?? null, 'Exact model canary failed')
      result.canary = {
        model: canaryModel,
        ok: true,
        statusCode: canary.statusCode ?? null,
        protocol: stringOrNull(canary.protocol),
        transport: stringOrNull(canary.transport),
        latencyMs: integerOrNull(canary.latencyMs),
        contentLength: integerOrNull(canary.contentLength)
      }
    }

    if (businessModel) {
      result.business = await businessChecks(fetchImpl, base, gatewayKey, businessModel)
    }
    return result
  } finally {
    if (session) await logout(fetchImpl, base, session).catch(() => {})
  }
}

function cleanOrigin(value) {
  const url = new URL(String(value ?? ''))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new TypeError('GATEWAY_BASE_URL must be a clean http(s) origin')
  }
  return url
}

async function adminStatus(fetchImpl, base, session) {
  const response = await request(fetchImpl, new URL('/admin/api/status', base), {
    method: 'GET',
    headers: { cookie: session.cookie }
  }, 'admin_status')
  return response.data
}

async function adminMutation(fetchImpl, base, session, pathname, body, stage) {
  const response = await request(fetchImpl, new URL(pathname, base), {
    method: 'POST',
    headers: {
      cookie: session.cookie,
      origin: base.origin,
      'x-csrf-token': session.csrfToken,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  }, stage)
  return response.data
}

function assertRuntimeStatus(status) {
  if (status?.ready !== true) throw checkError('gateway_not_ready', 503, 'Gateway status is not ready')
  if (status.runtime?.available !== true || !status.runtime?.active?.digest) {
    throw checkError('runtime_unavailable', 503, 'Internal runtime supervisor is unavailable')
  }
  if (status.controlState?.storage !== 'persistent') {
    throw checkError('control_state_not_persistent', 503, 'Control state storage is not persistent')
  }
}

function publicRuntimeStatus(status) {
  return {
    available: true,
    activeDigest: stringOrNull(status.runtime?.active?.digest),
    transitioning: status.runtime?.transitioning === true,
    controlStateStorage: status.controlState?.storage,
    loadedRevision: stringOrNull(status.loadedRevision),
    pendingRevision: stringOrNull(status.pendingRevision),
    restartRequired: status.restartRequired === true
  }
}

async function businessChecks(fetchImpl, base, gatewayKey, model) {
  const requestShape = buildCanaryRequest('responses', model, FIXED_TASK)
  const nonStream = await request(fetchImpl, new URL(requestShape.path, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestShape.body, stream: false })
  }, 'business_non_stream', { maxBytes: MAX_RESPONSE_BYTES })
  const content = extractCanaryContent('responses', nonStream.data)
  if (typeof content !== 'string' || content.trim().length < 8) {
    throw checkError('business_non_stream_empty', nonStream.response.status, 'Non-stream request returned empty content')
  }

  const stream = await request(fetchImpl, new URL(requestShape.path, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${gatewayKey}`, accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ ...requestShape.body, stream: true })
  }, 'business_stream', { parseJson: false, maxBytes: MAX_RESPONSE_BYTES })
  if (!stream.bytes) throw checkError('business_stream_empty', stream.response.status, 'Stream request returned no events')
  const contentType = String(stream.response.headers.get('content-type') ?? '').split(';', 1)[0]
  if (contentType !== 'text/event-stream' || !stream.buffer.includes(Buffer.from('data:'))) {
    throw checkError('business_stream_invalid', stream.response.status, 'Stream request did not return an event stream')
  }
  return {
    model,
    nonStream: { statusCode: nonStream.response.status, contentLength: content.trim().length },
    stream: {
      statusCode: stream.response.status,
      contentType,
      responseBytes: stream.bytes
    }
  }
}

async function logout(fetchImpl, base, session) {
  await request(fetchImpl, new URL('/admin/api/session', base), {
    method: 'DELETE',
    headers: { cookie: session.cookie, origin: base.origin, 'x-csrf-token': session.csrfToken }
  }, 'admin_logout')
}

async function request(fetchImpl, url, options, stage, { parseJson = true, maxBytes = 256 * 1024 } = {}) {
  let response
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(180_000) })
  } catch {
    throw checkError(`${stage}_transport_failed`, null, `Deployment check failed during ${stage}`)
  }
  if (!response.ok) throw checkError(`${stage}_http_error`, response.status, `Deployment check failed during ${stage}`)
  const buffer = await readResponseBody(response, maxBytes, stage)
  let data = null
  if (parseJson) {
    try { data = buffer.length ? JSON.parse(buffer.toString('utf8')) : {} } catch {
      throw checkError(`${stage}_invalid_json`, response.status, `Deployment check received invalid JSON during ${stage}`)
    }
  }
  return { response, data, bytes: buffer.length, buffer }
}

async function readResponseBody(response, maxBytes, stage) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw checkError(`${stage}_response_too_large`, response.status, `Deployment check response was too large during ${stage}`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function sessionCookie(value) {
  const match = /(?:^|;\s*)(cpa_admin=[^;]+)/.exec(String(value ?? ''))
  return match?.[1] ?? null
}

function checkError(code, statusCode, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
