import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { digestSnapshot } from './config-revisions.mjs'

const SCHEMA_VERSION = 1
const TRANSACTION_DIRECTORY = 'config-transaction'
const TEMPORARY_PREFIX = '.config-transaction-tmp-'

export function beginConfigTransaction(root, snapshot) {
  const normalized = normalizeSnapshot(snapshot)
  const runtimeDir = path.resolve(root, 'runtime')
  const transactionDir = path.join(runtimeDir, TRANSACTION_DIRECTORY)
  if (fs.existsSync(transactionDir)) throw new Error('A configuration transaction is already pending recovery')

  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  removeTemporaryTransactions(runtimeDir)
  const temporaryDir = path.join(runtimeDir, `${TEMPORARY_PREFIX}${process.pid}-${crypto.randomUUID()}`)
  try {
    fs.mkdirSync(temporaryDir, { mode: 0o700 })
    writeSnapshotDirectory(temporaryDir, normalized)
    fs.writeFileSync(path.join(temporaryDir, 'manifest.json'), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      contentDigest: digestSnapshot(normalized),
      files: {
        providers: normalized.providersText !== null,
        clients: normalized.clientsText !== null
      }
    }, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporaryDir, transactionDir)
  } catch (error) {
    try { fs.rmSync(temporaryDir, { recursive: true, force: true }) } catch {}
    throw error
  }
  return { root: path.resolve(root), directory: transactionDir }
}

export function commitConfigTransaction(transaction) {
  if (!transaction?.directory) return
  fs.rmSync(transaction.directory, { recursive: true, force: true })
}

export function rollbackConfigTransaction(transaction) {
  if (!transaction?.root || !transaction?.directory) return false
  const snapshot = readTransactionSnapshot(transaction.directory)
  writeConfigSnapshot(transaction.root, snapshot)
  commitConfigTransaction(transaction)
  return true
}

export function recoverConfigTransaction(root) {
  const runtimeDir = path.resolve(root, 'runtime')
  const transactionDir = path.join(runtimeDir, TRANSACTION_DIRECTORY)
  removeTemporaryTransactions(runtimeDir)
  if (!fs.existsSync(transactionDir)) return false
  rollbackConfigTransaction({ root: path.resolve(root), directory: transactionDir })
  return true
}

export function writeConfigSnapshot(root, snapshot) {
  const normalized = normalizeSnapshot(snapshot)
  const configDir = path.resolve(root, 'config')
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  writeOptional(path.join(configDir, 'providers.local.json'), normalized.providersText)
  writeOptional(path.join(configDir, 'clients.local.json'), normalized.clientsText)
  atomicWrite(path.join(configDir, 'channels.local.env'), normalized.envText)
  atomicWrite(path.join(configDir, 'routes.local.json'), normalized.routesText)
}

function readTransactionSnapshot(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  if (manifest?.schemaVersion !== SCHEMA_VERSION || !/^[a-f0-9]{64}$/.test(String(manifest.contentDigest ?? ''))) {
    throw new Error('Configuration recovery manifest is invalid')
  }
  const snapshot = {
    envText: fs.readFileSync(path.join(directory, 'channels.local.env'), 'utf8'),
    routesText: fs.readFileSync(path.join(directory, 'routes.local.json'), 'utf8'),
    providersText: manifest.files?.providers ? fs.readFileSync(path.join(directory, 'providers.local.json'), 'utf8') : null,
    clientsText: manifest.files?.clients ? fs.readFileSync(path.join(directory, 'clients.local.json'), 'utf8') : null
  }
  if (digestSnapshot(snapshot) !== manifest.contentDigest) throw new Error('Configuration recovery snapshot is corrupted')
  return snapshot
}

function writeSnapshotDirectory(directory, snapshot) {
  fs.writeFileSync(path.join(directory, 'channels.local.env'), snapshot.envText, { mode: 0o600 })
  fs.writeFileSync(path.join(directory, 'routes.local.json'), snapshot.routesText, { mode: 0o600 })
  if (snapshot.providersText !== null) fs.writeFileSync(path.join(directory, 'providers.local.json'), snapshot.providersText, { mode: 0o600 })
  if (snapshot.clientsText !== null) fs.writeFileSync(path.join(directory, 'clients.local.json'), snapshot.clientsText, { mode: 0o600 })
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.envText !== 'string' || typeof snapshot.routesText !== 'string') {
    throw new TypeError('A complete configuration snapshot is required')
  }
  return {
    envText: snapshot.envText,
    routesText: snapshot.routesText,
    providersText: typeof snapshot.providersText === 'string' ? snapshot.providersText : null,
    clientsText: typeof snapshot.clientsText === 'string' ? snapshot.clientsText : null
  }
}

function writeOptional(filePath, content) {
  if (content === null) {
    fs.rmSync(filePath, { force: true })
    return
  }
  atomicWrite(filePath, content)
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 })
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }) } catch {}
    throw error
  }
}

function removeTemporaryTransactions(runtimeDir) {
  if (!fs.existsSync(runtimeDir)) return
  for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(TEMPORARY_PREFIX)) {
      fs.rmSync(path.join(runtimeDir, entry.name), { recursive: true, force: true })
    }
  }
}
