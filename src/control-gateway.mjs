import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { performance } from 'node:perf_hooks'
import { sendAdminAsset, sendAdminIndex } from './admin-assets.mjs'
import { createAuditEventStore } from './audit-events.mjs'
import { buildCanaryRequest, diagnoseCanaryResponse, normalizeCanaryProtocol } from './canary.mjs'
import { ConfigMutationError, createPrivateConfigManager } from './config-manager.mjs'
import { createControlState } from './control-state.mjs'
import { createControlJobQueue } from './control-jobs.mjs'
import { isCanaryEligible } from './model-metadata.mjs'
import { createModelScheduler, GatewayRoutingError } from './scheduler.mjs'
import { createUsageMonitor } from './usage-monitor.mjs'
import { resolveClient } from './client-access.mjs'

const API_PATHS = new Set(['/v1/responses', '/v1/chat/completions', '/v1/messages', '/v1/embeddings'])
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000
const ADMIN_SESSION_LIMIT = 64
const ADMIN_TEST_COOLDOWN_MS = 5_000
const ADMIN_LOGIN_WINDOW_MS = 5 * 60 * 1000
const ADMIN_LOGIN_MAX_FAILURES = 5
const ADMIN_LOGIN_SOURCE_LIMIT = 1024
const ADMIN_TEST_RESULT_TTL_MS = 30 * 60 * 1000
const CANARY_PROMPT = '请写一首四句七言绝句，主题是秋夜读书。只输出诗题和诗句。'
const CONFIG_PROTOCOLS = new Set(['openai-compatible', 'responses', 'claude'])

export function createControlGateway(config, {
  controlState = createControlState(config),
  scheduler = createModelScheduler(config, {
    initialState: controlState.schedulerState(),
    onStateChange: state => controlState.replaceSchedulerState(state)
  }),
  usageMonitor = createUsageMonitor(config),
  configManager = createPrivateConfigManager(config, {
    withChannelLease: (channel, operation) => withSchedulerChannelLease(scheduler, channel, operation)
  }),
  runtimeManager = null,
  auditStore: auditStoreOption = null,
  monotonicNow = () => performance.now(),
  adminSessionLimit = ADMIN_SESSION_LIMIT,
  adminLoginSourceLimit = ADMIN_LOGIN_SOURCE_LIMIT,
  adminClientKey = request => resolveAdminClientKey(request, config.cloudflareTunnel?.enabled === true)
} = {}) {
  const sessions = new Map()
  const sessionLimit = Number.isSafeInteger(adminSessionLimit) && adminSessionLimit > 0
    ? adminSessionLimit
    : ADMIN_SESSION_LIMIT
  const loginSourceLimit = Number.isSafeInteger(adminLoginSourceLimit) && adminLoginSourceLimit > 0
    ? adminLoginSourceLimit
    : ADMIN_LOGIN_SOURCE_LIMIT
  if (typeof adminClientKey !== 'function') throw new TypeError('An admin client key resolver is required')
  const loginFailures = new Map()
  const auditStore = auditStoreOption ?? createAuditEventStore(config)
  const controlJobs = createControlJobQueue({
    onFinished: event => auditStore.record({
      jobId: event.id,
      operation: event.type,
      result: event.status === 'completed' ? 'success' : 'failure',
      revision: event.revision,
      durationMs: event.durationMs,
      ...(event.status === 'failed' ? { errorCode: event.error?.code ?? 'control_job_failed' } : {})
    })
  })
  const lastTests = new Map(Object.entries(controlState.lastTests()))
  const protocolTests = new Map([...lastTests].map(([modelId, result]) => [`${modelId}\0${result.protocol}`, result]))
  const lastTestStarted = new Map()
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      const statusCode = error instanceof GatewayRoutingError || error instanceof ConfigMutationError ? error.statusCode : error.statusCode ?? 500
      const code = error instanceof GatewayRoutingError || error instanceof ConfigMutationError ? error.code : error.code ?? 'internal_error'
      sendJson(response, statusCode, { error: { code, message: publicErrorMessage(error, statusCode) } }, {
        ...(code === 'all_candidates_busy' ? { 'retry-after': String(config.gateway.control.busyRetryAfterSeconds) } : {}),
        ...(code === 'channel_cooling' ? { 'retry-after': String(Math.max(1, Math.ceil((error.retryAfterMs ?? 30_000) / 1000))) } : {}),
        ...(code === 'admin_login_rate_limited' ? { 'retry-after': String(Math.ceil((error.retryAfterMs ?? ADMIN_LOGIN_WINDOW_MS) / 1000)) } : {})
      })
    })
  })
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })

  async function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://gateway.local')
    if (request.method === 'GET' && url.pathname === '/healthz') {
      sendJson(response, 200, { ready: true })
      return
    }
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      await handleAdminRequest(request, response, url)
      return
    }
    const access = authorizeGatewayRequest(request, config)
    if (!access) {
      sendJson(response, 401, { error: { code: 'invalid_api_key', message: 'Invalid API key' } }, { 'www-authenticate': 'Bearer' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(response, 200, {
        object: 'list',
        data: scheduler.catalog.listPublicModels({
          allowedChannels: access.allowedChannels,
          includeNonGeneration: true
        })
      })
      return
    }
    if (request.method !== 'POST' || !API_PATHS.has(url.pathname)) {
      sendJson(response, 404, { error: { code: 'not_found', message: 'Route not found' } })
      return
    }

    const body = await readJsonBody(request, requestBodyLimit())
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!requestedModel) throw publicError('invalid_request', 400, 'Request body must include a model')
    const embeddingRequest = url.pathname === '/v1/embeddings'
    let selection
    try {
      selection = scheduler.reserve(requestedModel, {
        requestId: normalizeRequestId(request.headers['x-request-id']),
        source: 'production',
        streaming: body.stream === true ? 'stream' : 'non-stream',
        allowedKinds: embeddingRequest ? ['embedding'] : ['generation'],
        allowedChannels: access.allowedChannels,
        clientId: access.clientId,
        groupId: access.groupId
      })
    } catch (error) {
      if (error instanceof GatewayRoutingError && ['all_candidates_busy', 'no_eligible_candidates', 'streaming_not_supported', 'model_endpoint_mismatch'].includes(error.code)) {
        const resolved = scheduler.catalog.resolve(requestedModel)
        usageMonitor.record({
          requestedModel,
          logicalModelId: resolved?.logicalModelId,
          upstreamModel: resolved?.candidates[0]?.upstreamModel,
          clientId: access.clientId,
          groupId: access.groupId,
          outcome: 'failure',
          transport: 'unassigned'
        })
      }
      throw error
    }
    const transport = embeddingRequest || (url.pathname === '/v1/responses' && selection.candidate.protocol === 'responses')
      ? 'native-passthrough'
      : 'adapted'
    const outboundBody = {
      ...body,
      model: transport === 'native-passthrough'
        ? selection.candidate.upstreamModel
        : selection.candidate.directAlias
    }
    await proxyRequest({ request, response, url, outboundBody, selection, transport, requestedModel, access, upstreamDirect: embeddingRequest })
  }

  async function handleAdminRequest(request, response, url) {
    if (!config.managementKey) {
      sendJson(response, 404, { error: { code: 'admin_disabled', message: 'Admin access is disabled' } })
      return
    }
    if (['/admin', '/admin/'].includes(url.pathname) && request.method === 'GET') {
      sendAdminIndex(response)
      return
    }
    if (request.method === 'GET' && url.pathname.startsWith('/admin/assets/')) {
      sendAdminAsset(response, url.pathname)
      return
    }
    if (url.pathname === '/admin/api/session' && request.method === 'POST') {
      await loginAdmin(request, response)
      return
    }
    const session = requireAdminSession(request)
    if (url.pathname === '/admin/api/session' && request.method === 'GET') {
      sendJson(response, 200, { ok: true, csrfToken: session.csrfToken })
      return
    }
    if (url.pathname === '/admin/api/session' && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      sessions.delete(session.token)
      sendJson(response, 200, { ok: true }, {
        'set-cookie': 'cpa_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
      })
      return
    }
    if (url.pathname === '/admin/api/status' && request.method === 'GET') {
      sendJson(response, 200, adminStatus())
      return
    }
    if (url.pathname === '/admin/api/connection' && request.method === 'GET') {
      sendJson(response, 200, adminConnection(request, false))
      return
    }
    if (url.pathname === '/admin/api/connection/reveal' && request.method === 'POST') {
      requireAdminMutation(request, session)
      sendJson(response, 200, adminConnection(request, true))
      return
    }
    if (url.pathname === '/admin/api/access' && request.method === 'GET') {
      requireConfigManager()
      sendJson(response, 200, configManager.access?.() ?? { enabled: Boolean(config.clientAccess), groups: [], clients: [] })
      return
    }
    if (url.pathname === '/admin/api/access/groups' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 202, await controlJobs.run('client-group-create', () => configManager.createClientGroup(body)))
      return
    }
    const clientGroupRoute = /^\/admin\/api\/access\/groups\/([^/]+)$/.exec(url.pathname)
    if (clientGroupRoute && request.method === 'PATCH') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 202, await controlJobs.run('client-group-update', () => configManager.updateClientGroup(decodePathSegment(clientGroupRoute[1]), body)))
      return
    }
    if (clientGroupRoute && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      requireConfigManager()
      sendJson(response, 202, await controlJobs.run('client-group-delete', () => configManager.deleteClientGroup(decodePathSegment(clientGroupRoute[1]))))
      return
    }
    if (url.pathname === '/admin/api/access/clients' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 201, await controlJobs.run('client-create', () => configManager.createClient(body)))
      return
    }
    const clientRotateRoute = /^\/admin\/api\/access\/clients\/([^/]+)\/rotate$/.exec(url.pathname)
    if (clientRotateRoute && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      sendJson(response, 200, await controlJobs.run('client-rotate', () => configManager.rotateClient(decodePathSegment(clientRotateRoute[1]))))
      return
    }
    const clientRoute = /^\/admin\/api\/access\/clients\/([^/]+)$/.exec(url.pathname)
    if (clientRoute && request.method === 'PATCH') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 202, await controlJobs.run('client-update', () => configManager.updateClient(decodePathSegment(clientRoute[1]), body)))
      return
    }
    if (clientRoute && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      requireConfigManager()
      sendJson(response, 202, await controlJobs.run('client-delete', () => configManager.deleteClient(decodePathSegment(clientRoute[1]))))
      return
    }
    if (url.pathname === '/admin/api/channel-discovery' && request.method === 'GET') {
      requireConfigManager()
      sendJson(response, 200, configManager.discoverChannels())
      return
    }
    if (url.pathname === '/admin/api/models' && request.method === 'GET') {
      sendJson(response, 200, { data: adminModels() })
      return
    }
    if (url.pathname === '/admin/api/models' && request.method === 'PATCH') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const result = await controlJobs.run('model-update', () => {
        const updated = configManager.updateModelStatus(body.channel, body.model, body.status)
        if (updated.status === 'disabled') scheduler.suppressCandidate?.(body.channel, body.model)
        else scheduler.resumeCandidate?.(body.channel, body.model)
        return updated
      })
      sendJson(response, 202, result)
      return
    }
    if (url.pathname === '/admin/api/stable-aliases' && request.method === 'PUT') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const target = body.logicalModel !== undefined
        ? { logicalModel: body.logicalModel }
        : { channel: body.channel, model: body.model }
      sendJson(response, 202, await controlJobs.run('alias-update', () => configManager.setStableAlias(body.alias, target)))
      return
    }
    if (url.pathname === '/admin/api/logical-models' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 202, await controlJobs.run('logical-model-create', () => configManager.createLogicalModel(body)))
      return
    }
    const logicalModelRoute = /^\/admin\/api\/logical-models\/([^/]+)$/.exec(url.pathname)
    if (logicalModelRoute && request.method === 'PATCH') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const id = decodePathSegment(logicalModelRoute[1])
      sendJson(response, 202, await controlJobs.run('logical-model-update', () => configManager.updateLogicalModel(id, body)))
      return
    }
    if (logicalModelRoute && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const id = decodePathSegment(logicalModelRoute[1])
      sendJson(response, 202, await controlJobs.run('logical-model-delete', () => configManager.deleteLogicalModel(id)))
      return
    }
    if (url.pathname === '/admin/api/usage' && request.method === 'GET') {
      sendJson(response, 200, usageMonitor.snapshot({ hours: 24 }))
      return
    }
    if (url.pathname === '/admin/api/config' && request.method === 'GET') {
      sendJson(response, 200, configManager?.status() ?? { revision: null, restartRequired: false, writable: false })
      return
    }
    if (url.pathname === '/admin/api/revisions' && request.method === 'GET') {
      requireConfigManager()
      const limit = Number(url.searchParams.get('limit') ?? 50)
      sendJson(response, 200, { data: configManager.revisions({ limit: Number.isSafeInteger(limit) ? limit : 50 }) })
      return
    }
    if (url.pathname === '/admin/api/revisions/prune' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      if (!configManager.pruneRevisions) throw publicError('revision_prune_unavailable', 409, 'Configuration revision pruning is unavailable')
      const body = await readJsonBody(request, requestBodyLimit())
      const keep = Number(body.keep)
      if (![20, 50, 100].includes(keep) || body.confirmKeep !== keep) {
        throw publicError('revision_prune_confirmation_required', 400, 'Revision pruning requires an allowed keep count and exact confirmation')
      }
      sendJson(response, 200, await controlJobs.run('revision-prune', () => configManager.pruneRevisions({ keep })))
      return
    }
    if (url.pathname === '/admin/api/audit-events' && request.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 50)
      sendJson(response, 200, { data: auditStore.list({ limit: Number.isSafeInteger(limit) ? limit : 50 }) })
      return
    }
    const revisionDiffRoute = /^\/admin\/api\/revisions\/(\d{8}T\d{9}Z-[a-f0-9]{16}-[a-f0-9]{8})\/diff$/.exec(url.pathname)
    if (revisionDiffRoute && request.method === 'GET') {
      requireConfigManager()
      sendJson(response, 200, configManager.revisionDiff(revisionDiffRoute[1]))
      return
    }
    const revisionRollbackRoute = /^\/admin\/api\/revisions\/(\d{8}T\d{9}Z-[a-f0-9]{16}-[a-f0-9]{8})\/rollback$/.exec(url.pathname)
    if (revisionRollbackRoute && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      if (!runtimeManager?.apply || !configManager.prepareRollback || !configManager.restoreRollback) {
        throw publicError('runtime_rollback_unavailable', 409, 'Runtime rollback is not available in this process')
      }
      const body = await readJsonBody(request, requestBodyLimit())
      if (body.confirmRevision !== revisionRollbackRoute[1]) {
        throw publicError('rollback_confirmation_required', 400, 'Rollback requires an exact confirmRevision value')
      }
      const targetRevision = revisionRollbackRoute[1]
      const result = await controlJobs.run('runtime-rollback', async () => {
        const transaction = configManager.prepareRollback(targetRevision)
        if (!transaction.changed) return { changed: false, revision: transaction.revision, targetRevision }
        try {
          const runtime = await runtimeManager.apply()
          return {
            ...runtime,
            changed: true,
            revision: configManager.status?.().loadedRevision ?? transaction.revision,
            rollbackRevision: transaction.revision,
            targetRevision
          }
        } catch (error) {
          try {
            configManager.restoreRollback(transaction)
          } catch (restoreError) {
            const failure = publicError('rollback_restore_failed', 503, 'Rollback failed and the previous configuration could not be restored')
            failure.cause = restoreError
            throw failure
          }
          throw error
        }
      })
      sendJson(response, 202, result)
      return
    }
    if (url.pathname === '/admin/api/runtime' && request.method === 'GET') {
      sendJson(response, 200, runtimeManager?.status?.() ?? { active: null, transitioning: false, available: false })
      return
    }
    if (url.pathname === '/admin/api/runtime/apply' && request.method === 'POST') {
      requireAdminMutation(request, session)
      if (!runtimeManager?.apply) throw publicError('runtime_apply_unavailable', 409, 'Runtime apply is not available in this process')
      const result = await controlJobs.run('runtime-apply', async () => ({
        ...(await runtimeManager.apply()),
        revision: configManager?.status?.().loadedRevision ?? null
      }))
      sendJson(response, 200, result)
      return
    }
    if (url.pathname === '/admin/api/model-sync' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const requestedIds = Array.isArray(body.channels)
        ? body.channels
        : Array.isArray(body.channelIds)
          ? body.channelIds
          : []
      sendJson(response, 200, await controlJobs.run('model-sync', () => configManager.syncModels(requestedIds)))
      return
    }
    if (url.pathname === '/admin/api/channels' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const result = await controlJobs.run('channel-create', async () => {
        const created = configManager.createChannel(body)
        const sync = body.sync === true ? await configManager.syncModels([created.id]) : null
        return { ...created, ...(sync?.changed ? { revision: sync.revision } : {}), sync }
      })
      sendJson(response, result.sync ? 200 : 202, result)
      return
    }
    if (url.pathname === '/admin/api/channels/import' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const result = await controlJobs.run('channel-import', async () => {
        const imported = configManager.importChannel(body.id)
        const sync = body.sync === true ? await configManager.syncModels([imported.id]) : null
        return { imported, ...(sync?.changed ? { revision: sync.revision } : {}), sync }
      })
      sendJson(response, 200, result)
      return
    }
    const channelRoute = /^\/admin\/api\/channels\/([a-z][a-z0-9-]{0,31})$/.exec(url.pathname)
    if (channelRoute && request.method === 'PATCH') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      const result = await controlJobs.run('channel-update', () => {
        const updated = configManager.updateChannel(channelRoute[1], body)
        if (updated.staged || updated.enabled === false) scheduler.drainChannel?.(channelRoute[1])
        else if (updated.enabled === true) scheduler.resumeChannel?.(channelRoute[1])
        return updated
      })
      sendJson(response, 202, result)
      return
    }
    if (channelRoute && request.method === 'DELETE') {
      requireAdminMutation(request, session)
      requireConfigManager()
      if (scheduler.reservations.isBusy(channelRoute[1])) throw publicError('channel_busy', 409, 'A busy channel cannot be deleted')
      const result = await controlJobs.run('channel-delete', () => {
        const deleted = configManager.deleteChannel(channelRoute[1])
        scheduler.drainChannel?.(channelRoute[1])
        return deleted
      })
      sendJson(response, 202, result)
      return
    }
    if (url.pathname === '/admin/api/tests' && request.method === 'POST') {
      requireAdminMutation(request, session)
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 200, await runAdminTest(body))
      return
    }
    if (url.pathname === '/admin/api/protocols/apply' && request.method === 'POST') {
      requireAdminMutation(request, session)
      requireConfigManager()
      const body = await readJsonBody(request, requestBodyLimit())
      sendJson(response, 202, await controlJobs.run('protocol-update', () => applyTestedProtocol(body)))
      return
    }
    sendJson(response, 404, { error: { code: 'not_found', message: 'Admin route not found' } })
  }

  async function loginAdmin(request, response) {
    if (!config.managementKey) {
      sendJson(response, 404, { error: { code: 'admin_disabled', message: 'Admin access is disabled' } })
      return
    }
    const body = await readJsonBody(request, requestBodyLimit())
    const now = Date.now()
    pruneSessions(now)
    pruneLoginFailures(now)
    const clientKey = String(adminClientKey(request) ?? 'unknown').slice(0, 128)
    const prior = loginFailures.get(clientKey)
    if (prior?.blockedUntil > now) {
      const error = publicError('admin_login_rate_limited', 429, 'Too many failed admin logins; try again later')
      error.retryAfterMs = prior.blockedUntil - now
      throw error
    }
    const provided = typeof body.key === 'string' ? body.key : ''
    if (!safeEqual(provided, config.managementKey)) {
      if (!prior && loginFailures.size >= loginSourceLimit) {
        const error = publicError('admin_login_rate_limited', 429, 'Too many failed admin logins; try again later')
        error.retryAfterMs = ADMIN_LOGIN_WINDOW_MS
        throw error
      }
      const failures = prior?.windowStartedAt > now - ADMIN_LOGIN_WINDOW_MS ? (prior.failures + 1) : 1
      loginFailures.set(clientKey, {
        failures,
        windowStartedAt: failures === 1 ? now : prior.windowStartedAt,
        blockedUntil: failures >= ADMIN_LOGIN_MAX_FAILURES ? now + ADMIN_LOGIN_WINDOW_MS : 0
      })
      sendJson(response, 401, { error: { code: 'invalid_management_key', message: 'Invalid management key' } })
      return
    }
    loginFailures.delete(clientKey)
    evictOldestSessions(sessionLimit - 1)
    const token = crypto.randomBytes(32).toString('base64url')
    const csrfToken = crypto.randomBytes(24).toString('base64url')
    sessions.set(token, { token, csrfToken, expiresAt: now + ADMIN_SESSION_TTL_MS })
    sendJson(response, 200, { ok: true, csrfToken }, {
      'set-cookie': `cpa_admin=${token}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`
    })
  }

  async function runAdminTest(body) {
    if (configManager?.status()?.restartRequired) {
      throw publicError('restart_required', 409, 'Configuration has changed; restart the gateway before testing models')
    }
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!requestedModel) throw publicError('invalid_request', 400, 'Test body must include a model')
    const protocolOverride = normalizeConfigProtocol(body.protocolOverride, { optional: true })
    const adminCandidate = findAdminCandidate(requestedModel)
    const resolved = scheduler.catalog.resolve(requestedModel)
    if (!resolved && !adminCandidate) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${requestedModel}`)
    if (!resolved && adminCandidate) throw publicError('canary_not_supported', 409, 'Fixed text canary is available only for eligible generation models')
    if (!['direct', 'staged-direct'].includes(resolved.kind)) throw publicError('exact_model_required', 400, 'Manual tests require an exact channel/model id')
    if (!adminCandidate) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${requestedModel}`)
    if (!isCanaryEligible(adminCandidate)) {
      throw publicError('canary_not_supported', 409, 'Fixed text canary is available only for eligible generation models')
    }
    if (scheduler.isChannelDraining?.(adminCandidate.channelId) || scheduler.isCandidateSuppressed?.(adminCandidate.channelId, adminCandidate.upstreamModel)) {
      throw publicError('candidate_unavailable', 409, 'The selected model is draining or waiting for configuration apply')
    }
    const channelRuntime = scheduler.snapshot().channels[adminCandidate.channelId]
    if (channelRuntime?.health === 'cooling' && channelRuntime.cooldownUntil > Date.now()) {
      const error = publicError('channel_cooling', 429, 'The selected channel is cooling after a rate limit')
      error.retryAfterMs = channelRuntime.cooldownUntil - Date.now()
      throw error
    }
    const configuredProtocol = adminCandidate.protocol
    const actualProtocol = protocolOverride ?? configuredProtocol
    const cooldownKey = `${requestedModel}\0${actualProtocol}`
    const previousStartedAt = lastTestStarted.get(cooldownKey) ?? 0
    if (Date.now() - previousStartedAt < ADMIN_TEST_COOLDOWN_MS) {
      throw publicError('test_rate_limited', 429, 'This model and protocol were tested too recently')
    }
    const lease = scheduler.reservations.tryAcquire(adminCandidate.channelId, {
      source: 'manual-test',
      requestedModel,
      upstreamModel: adminCandidate.upstreamModel
    })
    if (!lease) throw new GatewayRoutingError('all_candidates_busy', 429, `Channel is busy for model: ${requestedModel}`)
    const selection = { ...lease, candidate: adminCandidate, resolved }
    lastTestStarted.set(cooldownKey, Date.now())
    const startedAt = monotonicNow()
    const wireProtocol = normalizeCanaryProtocol(actualProtocol)
    const requestShape = buildCanaryRequest(wireProtocol, selection.candidate.upstreamModel, CANARY_PROMPT)
    const transport = !protocolOverride && actualProtocol === 'responses' ? 'native-passthrough' : 'protocol-direct'
    const outboundBody = {
      ...requestShape.body,
      model: selection.candidate.upstreamModel
    }
    try {
      let result
      try {
        result = await dispatchPayload({
          url: new URL(requestShape.path, 'http://gateway.local'),
          outboundBody,
          selection,
          transport,
          incomingHeaders: canaryHeaders(wireProtocol),
          directProtocol: actualProtocol
        })
      } catch {
        if (actualProtocol === configuredProtocol) scheduler.recordTransportError(selection, elapsedMs(startedAt))
        return rememberTest(requestedModel, {
          ok: false,
          status: 'failed',
          error: 'transport_error',
          statusCode: null,
          protocol: actualProtocol,
          configuredProtocol,
          transport,
          latencyMs: elapsedMs(startedAt)
        })
      }
      const durationMs = elapsedMs(startedAt)
      if (result.statusCode < 200 || result.statusCode >= 300) {
        if (actualProtocol === configuredProtocol) {
          scheduler.recordOutcome(selection, {
            kind: 'http-failure',
            transient: result.statusCode >= 500,
            statusCode: result.statusCode,
            durationMs
          }, result.headers)
        }
        return rememberTest(requestedModel, {
          ok: false,
          status: 'failed',
          error: classifyCanaryError(result.statusCode),
          statusCode: result.statusCode,
          protocol: actualProtocol,
          configuredProtocol,
          transport,
          latencyMs: durationMs,
          diagnostics: { bodyBytes: Buffer.byteLength(result.body) }
        })
      }
      const diagnosis = diagnoseCanaryResponse(wireProtocol, result.body)
      if (actualProtocol === configuredProtocol) {
        scheduler.recordOutcome(selection, {
          kind: diagnosis.ok ? 'success' : 'http-failure',
          transient: false,
          statusCode: diagnosis.ok ? result.statusCode : null,
          durationMs
        }, result.headers)
      }
      if (!diagnosis.ok) {
        return rememberTest(requestedModel, {
          ok: false,
          status: 'failed',
          error: diagnosis.error,
          statusCode: result.statusCode,
          protocol: actualProtocol,
          configuredProtocol,
          transport,
          latencyMs: durationMs,
          diagnostics: diagnosis.diagnostics
        })
      }
      return rememberTest(requestedModel, {
        ok: true,
        status: 'success',
        statusCode: result.statusCode,
        protocol: actualProtocol,
        configuredProtocol,
        transport,
        latencyMs: durationMs,
        contentLength: diagnosis.contentLength,
        diagnostics: diagnosis.diagnostics
      })
    } finally {
      selection.release()
    }
  }

  function applyTestedProtocol(body) {
    const channel = typeof body.channel === 'string' ? body.channel.trim() : ''
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    const protocol = normalizeConfigProtocol(body.protocol)
    const scope = body.scope === 'channel' ? 'channel' : body.scope === 'model' ? 'model' : ''
    if (scope === 'channel') {
      throw publicError('channel_protocol_scope_not_supported', 409, 'A channel may contain models using different protocols; apply a protocol to an exact model')
    }
    const target = `${channel}/${model}`
    if (scope !== 'model' || !channel || !model) throw publicError('invalid_request', 400, 'Protocol apply requires an exact channel/model target and a valid scope')
    if (body.confirmTarget !== target || body.confirmProtocol !== protocol) {
      throw publicError('protocol_confirmation_required', 400, 'Protocol apply requires exact target and protocol confirmation')
    }
    const directId = `${channel}/${model}`
    const candidate = findAdminCandidate(directId)
    if (!candidate) throw new GatewayRoutingError('model_not_found', 404, `Unknown model: ${directId}`)
    if (candidate.kind !== 'generation') {
      if (body.confirmNonGeneration !== true) {
        throw publicError('non_generation_protocol_confirmation_required', 400, 'Non-generation protocol apply requires explicit confirmation')
      }
      return configManager.updateModelProtocol(channel, model, protocol)
    }
    const latest = protocolTests.get(`${directId}\0${protocol}`)
    if (!latest?.ok || latest.protocol !== protocol || Date.parse(latest.testedAt) < Date.now() - ADMIN_TEST_RESULT_TTL_MS) {
      throw publicError('protocol_test_required', 409, 'A recent successful test for this exact model and protocol is required')
    }
    return configManager.updateModelProtocol(channel, model, protocol)
  }

  function dispatchPayload({ url, outboundBody, selection, transport, incomingHeaders, directProtocol = null }) {
    const payload = Buffer.from(JSON.stringify(outboundBody))
    const direct = transport === 'native-passthrough' || Boolean(directProtocol)
    const target = direct
      ? {
          host: config.gateway.internal.host,
          port: selection.candidate.channel.listener,
          path: `${directUpstreamPath(selection.candidate.channel.upstream.pathname, url.pathname)}${url.search}`,
          credentials: protocolCredentials(directProtocol ?? selection.candidate.protocol, selection.candidate.channel.apiKey)
        }
      : {
          host: config.gateway.internal.host,
          port: internalCpaPort(),
          path: `${url.pathname}${url.search}`,
          credentials: `Bearer ${config.gatewayKey}`
        }
    return new Promise((resolve, reject) => {
      const upstreamRequest = http.request({
        host: target.host,
        port: target.port,
        path: target.path,
        method: 'POST',
        headers: forwardHeaders(incomingHeaders, payload.length, target.credentials, selection.reservation.requestId)
      }, upstreamResponse => {
        const chunks = []
        let size = 0
        upstreamResponse.on('data', chunk => {
          size += chunk.length
          if (size > requestBodyLimit()) {
            upstreamResponse.destroy(new Error('Canary response is too large'))
            return
          }
          chunks.push(chunk)
        })
        upstreamResponse.once('error', reject)
        upstreamResponse.once('end', () => resolve({
          statusCode: upstreamResponse.statusCode ?? 502,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }))
      })
      upstreamRequest.setTimeout(config.gateway.timeouts.serverSeconds * 1000, () => upstreamRequest.destroy(new Error('Upstream request timed out')))
      upstreamRequest.once('error', error => reject(error))
      upstreamRequest.end(payload)
    })
  }

  function adminStatus() {
    const snapshot = scheduler.snapshot()
    const configStatus = configManager?.status()
    const routing = configManager?.routing() ?? { stableAliases: config.stableAliases, pinnedAliases: config.pinnedAliases, logicalModels: config.logicalModels ?? [] }
    const channels = routing.channels ?? config.channels.map(channel => ({
      id: channel.id,
      name: channel.name,
      baseUrl: channel.upstream.toString(),
      enabled: channel.enabled,
      staged: channel.staged,
      runtimeEnabled: channel.runtimeEnabled,
      protocol: channel.protocol,
      priority: channel.priority ?? 0,
      modelCount: channel.models.length,
      hasApiKey: Boolean(channel.apiKey)
    }))
    return {
      ready: true,
      configRevision: configStatus?.revision ?? null,
      loadedRevision: configStatus?.loadedRevision ?? null,
      pendingRevision: configStatus?.pendingRevision ?? configStatus?.revision ?? null,
      restartRequired: configStatus?.restartRequired ?? false,
      revisionStorage: configStatus?.revisionStorage ?? null,
      stableAliases: routing.stableAliases,
      pinnedAliases: routing.pinnedAliases,
      logicalModels: routing.logicalModels ?? [],
      access: configManager?.access?.() ?? { enabled: Boolean(config.clientAccess), groups: [], clients: [] },
      reservations: snapshot.reservations,
      controlJobs: controlJobs.status(),
      runtime: runtimeManager?.status?.() ?? { active: null, transitioning: false, available: false },
      audit: auditStore.status(),
      draining: snapshot.draining ?? [],
      suppressedCandidates: snapshot.suppressedCandidates ?? [],
      lastTests: Object.fromEntries(lastTests),
      controlState: controlState.status(),
      channels: channels.map(channel => ({
        id: channel.id,
        name: channel.name,
        baseUrl: channel.baseUrl,
        enabled: channel.enabled,
        staged: channel.staged,
        runtimeEnabled: channel.runtimeEnabled,
        protocol: channel.protocol,
        priority: channel.priority,
        modelCount: channel.modelCount,
        hasApiKey: channel.hasApiKey,
        busy: snapshot.reservations.some(item => item.channelId === channel.id),
        draining: (snapshot.draining ?? []).includes(channel.id),
        health: snapshot.channels[channel.id]?.health ?? 'unknown',
        cooldownUntil: snapshot.channels[channel.id]?.cooldownUntil ?? null
      }))
    }
  }

  function adminConnection(request, reveal) {
    if (config.clientAccess) {
      return {
        baseUrl: `${connectionOrigin(request)}/v1`,
        mode: 'clients',
        apiKeyMasked: null
      }
    }
    return {
      baseUrl: `${connectionOrigin(request)}/v1`,
      mode: 'legacy',
      apiKeyMasked: maskSecret(config.gatewayKey),
      ...(reveal ? { apiKey: config.gatewayKey } : {})
    }
  }

  function reloadConfig(nextConfig, { markApplied = true } = {}) {
    if (!nextConfig || typeof nextConfig !== 'object') throw new TypeError('A runtime configuration is required')
    if (scheduler.reservations.snapshot().length) throw publicError('runtime_busy', 409, 'Cannot reload configuration while requests are active')
    const previousConfig = { ...config }
    const previousState = controlState.snapshot?.() ?? {
      schedulerState: controlState.schedulerState(),
      lastTests: controlState.lastTests()
    }
    try {
      const nextState = controlState.reconfigure(nextConfig)
      scheduler.reload(nextConfig, { initialState: nextState })
      Object.assign(config, nextConfig)
      pruneTestCooldowns()
      lastTests.clear()
      for (const [modelId, result] of Object.entries(controlState.lastTests())) lastTests.set(modelId, result)
      rebuildProtocolTests()
      if (markApplied) configManager?.markApplied?.(nextConfig.digest)
      return { configRevision: nextConfig.digest ?? null, controlState: controlState.status() }
    } catch (error) {
      Object.assign(config, previousConfig)
      try {
        const restoredState = controlState.restore
          ? controlState.restore(previousConfig, previousState)
          : previousState.schedulerState
        scheduler.reload(previousConfig, { initialState: restoredState })
        pruneTestCooldowns()
        lastTests.clear()
        for (const [modelId, result] of Object.entries(controlState.lastTests())) lastTests.set(modelId, result)
        rebuildProtocolTests()
      } catch (restoreError) {
        const failure = publicError('runtime_reload_failed', 503, 'Runtime configuration reload failed and could not be restored')
        failure.cause = restoreError
        throw failure
      }
      throw error
    }
  }

  function pruneTestCooldowns() {
    const validModels = new Set(
      [...scheduler.catalog.allModels.values()].flatMap(candidates => candidates.map(candidate => candidate.directAlias))
    )
    for (const modelId of lastTestStarted.keys()) {
      if (!validModels.has(modelId.split('\0', 1)[0])) lastTestStarted.delete(modelId)
    }
  }

  function requestBodyLimit() {
    return config.gateway.control.maxRequestBytes
  }

  function internalCpaPort() {
    return config.gateway.internal.cpaPort
  }

  function markConfigApplied(releaseDigest = config.digest) {
    return configManager?.markApplied?.(releaseDigest) ?? null
  }

  function rememberTest(modelId, result) {
    const summary = { ...result, testedAt: new Date().toISOString() }
    lastTests.set(modelId, summary)
    protocolTests.set(`${modelId}\0${summary.protocol}`, summary)
    controlState.rememberTest(modelId, summary)
    return summary
  }

  function rebuildProtocolTests() {
    protocolTests.clear()
    for (const [modelId, result] of lastTests) protocolTests.set(`${modelId}\0${result.protocol}`, result)
  }

  function protocolTestSummaries(modelId) {
    return Object.fromEntries([...CONFIG_PROTOCOLS].flatMap(protocol => {
      const result = protocolTests.get(`${modelId}\0${protocol}`)
      return result ? [[protocol, result]] : []
    }))
  }

  function adminModels() {
    const pending = configManager?.routing()
    const loadedCandidates = new Map(
      [...scheduler.catalog.allModels.values()].flat().map(candidate => [candidate.directAlias, candidate])
    )
    const models = pending
      ? pending.models.map(model => {
          const directId = `${model.channel}/${model.model}`
          const loaded = loadedCandidates.get(directId)
          return {
            channel: model.channel,
            upstreamModel: model.model,
            directId,
            protocol: model.protocol ?? loaded?.protocol ?? 'unknown',
            priority: model.priority ?? loaded?.priority ?? 0,
            kind: model.kind ?? loaded?.kind ?? 'generation',
            streaming: model.streaming ?? loaded?.streaming ?? 'both',
            canaryEligible: model.canaryEligible ?? loaded?.canaryEligible ?? true,
            staged: model.staged ?? Boolean(loaded?.channel.staged),
            channelEnabled: model.channelEnabled ?? Boolean(loaded?.channel.enabled),
            status: model.status ?? loaded?.model.status ?? 'active',
            busy: loaded ? scheduler.reservations.isBusy(model.channel) : false,
            draining: scheduler.isChannelDraining?.(model.channel) ?? false,
            suppressed: scheduler.isCandidateSuppressed?.(model.channel, model.model) ?? false,
            scheduling: loaded
              ? scheduler.candidateStatus?.(loaded) ?? null
              : { evidence: null, reasonCodes: ['configuration-pending-restart'] },
            lastTest: lastTests.get(directId) ?? null,
            protocolTests: protocolTestSummaries(directId)
          }
        })
      : [...scheduler.catalog.allModels.values()].flat().map(candidate => ({
          channel: candidate.channelId,
          upstreamModel: candidate.upstreamModel,
          directId: candidate.directAlias,
          protocol: candidate.protocol,
          priority: candidate.priority,
          kind: candidate.kind,
          streaming: candidate.streaming,
          canaryEligible: candidate.canaryEligible,
          staged: Boolean(candidate.channel.staged),
          channelEnabled: Boolean(candidate.channel.enabled),
          status: candidate.model.status ?? 'active',
          busy: scheduler.reservations.isBusy(candidate.channelId),
          draining: scheduler.isChannelDraining?.(candidate.channelId) ?? false,
          suppressed: scheduler.isCandidateSuppressed?.(candidate.channelId, candidate.upstreamModel) ?? false,
          scheduling: scheduler.candidateStatus?.(candidate) ?? null,
          lastTest: lastTests.get(candidate.directAlias) ?? null,
          protocolTests: protocolTestSummaries(candidate.directAlias)
        }))
    const groups = new Map()
    for (const candidate of models) {
      const group = groups.get(candidate.upstreamModel) ?? []
      group.push(candidate)
      groups.set(candidate.upstreamModel, group)
    }
    return [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, candidates]) => ({ id, candidates: candidates.sort((left, right) => left.channel.localeCompare(right.channel) || left.directId.localeCompare(right.directId)) }))
  }

  function findAdminCandidate(directId) {
    for (const candidates of scheduler.catalog.allModels.values()) {
      const candidate = candidates.find(item => item.directAlias === directId)
      if (candidate) return candidate
    }
    return null
  }

  function proxyRequest({ request, response, url, outboundBody, selection, transport, requestedModel, access, upstreamDirect = false }) {
    return new Promise(resolve => {
      const payload = Buffer.from(JSON.stringify(outboundBody))
      const startedAt = monotonicNow()
      const native = transport === 'native-passthrough'
      const direct = upstreamDirect === true
      const target = direct
        ? {
            protocol: selection.candidate.channel.upstream.protocol,
            hostname: selection.candidate.channel.upstream.hostname,
            port: selection.candidate.channel.upstream.port || undefined,
            path: `${directUpstreamPath(selection.candidate.channel.upstream.pathname, url.pathname)}${url.search}`,
            credentials: protocolCredentials(selection.candidate.protocol, selection.candidate.channel.apiKey)
          }
        : native
        ? {
            protocol: 'http:',
            host: config.gateway.internal.host,
            port: selection.candidate.channel.listener,
            path: `${appendPath(selection.candidate.channel.upstream.pathname, '/responses')}${url.search}`,
            credentials: `Bearer ${selection.candidate.channel.apiKey}`
          }
        : {
            protocol: 'http:',
            host: config.gateway.internal.host,
            port: internalCpaPort(),
            path: `${url.pathname}${url.search}`,
            credentials: `Bearer ${config.gatewayKey}`
          }
      const headers = forwardHeaders(request.headers, payload.length, target.credentials, selection.reservation.requestId)
      let completed = false
      let clientClosed = false
      let upstreamRequest
      let upstreamStatusCode = null
      let upstreamResponseHeaders = {}
      const finish = (outcome, observation = null) => {
        if (completed) return
        completed = true
        if (observation) scheduler.recordOutcome(selection, {
          ...observation,
          durationMs: observation.durationMs ?? elapsedMs(startedAt)
        }, upstreamResponseHeaders)
        usageMonitor.record({
          requestedModel,
          channelId: selection.candidate.channelId,
          logicalModelId: selection.resolved.logicalModelId,
          upstreamModel: selection.candidate.upstreamModel,
          clientId: access?.clientId,
          groupId: access?.groupId,
          outcome,
          transport
        })
        selection.release()
        resolve()
      }
      const onClientClose = () => {
        if (response.writableEnded) return
        clientClosed = true
        upstreamRequest?.destroy()
        finish('cancelled')
      }
      response.once('close', onClientClose)

      const requestModule = target.protocol === 'https:' ? https : http
      upstreamRequest = requestModule.request({
        ...(target.hostname ? { hostname: target.hostname } : { host: target.host }),
        port: target.port,
        path: target.path,
        method: 'POST',
        headers
      }, upstreamResponse => {
        const statusCode = upstreamResponse.statusCode ?? 502
        upstreamStatusCode = statusCode
        upstreamResponseHeaders = upstreamResponse.headers
        const responseHeaders = filteredResponseHeaders(upstreamResponse.headers)
        response.writeHead(statusCode, responseHeaders)
        upstreamResponse.once('end', () => finish(
          statusCode >= 200 && statusCode < 300 ? 'success' : 'failure',
          {
            kind: statusCode >= 200 && statusCode < 300 ? 'success' : 'http-failure',
            statusCode,
            transient: statusCode >= 500
          }
        ))
        upstreamResponse.once('close', () => finish('failure', {
          kind: 'transport-failure',
          transient: true,
          statusCode: upstreamStatusCode
        }))
        upstreamResponse.once('error', error => {
          if (!clientClosed) response.destroy(error)
          finish('failure', {
            kind: 'transport-failure',
            transient: true,
            statusCode: upstreamStatusCode
          })
        })
        upstreamResponse.pipe(response)
      })
      upstreamRequest.setTimeout(config.gateway.timeouts.serverSeconds * 1000, () => {
        const error = new Error('Upstream request timed out')
        error.code = 'ETIMEDOUT'
        upstreamRequest.destroy(error)
      })
      upstreamRequest.once('error', error => {
        if (!clientClosed) {
          if (!response.headersSent) sendJson(response, 502, { error: { code: 'upstream_unavailable', message: 'Upstream request failed' } })
          else response.destroy(error)
        }
        finish('failure', { kind: 'transport-failure', transient: true })
      })
      upstreamRequest.end(payload)
    })
  }

  function elapsedMs(startedAt) {
    const duration = monotonicNow() - startedAt
    return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0
  }

  return {
    server,
    scheduler,
    usageMonitor,
    auditStore,
    controlJobs,
    runtimeManager,
    reloadConfig,
    markConfigApplied,
    listen({ host = config.gateway.public.host, port } = {}) {
      const listenPort = port ?? Number(process.env[config.gateway.public.portEnv] || process.env.SERVER_PORT || process.env.PORT || config.gateway.public.defaultPort)
      return new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListening); reject(error) }
        const onListening = () => { server.removeListener('error', onError); resolve(server.address()) }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(listenPort, host)
      })
    },
    close() {
      if (!server.listening) return Promise.resolve()
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }

  function requireAdminSession(request) {
    pruneSessions()
    const token = parseCookie(request.headers.cookie).cpa_admin
    const session = token ? sessions.get(token) : null
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token)
      throw publicError('admin_unauthorized', 401, 'Admin session is missing or expired')
    }
    return session
  }

  function pruneSessions(now = Date.now()) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(token)
    }
  }

  function evictOldestSessions(retainCount) {
    while (sessions.size > retainCount) {
      const oldestToken = sessions.keys().next().value
      if (oldestToken === undefined) return
      sessions.delete(oldestToken)
    }
  }

  function pruneLoginFailures(now = Date.now()) {
    for (const [clientKey, attempt] of loginFailures) {
      if (attempt.blockedUntil <= now && attempt.windowStartedAt <= now - ADMIN_LOGIN_WINDOW_MS) loginFailures.delete(clientKey)
    }
  }

  function requireAdminMutation(request, session) {
    if (!sameOrigin(request)) throw publicError('invalid_origin', 403, 'Admin request origin is not allowed')
    const csrf = request.headers['x-csrf-token']
    if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) throw publicError('invalid_csrf', 403, 'CSRF validation failed')
  }

  function requireConfigManager() {
    if (!configManager) throw new ConfigMutationError('configuration_not_writable', 503, 'Private configuration paths are not available')
  }
}

function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    request.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settled = true
        request.resume()
        reject(publicError('request_too_large', 413, 'Request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    request.once('aborted', () => {
      if (settled) return
      settled = true
      reject(publicError('client_aborted', 400, 'Client aborted the request'))
    })
    request.once('error', reject)
    request.once('end', () => {
      if (settled) return
      settled = true
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('body must be an object')
        resolve(value)
      } catch {
        reject(publicError('invalid_json', 400, 'Request body must be valid JSON'))
      }
    })
  })
}

async function withSchedulerChannelLease(scheduler, channel, operation) {
  const lease = scheduler.reservations.tryAcquire(channel.id, {
    source: 'model-sync',
    requestedModel: 'model-catalog'
  })
  if (!lease) {
    throw new ConfigMutationError('model_sync_channel_busy', 409, `Channel is busy: ${channel.id}`)
  }
  try {
    return await operation()
  } finally {
    lease.release()
  }
}

function forwardHeaders(incoming, contentLength, credentials, requestId) {
  const connectionTokens = String(incoming.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set([
    ...HOP_BY_HOP,
    ...connectionTokens,
    'authorization',
    'x-api-key',
    'api-key',
    'host',
    'content-length',
    'content-encoding',
    'content-md5',
    'digest',
    'cookie',
    'x-request-id'
  ])
  const headers = {}
  for (const [name, value] of Object.entries(incoming)) {
    const lower = name.toLowerCase()
    if (value === undefined || blocked.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('cf-')) continue
    headers[lower] = value
  }
  if (typeof credentials === 'string') headers.authorization = credentials
  else Object.assign(headers, credentials)
  headers['content-length'] = String(contentLength)
  headers['content-type'] = headers['content-type'] ?? 'application/json'
  headers['x-request-id'] = normalizeRequestId(requestId)
  return headers
}

function filteredResponseHeaders(incoming) {
  const connectionTokens = String(incoming.connection ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  const blocked = new Set([...HOP_BY_HOP, ...connectionTokens, 'set-cookie', 'set-cookie2'])
  return Object.fromEntries(Object.entries(incoming).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())))
}

function normalizeRequestId(value) {
  const candidate = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate) ? candidate : crypto.randomUUID()
}

function resolveAdminClientKey(request, tunnelEnabled) {
  const peer = String(request.socket.remoteAddress ?? '').trim().toLowerCase()
  if (tunnelEnabled && isLoopbackAddress(peer)) {
    const forwarded = typeof request.headers['cf-connecting-ip'] === 'string'
      ? request.headers['cf-connecting-ip'].trim().toLowerCase()
      : ''
    if (isIP(forwarded)) return forwarded
  }
  return peer || 'unknown'
}

function isLoopbackAddress(value) {
  if (value === '::1') return true
  const ipv4 = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value
  return isIP(ipv4) === 4 && ipv4.startsWith('127.')
}

function appendPath(basePath, suffix) {
  const base = basePath === '/' ? '' : basePath.replace(/\/+$/, '')
  const path = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${base}${path}` || '/'
}

function directUpstreamPath(basePath, requestPath) {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/+$/, '')
  const normalizedRequest = requestPath.startsWith('/') ? requestPath : `/${requestPath}`
  const suffix = normalizedBase.endsWith('/v1') && normalizedRequest.startsWith('/v1/')
    ? normalizedRequest.slice('/v1'.length)
    : normalizedRequest
  return appendPath(normalizedBase || '/', suffix)
}

function protocolCredentials(protocol, apiKey) {
  return protocol === 'claude'
    ? { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` }
}

function connectionOrigin(request) {
  const host = String(request.headers.host ?? '').trim()
  if (!host || /[\r\n]/.test(host)) throw publicError('connection_origin_unavailable', 500, 'Public gateway origin is unavailable')
  const trustedOrigin = [request.headers.origin, request.headers.referer]
    .map(value => typeof value === 'string' ? value : '')
    .map(value => {
      try { return new URL(value) } catch { return null }
    })
    .find(value => value?.host.toLowerCase() === host.toLowerCase())
  if (trustedOrigin) return trustedOrigin.origin
  const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  const local = ['localhost', '127.0.0.1', '::1'].includes(hostname)
  const protocol = ['http', 'https'].includes(forwardedProto)
    ? forwardedProto
    : request.socket.encrypted || !local ? 'https' : 'http'
  return `${protocol}://${host}`
}

function maskSecret(value) {
  const secret = String(value ?? '')
  if (secret.length <= 8) return '*'.repeat(secret.length)
  return `${secret.slice(0, 4)}${'*'.repeat(Math.max(8, secret.length - 8))}${secret.slice(-4)}`
}

function authorizeGatewayRequest(request, config) {
  const provided = providedApiKey(request)
  if (typeof provided !== 'string') return null
  if (config.clientAccess) return resolveClient(config.clientAccess, provided)
  return safeEqual(provided, config.gatewayKey)
    ? { clientId: null, groupId: null, allowedChannels: null }
    : null
}

function providedApiKey(request) {
  const authorization = request.headers.authorization ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]
  const provided = bearer ?? request.headers['x-api-key']
  return typeof provided === 'string' ? provided : null
}

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ''))
  const right = Buffer.from(String(rightValue ?? ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function parseCookie(value = '') {
  return Object.fromEntries(value.split(';').map(item => item.trim().split('='))
    .filter(([name, content]) => name && content)
    .map(([name, ...content]) => [name, content.join('=')]))
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return false
  try {
    const parsed = new URL(origin)
    const host = String(request.headers.host ?? '').toLowerCase()
    return parsed.host.toLowerCase() === host && ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function canaryHeaders(protocol) {
  return protocol === 'claude'
    ? { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'user-agent': 'cpa-channel-gateway/1.0' }
    : { 'content-type': 'application/json', 'user-agent': 'cpa-channel-gateway/1.0' }
}

function normalizeConfigProtocol(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null
  const protocol = String(value ?? '').trim()
  if (!CONFIG_PROTOCOLS.has(protocol)) throw publicError('invalid_protocol', 400, `Unsupported protocol: ${protocol}`)
  return protocol
}

function classifyCanaryError(statusCode) {
  if (statusCode === 401 || statusCode === 403) return 'authentication_failed'
  if (statusCode === 402) return 'payment_blocked'
  if (statusCode === 429) return 'rate_limited'
  if (statusCode >= 500) return 'upstream_server_error'
  if ([400, 404, 405, 422].includes(statusCode)) return 'protocol_or_path_error'
  return 'unexpected_status'
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  if (response.headersSent || response.destroyed) return
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...extraHeaders
  })
  response.end(body)
}

function publicError(code, statusCode, message) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw publicError('invalid_path', 400, 'Request path is invalid')
  }
}

function publicErrorMessage(error, statusCode) {
  if (statusCode >= 500 && !(error instanceof GatewayRoutingError) && !(error instanceof ConfigMutationError)) return 'Internal gateway error'
  return error.message
}
