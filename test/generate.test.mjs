import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { activateRelease, pruneReleases, rollbackRelease } from '../src/generate.mjs'

test('re-activating the current release preserves the real rollback target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-'))
  const runtime = path.join(root, 'runtime')
  fs.mkdirSync(path.join(runtime, 'releases', 'release-a'), { recursive: true })
  fs.mkdirSync(path.join(runtime, 'releases', 'release-b'), { recursive: true })

  activateRelease(root, { digest: 'release-a', releaseDir: path.join(runtime, 'releases', 'release-a') })
  const activated = activateRelease(root, { digest: 'release-b', releaseDir: path.join(runtime, 'releases', 'release-b') })
  const repeated = activateRelease(root, { digest: 'release-b', releaseDir: path.join(runtime, 'releases', 'release-b') })
  assert.equal(activated.previous, 'release-a')
  assert.deepEqual(repeated, activated)
  assert.equal(rollbackRelease(root).active, 'release-a')
})

test('release pruning protects active and previous releases and keeps a bounded tail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-prune-'))
  const runtime = path.join(root, 'runtime')
  const releases = path.join(runtime, 'releases')
  fs.mkdirSync(releases, { recursive: true })
  for (const [index, id] of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd', 'eeeeeeeeeeeeeeee'].entries()) {
    const directory = path.join(releases, id)
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ generatedAt: new Date(1_000 + index).toISOString() }))
  }
  fs.writeFileSync(path.join(runtime, 'active.json'), JSON.stringify({ active: 'eeeeeeeeeeeeeeee', previous: 'dddddddddddddddd' }))
  const result = pruneReleases(root, { keepExtra: 1 })
  assert.deepEqual(result.retained.sort(), ['cccccccccccccccc', 'dddddddddddddddd', 'eeeeeeeeeeeeeeee'].sort())
  assert.deepEqual(result.removed.sort(), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'].sort())
  assert.equal(fs.existsSync(path.join(releases, 'dddddddddddddddd')), true)
  assert.equal(fs.existsSync(path.join(releases, 'aaaaaaaaaaaaaaaa')), false)
})
