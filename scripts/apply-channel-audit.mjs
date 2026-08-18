#!/usr/bin/env node
import fs from 'node:fs'
import { loadConfig } from '../src/config.mjs'
import { createPrivateConfigManager } from '../src/config-manager.mjs'

const auditPath = process.argv[2]
if (!auditPath) throw new Error('Usage: node scripts/apply-channel-audit.mjs <runtime/model-audits/audit.json> [coding-main channel/model] [coding-backup channel/model]')
const report = JSON.parse(fs.readFileSync(auditPath, 'utf8'))
const manager = createPrivateConfigManager(loadConfig(process.cwd(), { allowEmptyEnabledChannels: true }))
if (!manager) throw new Error('Private configuration paths are unavailable')
const aliases = {}
for (const [name, value] of [['coding-main', process.argv[3]], ['coding-backup', process.argv[4]]]) {
  if (!value) continue
  const separator = value.indexOf('/')
  if (separator <= 0) throw new Error(`Alias target must be channel/model: ${value}`)
  aliases[name] = { channel: value.slice(0, separator), model: value.slice(separator + 1) }
}
const result = manager.applyCanaryAudit(report, { stableAliases: aliases })
console.log(JSON.stringify({
  revision: result.revision,
  restartRequired: result.restartRequired,
  tested: result.tested,
  successful: result.successful,
  changedChannels: result.changedChannels,
  disabledModels: result.disabledModels,
  aliases: result.aliases
}, null, 2))
