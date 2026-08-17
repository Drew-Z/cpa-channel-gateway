import fs from 'node:fs'
import path from 'node:path'

const VERSION = 1
const RESULTS = new Set(['success', 'failure'])
const OPERATION = /^[a-z][a-z0-9-]{0,63}$/
const ERROR_CODE = /^[a-z][a-z0-9_-]{0,63}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function createAuditEventStore(config, {
  filePath = defaultFilePath(config),
  now = () => Date.now(),
  maxEntries = 500,
  maxBytes = 1024 * 1024
} = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new TypeError('maxBytes must be at least 256')
  let events = []
  let writable = Boolean(filePath)

  if (filePath && fs.existsSync(filePath)) load()

  return {
    record(input) {
      const event = normalizeEvent(input, now())
      if (!event) return false
      events.push(event)
      const compacted = boundEvents(events, maxEntries, maxBytes)
      const needsRewrite = compacted.length !== events.length
      events = compacted
      if (filePath && writable) {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
          if (needsRewrite || (fs.existsSync(filePath) && fs.statSync(filePath).size + lineBytes(event) > maxBytes)) rewrite()
          else fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
        } catch {
          writable = false
        }
      }
      return true
    },
    list({ limit = 100 } = {}) {
      const boundedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100
      return events.slice(-boundedLimit).reverse().map(event => ({ ...event }))
    },
    status() {
      return {
        storage: !filePath ? 'memory' : writable ? 'persistent' : 'memory-fallback',
        count: events.length
      }
    }
  }

  function load() {
    let needsRewrite = false
    try {
      const parsed = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap(line => {
        if (!line) return []
        try {
          const event = normalizePersistedEvent(JSON.parse(line))
          if (!event) {
            needsRewrite = true
            return []
          }
          return [event]
        } catch {
          needsRewrite = true
          return []
        }
      })
      events = boundEvents(parsed, maxEntries, maxBytes)
      if (events.length !== parsed.length) needsRewrite = true
      if (needsRewrite) rewrite()
    } catch {
      events = []
      writable = false
    }
  }

  function rewrite() {
    const temporary = `${filePath}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporary, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 })
    fs.renameSync(temporary, filePath)
  }
}

function normalizeEvent(input, timestamp) {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(timestamp) || timestamp < 0) return null
  const jobId = identifier(input.jobId)
  const operation = String(input.operation ?? '')
  const result = String(input.result ?? '')
  const durationMs = nonNegativeInteger(input.durationMs)
  if (!jobId || !OPERATION.test(operation) || !RESULTS.has(result) || durationMs === null) return null
  const revision = input.revision === undefined || input.revision === null ? null : identifier(input.revision)
  if (input.revision !== undefined && input.revision !== null && !revision) return null
  const event = {
    v: VERSION,
    at: new Date(timestamp).toISOString(),
    jobId,
    operation,
    result,
    revision,
    durationMs
  }
  if (result === 'failure') {
    const errorCode = String(input.errorCode ?? '')
    if (!ERROR_CODE.test(errorCode)) return null
    event.errorCode = errorCode
  }
  return event
}

function normalizePersistedEvent(value) {
  if (!value || value.v !== VERSION || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null
  const normalized = normalizeEvent(value, Date.parse(value.at))
  if (!normalized || normalized.at !== new Date(value.at).toISOString()) return null
  return normalized
}

function boundEvents(input, maxEntries, maxBytes) {
  const events = input.slice(-maxEntries)
  while (events.length && Buffer.byteLength(events.map(event => `${JSON.stringify(event)}\n`).join(''), 'utf8') > maxBytes) events.shift()
  return events
}

function lineBytes(event) {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8')
}

function identifier(value) {
  const text = String(value ?? '').trim()
  return IDENTIFIER.test(text) ? text : null
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function defaultFilePath(config) {
  const routesPath = config?.paths?.routesPath
  if (!routesPath) return null
  return path.join(path.dirname(path.dirname(routesPath)), 'runtime', 'audit-events.jsonl')
}
