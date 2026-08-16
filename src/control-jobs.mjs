import crypto from 'node:crypto'

const DEFAULT_MAX_QUEUED = 16
const DEFAULT_MAX_HISTORY = 50
const JOB_TYPES = new Set([
  'model-sync',
  'channel-create',
  'channel-import',
  'channel-update',
  'channel-delete',
  'model-update',
  'alias-update',
  'runtime-apply',
  'runtime-rollback'
])

export class ControlJobError extends Error {
  constructor(code, statusCode, message) {
    super(message)
    this.name = 'ControlJobError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function createControlJobQueue({
  maxQueued = DEFAULT_MAX_QUEUED,
  maxHistory = DEFAULT_MAX_HISTORY,
  now = () => Date.now(),
  idFactory = () => crypto.randomUUID()
} = {}) {
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new TypeError('maxQueued must be a positive integer')
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1) throw new TypeError('maxHistory must be a positive integer')

  const pending = []
  const history = []
  let running = null

  function run(type, task) {
    const normalizedType = normalizeJobType(type)
    if (typeof task !== 'function') throw new TypeError('A control job must provide a task function')
    if (pending.length >= maxQueued) {
      return Promise.reject(new ControlJobError('control_queue_full', 429, 'Too many configuration jobs are waiting'))
    }
    const job = {
      id: idFactory(),
      type: normalizedType,
      submittedAt: isoNow(),
      startedAt: null,
      finishedAt: null,
      status: 'queued',
      error: null,
      task,
      resolve: null,
      reject: null
    }
    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
    })
    pending.push(job)
    pump().catch(() => {})
    return promise
  }

  function status() {
    return {
      active: running ? publicJob(running) : null,
      queued: pending.length,
      recent: history.map(publicJob)
    }
  }

  async function pump() {
    if (running || !pending.length) return
    const job = pending.shift()
    running = job
    job.status = 'running'
    job.startedAt = isoNow()
    try {
      const result = await job.task()
      finish(job, 'completed')
      job.resolve(result)
    } catch (error) {
      job.error = classifyError(error)
      finish(job, 'failed')
      job.reject(error)
    } finally {
      running = null
      await pump()
    }
  }

  function finish(job, statusValue) {
    job.status = statusValue
    job.finishedAt = isoNow()
    history.push(job)
    while (history.length > maxHistory) history.shift()
  }

  function isoNow() {
    return new Date(now()).toISOString()
  }

  return { run, status }
}

function normalizeJobType(value) {
  const type = String(value ?? '').trim()
  if (!JOB_TYPES.has(type)) throw new ControlJobError('invalid_control_job', 400, `Unsupported control job: ${type}`)
  return type
}

function classifyError(error) {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(error.code)
    ? error.code
    : 'control_job_failed'
  const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
    ? error.statusCode
    : 500
  return { code, statusCode }
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    submittedAt: job.submittedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    ...(job.error ? { error: { ...job.error } } : {})
  }
}
