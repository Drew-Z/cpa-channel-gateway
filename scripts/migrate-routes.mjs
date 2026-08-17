import { loadConfig } from '../src/config.mjs'
import { createPrivateConfigManager } from '../src/config-manager.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const unknown = args.filter(value => value !== '--apply')
if (unknown.length) {
  console.error('Usage: npm run migrate:routes -- [--apply]')
  process.exitCode = 2
} else {
  try {
    const root = process.cwd()
    const config = loadConfig(root, { allowEmptyEnabledChannels: true })
    const changed = config.routes.schemaVersion !== 2 || !Array.isArray(config.routes.logicalModels)
    if (!apply) {
      console.log(JSON.stringify({
        mode: 'dry-run',
        changed,
        fromSchemaVersion: config.routes.schemaVersion,
        toSchemaVersion: 2,
        logicalModelCount: config.logicalModels.length
      }, null, 2))
    } else {
      const manager = createPrivateConfigManager(config)
      if (!manager) throw new Error('Private configuration is not writable')
      const result = manager.migrateRoutesSchema()
      console.log(JSON.stringify({
        mode: 'apply',
        changed: result.changed,
        fromSchemaVersion: result.fromSchemaVersion,
        toSchemaVersion: result.toSchemaVersion,
        logicalModelCount: result.logicalModelCount,
        revision: result.revision,
        restartRequired: result.restartRequired
      }, null, 2))
    }
  } catch {
    console.error('Routes schema migration failed validation; private configuration was not changed')
    process.exitCode = 1
  }
}
