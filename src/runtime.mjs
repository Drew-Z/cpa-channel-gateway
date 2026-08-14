import fs from 'node:fs'
import path from 'node:path'

const CPA_BINARY_NAMES = new Set(['cli-proxy-api', 'CLIProxyAPI'])
const CLOUDFLARED_ASSETS = {
  aarch64: 'cloudflared-linux-arm64',
  amd64: 'cloudflared-linux-amd64'
}

export function findCpaBinary(files) {
  const candidates = files.filter(file => CPA_BINARY_NAMES.has(path.basename(file)))
  if (candidates.length !== 1) throw new Error(`Expected one CPA binary, found ${candidates.length}`)
  return candidates[0]
}

export function cloudflaredAssetName(arch) {
  const asset = CLOUDFLARED_ASSETS[arch]
  if (!asset) throw new Error(`Unsupported cloudflared architecture: ${arch}`)
  return asset
}

export function runtimeNeedsInstall({ expected, installed, binDir, platform, arch, exists = fs.existsSync }) {
  return runtimeInstallPlan({ expected, installed, binDir, platform, arch, exists }).length > 0
}

export function runtimeInstallPlan({ expected, installed, binDir, platform, arch, exists = fs.existsSync }) {
  const components = [
    { id: 'cpa', version: 'cpaVersion', binary: 'CLIProxyAPI' },
    { id: 'haproxy', version: 'haproxyVersion', binary: 'haproxy' },
    { id: 'cloudflared', version: 'cloudflaredVersion', binary: 'cloudflared' }
  ]
  const runtimeChanged = platform !== undefined && arch !== undefined &&
    (installed?.platform !== platform || installed?.arch !== arch)
  return components
    .filter(component => runtimeChanged || installed?.[component.version] !== expected[component.version] || !exists(path.join(binDir, component.binary)))
    .map(component => component.id)
}

export function stageOpenSslHeaders(sslRoot) {
  const packageInclude = path.join(sslRoot, 'usr', 'include')
  const headerFiles = walkFiles(packageInclude)
  const sourceDirs = [...new Set(headerFiles
    .filter(file => path.basename(path.dirname(file)) === 'openssl')
    .map(file => path.dirname(file)))]
    .sort((left, right) => left === path.join(packageInclude, 'openssl') ? -1 : right === path.join(packageInclude, 'openssl') ? 1 : left.localeCompare(right))
  if (!sourceDirs.some(directory => fs.existsSync(path.join(directory, 'ssl.h'))) ||
      !sourceDirs.some(directory => fs.existsSync(path.join(directory, 'opensslconf.h')))) {
    throw new Error('Extracted libssl-dev package is missing OpenSSL headers')
  }
  const stagedInclude = path.join(sslRoot, 'staged-include')
  const stagedOpenSsl = path.join(stagedInclude, 'openssl')
  fs.mkdirSync(stagedOpenSsl, { recursive: true })
  for (const sourceDir of sourceDirs) {
    for (const file of walkFiles(sourceDir)) {
      fs.copyFileSync(file, path.join(stagedOpenSsl, path.basename(file)))
    }
  }
  return stagedInclude
}

export function stageOpenSslLibraries(sslRoot, { arch = process.arch, libraryRoots } = {}) {
  const stagedLib = path.join(sslRoot, 'staged-lib')
  fs.mkdirSync(stagedLib, { recursive: true })
  const multiarch = arch === 'x64' ? 'x86_64-linux-gnu' : arch === 'arm64' ? 'aarch64-linux-gnu' : null
  if (!multiarch) throw new Error(`Unsupported OpenSSL library architecture: ${arch}`)
  const candidates = libraryRoots ?? [`/usr/lib/${multiarch}`, `/lib/${multiarch}`]
  for (const name of ['libssl.so.3', 'libcrypto.so.3']) {
    const source = candidates.map(directory => path.join(directory, name)).find(file => fs.existsSync(file))
    if (!source) throw new Error(`System shared library not found: ${name}`)
    fs.copyFileSync(source, path.join(stagedLib, name.replace(/\.so\.3$/, '.so')))
  }
  return stagedLib
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
