import assert from 'node:assert/strict'
import test from 'node:test'
import { findCpaBinary } from '../src/runtime.mjs'

test('finds the CPA binary name used by pinned no-plugin release archives', () => {
  assert.equal(
    findCpaBinary(['/tmp/release/LICENSE', '/tmp/release/cli-proxy-api']),
    '/tmp/release/cli-proxy-api'
  )
  assert.equal(findCpaBinary(['/tmp/legacy/CLIProxyAPI']), '/tmp/legacy/CLIProxyAPI')
  assert.throws(() => findCpaBinary(['/tmp/release/README.md']), /Expected one CPA binary, found 0/)
  assert.throws(
    () => findCpaBinary(['/tmp/release/cli-proxy-api', '/tmp/release/CLIProxyAPI']),
    /Expected one CPA binary, found 2/
  )
})
