#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const findings = []
const forbiddenPath = /(^|\/)(?:config\/[^/]*\.local\.[^/]+|runtime|bin|auth|logs)(?:\/|$)|(^|\/)\.env(?:\.|$)|\.(?:key|pem)$/i
const secretPatterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['openai-style-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['credentialed-url', /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s/]+/]
]
const assignmentPattern = /(?:^|[\r\n])\s*(?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|["'](?:apiKey|token|secret|password)["'])\s*[:=]\s*["']?([^\s,"'#}]{8,})/gi
const placeholderPattern = /replace|example|dummy|fixture|legacy-|(?:gateway|management|old|new|free\d*)-key$|test|process\.env|env\[|(?:values|provider|input)\.|invalid|secret-(?:chat|responses|claude)|<[^>]+>/i

const trackedPaths = gitText(['ls-files', '-z']).split('\0').filter(Boolean)
for (const trackedPath of trackedPaths) {
  inspectPath('worktree', trackedPath)
  const fullPath = path.join(root, trackedPath)
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) inspectContent('worktree', trackedPath, fs.readFileSync(fullPath))
}

const objectLines = gitText(['rev-list', '--objects', '--all']).trim().split(/\r?\n/).filter(Boolean)
const pathsByHash = new Map()
for (const line of objectLines) {
  const separator = line.indexOf(' ')
  const hash = separator < 0 ? line : line.slice(0, separator)
  const historicalPath = separator < 0 ? '' : line.slice(separator + 1)
  if (!pathsByHash.has(hash)) pathsByHash.set(hash, new Set())
  if (historicalPath) pathsByHash.get(hash).add(historicalPath)
}

const historicalBlobs = []
for (const [hash, historicalPaths] of pathsByHash) {
  if (gitText(['cat-file', '-t', hash]).trim() !== 'blob') continue
  const data = gitBuffer(['cat-file', 'blob', hash])
  const displayPaths = historicalPaths.size ? [...historicalPaths] : [`blob:${hash}`]
  historicalBlobs.push({ data, paths: displayPaths })
  for (const historicalPath of displayPaths) {
    inspectPath('history', historicalPath)
    inspectContent('history', historicalPath, data)
  }
}

const localSecrets = readLocalSecrets()
for (const { field, value } of localSecrets) {
  const needle = Buffer.from(value)
  for (const trackedPath of trackedPaths) {
    const fullPath = path.join(root, trackedPath)
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile() && fs.readFileSync(fullPath).includes(needle)) {
      addFinding('local-value-match', 'worktree', trackedPath, field)
    }
  }
  for (const blob of historicalBlobs) {
    if (!blob.data.includes(needle)) continue
    for (const historicalPath of blob.paths) addFinding('local-value-match', 'history', historicalPath, field)
  }
}

const uniqueFindings = [...new Map(findings.map(item => [JSON.stringify(item), item])).values()]
if (uniqueFindings.length) {
  console.error(JSON.stringify({ ok: false, findings: uniqueFindings }, null, 2))
  process.exit(1)
}

console.log(JSON.stringify({
  ok: true,
  trackedFiles: trackedPaths.length,
  reachableCommits: Number(gitText(['rev-list', '--count', '--all']).trim() || 0),
  reachableBlobs: historicalBlobs.length,
  localSensitiveFieldsChecked: localSecrets.length
}, null, 2))

function inspectPath(scope, candidate) {
  const normalized = candidate.replaceAll('\\', '/')
  if (forbiddenPath.test(normalized)) addFinding('forbidden-path', scope, normalized)
}

function inspectContent(scope, candidate, data) {
  const text = data.toString('utf8')
  for (const [rule, pattern] of secretPatterns) {
    if (pattern.test(text)) addFinding(rule, scope, candidate)
  }
  assignmentPattern.lastIndex = 0
  let match
  while ((match = assignmentPattern.exec(text))) {
    if (!placeholderPattern.test(match[1])) {
      addFinding('suspicious-secret-assignment', scope, candidate)
      break
    }
  }
}

function readLocalSecrets() {
  const envPath = path.join(root, 'config', 'channels.local.env')
  const values = []
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim())
      if (!match || !/(?:API_KEY|BASE_URL|MANAGEMENT_KEY|TOKEN|SECRET|PASSWORD)$/.test(match[1])) continue
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      if (value.length < 8 || placeholderPattern.test(value)) continue
      values.push({ field: match[1], value })
    }
  }
  const providersPath = path.join(root, 'config', 'providers.local.json')
  if (fs.existsSync(providersPath)) {
    try {
      const document = JSON.parse(fs.readFileSync(providersPath, 'utf8'))
      for (const [index, provider] of (document.providers ?? []).entries()) {
        for (const field of ['baseUrl', 'apiKey']) {
          const value = typeof provider?.[field] === 'string' ? provider[field].trim() : ''
          if (value.length >= 8 && !placeholderPattern.test(value)) values.push({ field: `providers[${index}].${field}`, value })
        }
      }
    } catch {
      // The normal public-content scan reports malformed tracked JSON separately.
    }
  }
  return values
}

function addFinding(rule, scope, candidate, field) {
  findings.push({ rule, scope, path: candidate, ...(field ? { field } : {}) })
}

function gitText(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function gitBuffer(args) {
  return execFileSync('git', args, { cwd: root, encoding: null, maxBuffer: 32 * 1024 * 1024 })
}
