#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyProviderMigration, planProviderMigration } from '../src/provider-migration.mjs'

const root = path.resolve(process.env.GATEWAY_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('Usage: npm run migrate:providers -- [--dry-run|--apply]')
  process.exit(0)
}
if (args.includes('--dry-run') && args.includes('--apply')) throw new Error('Choose either --dry-run or --apply')

try {
  const plan = planProviderMigration(root)
  const result = args.includes('--apply') ? applyProviderMigration(plan) : { ...plan.report, applied: false, dryRun: true }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: typeof error?.code === 'string' ? error.code : 'provider_migration_failed'
  }))
  process.exitCode = 1
}
