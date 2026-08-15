#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { parseEnv, readEnvFile, serializeEnv } from '../src/env.mjs'
import { mergeLegacyConfig, readLegacyChannels } from '../src/legacy.mjs'

const root = path.resolve(process.env.GATEWAY_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const args = process.argv.slice(2)
const merge = args.includes('--merge')
const replace = args.includes('--replace')
if (merge && replace) throw new Error('Choose either --merge or --replace')
const source = args.find(arg => !arg.startsWith('--'))
if (!source) throw new Error('Usage: npm run import:legacy -- <path> | npm run merge:legacy -- <path> | npm run replace:legacy -- <path>')
const values = parseEnv(fs.readFileSync(path.resolve(source), 'utf8'))
const channels = readLegacyChannels(values)

if (merge) {
  mergeIntoCurrent(root, channels)
} else {
  const output = { GATEWAY_API_KEY: process.env.GATEWAY_API_KEY || randomToken() }
  const routes = { schemaVersion: 1, channels: [], stableAliases: [], pinnedAliases: [] }
  for (const channel of channels) {
    const envPrefix = `CHANNEL_${channel.id.toUpperCase().replaceAll('-', '_')}`
    output[`${envPrefix}_NAME`] = channel.name
    output[`${envPrefix}_BASE_URL`] = channel.baseUrl
    output[`${envPrefix}_API_KEY`] = channel.apiKey
    output[`${envPrefix}_PROTOCOL`] = channel.protocol
    output[`${envPrefix}_ENABLED`] = 'false'
    routes.channels.push({ id: channel.id, enabled: false, models: [] })
  }
  const configDir = path.join(root, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const envPath = path.join(configDir, 'channels.local.env')
  const routesPath = path.join(configDir, 'routes.local.json')
  if (!replace && (fs.existsSync(envPath) || fs.existsSync(routesPath))) {
    throw new Error('Private configuration already exists; use merge:legacy to preserve it or replace:legacy for an intentional replacement')
  }
  fs.writeFileSync(envPath, serializeEnv(output), { mode: 0o600 })
  fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ channels: channels.map(item => ({ id: item.id, name: item.name, enabled: false })), output: 'config/channels.local.env', routes: 'config/routes.local.json' }, null, 2))
}

function mergeIntoCurrent(rootDir, legacyChannels) {
  const configDir = path.join(rootDir, 'config')
  const envPath = path.join(configDir, 'channels.local.env')
  const routesPath = path.join(configDir, 'routes.local.json')
  if (!fs.existsSync(envPath) || !fs.existsSync(routesPath)) throw new Error('Merge requires existing config/channels.local.env and config/routes.local.json')
  const currentEnv = readEnvFile(envPath)
  const currentRoutes = JSON.parse(fs.readFileSync(routesPath, 'utf8'))
  const merged = mergeLegacyConfig({ currentEnv, currentRoutes, legacyChannels })
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const backupDir = path.join(rootDir, 'runtime', 'config-revisions', `${stamp}-legacy-merge`)
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  fs.copyFileSync(envPath, path.join(backupDir, 'channels.local.env'))
  fs.copyFileSync(routesPath, path.join(backupDir, 'routes.local.json'))
  try {
    atomicWrite(envPath, serializeEnv(merged.env))
    atomicWrite(routesPath, JSON.stringify(merged.routes, null, 2) + '\n')
    loadConfig(rootDir)
  } catch (error) {
    atomicWrite(envPath, fs.readFileSync(path.join(backupDir, 'channels.local.env'), 'utf8'))
    atomicWrite(routesPath, fs.readFileSync(path.join(backupDir, 'routes.local.json'), 'utf8'))
    throw new Error('Legacy merge failed validation; original private configuration was restored', { cause: error })
  }
  console.log(JSON.stringify({ mode: 'merge', added: merged.report.added, updated: merged.report.updated, normalizedProtocols: merged.report.normalizedProtocols, normalizedBaseUrls: merged.report.normalizedBaseUrls, backup: path.relative(rootDir, backupDir).replaceAll('\\', '/') }, null, 2))
}

function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.tmp`
  fs.writeFileSync(temporaryPath, content, { mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

function randomToken() {
  return `gw_${crypto.randomBytes(32).toString('hex')}`
}
