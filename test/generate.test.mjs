import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { activateRelease, rollbackRelease } from '../src/generate.mjs'

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
