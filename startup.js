import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparePterodactylStart } from './src/startup-preparation.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))

try {
  await preparePterodactylStart({ root })
  await import('./index.js')
} catch (error) {
  console.error(`Production startup failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
