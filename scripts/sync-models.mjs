#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { fetchChannelModels, selectChannelsForSync, synchronizeRouteModels } from '../src/model-sync.mjs'

const root = path.resolve(process.env.GATEWAY_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const config = loadConfig(root, { allowEmptyEnabledChannels: true })
const selected = selectChannelsForSync(config.channels, process.argv.slice(2))
if (!selected.length) throw new Error('No enabled channels are available for model synchronization')

const discoveries = new Map()
for (const channel of selected) {
  discoveries.set(channel.id, await fetchChannelModels(channel))
}

const { routes, summaries } = synchronizeRouteModels(config.routes, discoveries)
const current = JSON.stringify(config.routes, null, 2) + '\n'
const next = JSON.stringify(routes, null, 2) + '\n'
if (next === current) {
  console.log(JSON.stringify({ changed: false, channels: summaries }, null, 2))
  process.exit(0)
}

const routesPath = config.paths.routesPath
const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
const backupPath = path.join(path.dirname(routesPath), `routes.local.pre-model-sync-${stamp}.json`)
const temporaryPath = `${routesPath}.tmp`
fs.copyFileSync(routesPath, backupPath)
try {
  fs.writeFileSync(temporaryPath, next, { mode: 0o600 })
  fs.renameSync(temporaryPath, routesPath)
  loadConfig(root)
} catch (error) {
  fs.copyFileSync(backupPath, routesPath)
  fs.rmSync(temporaryPath, { force: true })
  throw new Error('Model synchronization failed validation; the original routes were restored', { cause: error })
}

console.log(JSON.stringify({
  changed: true,
  channels: summaries,
  backup: path.relative(root, backupPath).replaceAll('\\', '/')
}, null, 2))
