#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findCpaBinary, stageOpenSslHeaders, stageOpenSslLibraries } from '../src/runtime.mjs'

const root = path.resolve(process.env.GATEWAY_ROOT || path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const gatewayConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gateway.json'), 'utf8'))
const cpaVersion = String(gatewayConfig.runtime?.cpaVersion || '').trim()
const haproxyVersion = String(gatewayConfig.runtime?.haproxyVersion || '').trim()
if (!/^\d+\.\d+\.\d+$/.test(cpaVersion)) throw new Error(`Invalid CPA version: ${cpaVersion}`)
if (!/^\d+\.\d+\.\d+$/.test(haproxyVersion)) throw new Error(`Invalid HAProxy version: ${haproxyVersion}`)
const platform = process.platform
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'amd64' : null
if (platform !== 'linux' || !arch) throw new Error(`Unsupported runtime: ${platform}/${process.arch}`)

const binDir = path.join(root, 'bin')
fs.mkdirSync(binDir, { recursive: true })
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpa-gateway-'))
try {
  await installCpa(tmpDir, binDir, arch)
  await installHaproxy(tmpDir, binDir)
  const manifest = { schemaVersion: 1, cpaVersion, haproxyVersion, platform, arch, installedAt: new Date().toISOString() }
  fs.writeFileSync(path.join(binDir, 'versions.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ ...manifest, binDir }, null, 2))
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

async function installCpa(tmp, destination, targetArch) {
  const asset = `CLIProxyAPI_${cpaVersion}_linux_${targetArch}_no-plugin.tar.gz`
  const base = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${cpaVersion}`
  const expected = gatewayConfig.runtime?.cpaSha256?.[targetArch]
  if (!expected) throw new Error(`No checksum for CPA asset ${asset}`)
  const archive = path.join(tmp, asset)
  await download(`${base}/${asset}`, archive)
  assertSha256(archive, expected)
  const extractDir = path.join(tmp, 'cpa')
  fs.mkdirSync(extractDir)
  execFileSync('tar', ['-xzf', archive, '-C', extractDir], { stdio: 'inherit' })
  const binary = findCpaBinary(walkFiles(extractDir))
  fs.copyFileSync(binary, path.join(destination, 'CLIProxyAPI'))
  fs.chmodSync(path.join(destination, 'CLIProxyAPI'), 0o755)
}

async function installHaproxy(tmp, destination) {
  const archiveName = `haproxy-${haproxyVersion}.tar.gz`
  const base = `https://www.haproxy.org/download/3.2/src`
  const expected = gatewayConfig.runtime?.haproxySha256
  const archive = path.join(tmp, archiveName)
  await download(`${base}/${archiveName}`, archive)
  assertSha256(archive, expected)
  execFileSync('tar', ['-xzf', archive, '-C', tmp], { stdio: 'inherit' })
  const sourceDir = path.join(tmp, `haproxy-${haproxyVersion}`)
  const sslRoot = path.join(tmp, 'ssl-dev')
  const aptState = path.join(tmp, 'apt-state')
  const aptCache = path.join(tmp, 'apt-cache')
  const aptConfig = path.join(tmp, 'apt.conf')
  const aptParts = path.join(tmp, 'apt-parts')
  const sourceParts = path.join(tmp, 'source-parts')
  fs.mkdirSync(path.join(aptState, 'lists', 'partial'), { recursive: true })
  fs.mkdirSync(path.join(aptCache, 'archives', 'partial'), { recursive: true })
  fs.mkdirSync(aptParts)
  fs.mkdirSync(sourceParts)
  const sourceList = ['/etc/apt/sources.list', '/etc/apt/sources.list.d/debian.sources'].find(file => fs.existsSync(file))
  if (!sourceList) throw new Error('No Debian APT source list found')
  const temporarySourceList = path.join(tmp, path.extname(sourceList) === '.sources' ? 'debian.sources' : 'sources.list')
  const sourceText = fs.readFileSync(sourceList, 'utf8')
    .replace(/^(\s*URIs:\s+)http:\/\//gm, '$1https://')
    .replace(/^(\s*deb(?:-src)?\s+(?:\[[^\]]+\]\s+)?)http:\/\//gm, '$1https://')
  fs.writeFileSync(temporarySourceList, sourceText)
  fs.writeFileSync(aptConfig, [
    `Dir::Etc::sourcelist "${temporarySourceList}";`,
    `Dir::Etc::sourceparts "${sourceParts}";`,
    'Dir::Etc::main "";',
    `Dir::Etc::parts "${aptParts}";`,
    'Dir::State::status "/var/lib/dpkg/status";',
    'Acquire::Languages "none";',
    'Acquire::GzipIndexes "true";'
  ].join('\n') + '\n')
  fs.mkdirSync(sslRoot)
  const aptOptions = [
    '-o', `Dir::State::lists=${path.join(aptState, 'lists')}`,
    '-o', `Dir::Cache::archives=${path.join(aptCache, 'archives')}`,
    '-o', 'Acquire::Retries=3',
    '-o', 'Acquire::http::Pipeline-Depth=0'
  ]
  const aptEnv = { ...process.env, APT_CONFIG: aptConfig }
  await runApt(aptOptions, ['update'], { env: aptEnv })
  await runApt(aptOptions, ['download', 'libssl-dev'], { cwd: sslRoot, env: aptEnv })
  const sslDebs = fs.readdirSync(sslRoot).filter(name => /^libssl-dev_.*\.deb$/.test(name))
  if (sslDebs.length !== 1) throw new Error(`Expected one libssl-dev package, found ${sslDebs.length}`)
  execFileSync('dpkg-deb', ['-x', path.join(sslRoot, sslDebs[0]), sslRoot], { stdio: 'inherit' })
  const sslInclude = stageOpenSslHeaders(sslRoot)
  const sslLibrary = stageOpenSslLibraries(sslRoot)
  if (!fs.existsSync(path.join(sslInclude, 'openssl', 'ssl.h'))) throw new Error('Extracted libssl-dev package is incomplete')
  execFileSync('make', [
    '-C', sourceDir,
    'TARGET=linux-glibc',
    'USE_OPENSSL=1',
    `SSL_INC=${sslInclude}`,
    `SSL_LIB=${sslLibrary}`,
    '-j2'
  ], { stdio: 'inherit' })
  const binary = path.join(sourceDir, 'haproxy')
  if (!fs.existsSync(binary)) throw new Error('HAProxy build did not produce haproxy binary')
  fs.copyFileSync(binary, path.join(destination, 'haproxy'))
  fs.chmodSync(path.join(destination, 'haproxy'), 0o755)
}

async function runApt(options, args, extra = {}) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      execFileSync('apt-get', [...options, ...args], { stdio: 'inherit', ...extra })
      return
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3000 * attempt))
    }
  }
  throw lastError
}

async function fetchText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`)
  return response.text()
}

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${url}`)
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

function assertSha256(filePath, expected) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${path.basename(filePath)}`)
}

function walkFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(fullPath))
    else files.push(fullPath)
  }
  return files
}
