import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { cloudflaredAssetName, findCpaBinary, runtimeInstallPlan, runtimeNeedsInstall, stageOpenSslHeaders, stageOpenSslLibraries } from '../src/runtime.mjs'

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

test('selects pinned cloudflared assets and requires the complete runtime set', () => {
  assert.equal(cloudflaredAssetName('aarch64'), 'cloudflared-linux-arm64')
  assert.equal(cloudflaredAssetName('amd64'), 'cloudflared-linux-amd64')
  assert.throws(() => cloudflaredAssetName('riscv64'), /Unsupported cloudflared architecture/)

  const expected = { cpaVersion: '1.2.3', haproxyVersion: '3.2.1', cloudflaredVersion: '2026.8.1' }
  const installed = { ...expected, platform: 'linux', arch: 'aarch64' }
  const present = new Set(['CLIProxyAPI', 'haproxy', 'cloudflared'].map(name => path.join('/runtime', name)))
  const runtime = { expected, installed, binDir: '/runtime', platform: 'linux', arch: 'aarch64', exists: file => present.has(file) }
  assert.equal(runtimeNeedsInstall(runtime), false)
  present.delete(path.join('/runtime', 'cloudflared'))
  assert.deepEqual(runtimeInstallPlan(runtime), ['cloudflared'])
  assert.equal(runtimeNeedsInstall(runtime), true)
  assert.equal(runtimeNeedsInstall({ ...runtime, installed: { ...installed, cloudflaredVersion: 'old' }, exists: () => true }), true)
  assert.deepEqual(
    runtimeInstallPlan({ ...runtime, arch: 'amd64', exists: () => true }),
    ['cpa', 'haproxy', 'cloudflared']
  )
})

test('stages Debian multiarch OpenSSL headers and shared linker names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-openssl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const generic = path.join(root, 'usr', 'include', 'openssl')
  const multiarch = path.join(root, 'usr', 'include', 'x86_64-linux-gnu', 'openssl')
  const systemLib = path.join(root, 'system-lib')
  fs.mkdirSync(generic, { recursive: true })
  fs.mkdirSync(multiarch, { recursive: true })
  fs.mkdirSync(systemLib)
  fs.writeFileSync(path.join(generic, 'ssl.h'), 'ssl')
  fs.writeFileSync(path.join(generic, 'macros.h'), 'macros')
  fs.writeFileSync(path.join(multiarch, 'opensslconf.h'), 'conf')
  fs.writeFileSync(path.join(multiarch, 'configuration.h'), 'configuration')
  fs.writeFileSync(path.join(systemLib, 'libssl.so.3'), 'shared ssl')
  fs.writeFileSync(path.join(systemLib, 'libcrypto.so.3'), 'shared crypto')

  const include = stageOpenSslHeaders(root)
  const libraries = stageOpenSslLibraries(root, { arch: 'x64', libraryRoots: [systemLib] })
  assert.equal(fs.readFileSync(path.join(include, 'openssl', 'ssl.h'), 'utf8'), 'ssl')
  assert.equal(fs.readFileSync(path.join(include, 'openssl', 'opensslconf.h'), 'utf8'), 'conf')
  assert.equal(fs.readFileSync(path.join(include, 'openssl', 'configuration.h'), 'utf8'), 'configuration')
  assert.equal(fs.readFileSync(path.join(libraries, 'libssl.so'), 'utf8'), 'shared ssl')
  assert.equal(fs.readFileSync(path.join(libraries, 'libcrypto.so'), 'utf8'), 'shared crypto')
})
