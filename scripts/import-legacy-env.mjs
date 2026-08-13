#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, serializeEnv } from '../src/env.mjs'

const root = path.resolve(process.env.GATEWAY_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const source = process.argv[2]
if (!source) throw new Error('Usage: npm run import:legacy -- <path-to-private-env>')
const values = parseEnv(fs.readFileSync(path.resolve(source), 'utf8'))
const output = {}
const channels = []
for (const suffix of ['', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
  const provider = values[suffix ? `PROVIDER_NAME${suffix}` : 'AI_PROVIDER_NAME']
  const baseUrl = values[suffix ? `BASE_URL${suffix}` : 'AI_BASE_URL']
  const apiKey = values[suffix ? `API_KEY${suffix}` : 'AI_API_KEY']
  if (!provider && !baseUrl && !apiKey) continue
  if (!provider || !baseUrl || !apiKey) throw new Error(`Incomplete legacy channel suffix ${suffix || '0'}`)
  const id = slugify(provider)
  if (channels.some(item => item.id === id)) throw new Error(`Duplicate generated channel id: ${id}`)
  channels.push({ id, name: provider, baseUrl, apiKey, protocol: values[suffix ? `API_PROTOCOL${suffix}` : 'AI_API_PROTOCOL'] || 'openai-compatible' })
}
if (!channels.length) throw new Error('No legacy channels found')
output.GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || randomToken()
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
fs.writeFileSync(path.join(configDir, 'channels.local.env'), serializeEnv(output), { mode: 0o600 })
fs.writeFileSync(path.join(configDir, 'routes.local.json'), JSON.stringify(routes, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ channels: channels.map(item => ({ id: item.id, name: item.name, enabled: false })), output: 'config/channels.local.env', routes: 'config/routes.local.json' }, null, 2))

function slugify(value) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!result) throw new Error(`Cannot derive channel id from ${value}`)
  return result.slice(0, 32)
}

function randomToken() {
  return `gw_${randomBytes(32)}`
}

function randomBytes(size) {
  return crypto.randomBytes(size).toString('hex')
}
