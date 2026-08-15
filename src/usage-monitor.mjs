import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_WINDOW_HOURS = 24
const RETENTION_MS = 26 * 60 * 60 * 1000
const COMPACTION_INTERVAL_MS = 60 * 60 * 1000
const MAX_EVENTS = 50_000
const OUTCOMES = new Set(['success', 'failure', 'cancelled'])
const TRANSPORTS = new Set(['native-passthrough', 'adapted', 'unassigned'])

export function createUsageMonitor(config, { filePath = defaultFilePath(config), now = () => Date.now() } = {}) {
  let events = []
  let writable = Boolean(filePath)
  let lastCompactedAt = now()

  if (filePath) loadPersistedEvents()

  return {
    record(input) {
      const event = normalizeEvent(input, now())
      if (!event) return false
      events.push(event)
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS)
      if (filePath && writable) {
        try {
          fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
          fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, { mode: 0o600 })
          if (event.at - lastCompactedAt >= COMPACTION_INTERVAL_MS) compact(event.at)
        } catch {
          writable = false
        }
      }
      return true
    },
    snapshot({ hours = DEFAULT_WINDOW_HOURS } = {}) {
      const boundedHours = Number.isInteger(hours) && hours >= 1 && hours <= DEFAULT_WINDOW_HOURS
        ? hours
        : DEFAULT_WINDOW_HOURS
      const to = now()
      const from = to - boundedHours * 60 * 60 * 1000
      const recent = events.filter(event => event.at >= from && event.at <= to)
      return buildSnapshot(recent, {
        hours: boundedHours,
        from,
        to,
        storage: !filePath ? 'memory' : writable ? 'persistent' : 'memory-fallback'
      })
    }
  }

  function loadPersistedEvents() {
    if (!fs.existsSync(filePath)) return
    try {
      const cutoff = now() - RETENTION_MS
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
      let needsCompaction = false
      events = lines.flatMap(line => {
        if (!line) return []
        try {
          const event = normalizePersistedEvent(JSON.parse(line))
          if (!event || event.at < cutoff) {
            needsCompaction = true
            return []
          }
          return [event]
        } catch {
          needsCompaction = true
          return []
        }
      }).slice(-MAX_EVENTS)
      if (events.length === MAX_EVENTS) needsCompaction = true
      if (needsCompaction) compact(now())
    } catch {
      events = []
      writable = false
    }
  }

  function compact(timestamp) {
    const cutoff = timestamp - RETENTION_MS
    events = events.filter(event => event.at >= cutoff).slice(-MAX_EVENTS)
    const temporary = `${filePath}.tmp-${process.pid}`
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    fs.writeFileSync(temporary, events.map(event => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), { mode: 0o600 })
    fs.renameSync(temporary, filePath)
    lastCompactedAt = timestamp
  }
}

function defaultFilePath(config) {
  const routesPath = config.paths?.routesPath
  if (!routesPath) return null
  return path.join(path.dirname(path.dirname(routesPath)), 'runtime', 'usage-events.jsonl')
}

function normalizeEvent(input, at) {
  if (!input || typeof input !== 'object' || !Number.isSafeInteger(at) || at < 0) return null
  const requestedModel = boundedText(input.requestedModel, 255)
  const outcome = String(input.outcome ?? '')
  const transport = String(input.transport ?? 'unassigned')
  if (!requestedModel || !OUTCOMES.has(outcome) || !TRANSPORTS.has(transport)) return null
  return {
    v: 1,
    at,
    requestedModel,
    channelId: boundedText(input.channelId, 32),
    upstreamModel: boundedText(input.upstreamModel, 255),
    outcome,
    transport
  }
}

function normalizePersistedEvent(value) {
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.at) || value.at < 0) return null
  return normalizeEvent(value, value.at)
}

function boundedText(value, maxLength) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (!text || text.length > maxLength || /[\r\n\0]/.test(text)) return null
  return text
}

function buildSnapshot(events, { hours, from, to, storage }) {
  const overall = emptyStats()
  const models = new Map()
  const logicalModels = new Map()
  const physicalModels = new Map()
  const channels = new Map()

  for (const event of events) {
    addOutcome(overall, event)
    addOutcome(getStats(models, event.requestedModel), event)
    if (event.upstreamModel) addOutcome(getStats(logicalModels, event.upstreamModel), event)
    if (event.channelId) addOutcome(getStats(channels, event.channelId), event)
    if (event.channelId && event.upstreamModel) {
      addOutcome(getStats(physicalModels, `${event.channelId}/${event.upstreamModel}`), event)
    }
  }

  return {
    windowHours: hours,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    storage,
    summary: finalizeStats(overall),
    models: finalizeMap(models),
    logicalModels: finalizeMap(logicalModels),
    physicalModels: finalizeMap(physicalModels),
    channels: finalizeMap(channels)
  }
}

function emptyStats() {
  return { total: 0, success: 0, failure: 0, cancelled: 0, nativePassthrough: 0, adapted: 0, lastSeenAt: 0 }
}

function getStats(collection, id) {
  if (!collection.has(id)) collection.set(id, emptyStats())
  return collection.get(id)
}

function addOutcome(stats, event) {
  stats.total += 1
  stats[event.outcome] += 1
  if (event.transport === 'native-passthrough') stats.nativePassthrough += 1
  if (event.transport === 'adapted') stats.adapted += 1
  stats.lastSeenAt = Math.max(stats.lastSeenAt, event.at)
}

function finalizeMap(collection) {
  return [...collection.entries()]
    .map(([id, stats]) => ({ id, ...finalizeStats(stats) }))
    .sort((left, right) => right.total - left.total || left.id.localeCompare(right.id))
}

function finalizeStats(stats) {
  return {
    total: stats.total,
    success: stats.success,
    failure: stats.failure,
    cancelled: stats.cancelled,
    successRate: stats.total ? Number((stats.success / stats.total * 100).toFixed(2)) : null,
    nativePassthrough: stats.nativePassthrough,
    adapted: stats.adapted,
    lastSeenAt: stats.lastSeenAt ? new Date(stats.lastSeenAt).toISOString() : null
  }
}
