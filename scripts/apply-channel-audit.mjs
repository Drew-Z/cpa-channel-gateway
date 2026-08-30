#!/usr/bin/env node
import fs from 'node:fs'
import { loadConfig } from '../src/config.mjs'
import { createPrivateConfigManager } from '../src/config-manager.mjs'

const auditPath = process.argv[2]
if (!auditPath) throw new Error('Usage: node scripts/apply-channel-audit.mjs <runtime/model-audits/audit.json> [coding-main channel/model] [coding-backup channel/model] --confirm [--enable-channel channel] [--disable-model channel/model]')
const report = JSON.parse(fs.readFileSync(auditPath, 'utf8'))
const manager = createPrivateConfigManager(loadConfig(process.cwd(), { allowEmptyEnabledChannels: true }))
if (!manager) throw new Error('Private configuration paths are unavailable')
if (!process.argv.includes('--confirm')) throw new Error('Applying an audit requires the explicit --confirm flag')
const aliases = {}
const positionalAliases = []
for (const value of process.argv.slice(3)) {
  if (value.startsWith('--')) break
  positionalAliases.push(value)
}
for (const [name, value] of [['coding-main', positionalAliases[0]], ['coding-backup', positionalAliases[1]]]) {
  if (!value) continue
  const separator = value.indexOf('/')
  if (separator <= 0) throw new Error(`Alias target must be channel/model: ${value}`)
  aliases[name] = { channel: value.slice(0, separator), model: value.slice(separator + 1) }
}
const approvedChannels = valuesAfter('--enable-channel')
const approvedModels = valuesAfter('--disable-model')
for (const target of Object.values(aliases)) {
  approvedChannels.push(target.channel)
  approvedModels.push(`${target.channel}/${target.model}`)
}
const result = manager.applyCanaryAudit(report, {
  confirm: true,
  approvedChannels: [...new Set(approvedChannels)],
  approvedModels: [...new Set(approvedModels)],
  stableAliases: aliases
})
console.log(JSON.stringify({
  revision: result.revision,
  restartRequired: result.restartRequired,
  tested: result.tested,
  successful: result.successful,
  changedChannels: result.changedChannels,
  disabledModels: result.disabledModels,
  aliases: result.aliases
}, null, 2))

function valuesAfter(flag) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== flag) continue
    const value = process.argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    values.push(value)
  }
  return values
}
