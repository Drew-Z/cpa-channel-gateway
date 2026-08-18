import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scope = ['--', 'admin/dist']

const trackedChanges = git(['diff', '--name-only', 'HEAD', ...scope])
const untrackedFiles = git(['ls-files', '--others', '--exclude-standard', ...scope])

if (trackedChanges || untrackedFiles) {
  console.error('admin/dist is not identical to the committed build output.')
  if (trackedChanges) console.error(`Changed files:\n${trackedChanges}`)
  if (untrackedFiles) console.error(`Untracked files:\n${untrackedFiles}`)
  process.exit(1)
}

console.log('admin/dist matches the committed build output.')

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  } catch (error) {
    const detail = error?.stderr?.toString?.().trim() || error?.message || 'unknown git error'
    throw new Error(`Unable to inspect admin/dist: ${detail}`)
  }
}
