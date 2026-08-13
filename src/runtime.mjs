import path from 'node:path'

const CPA_BINARY_NAMES = new Set(['cli-proxy-api', 'CLIProxyAPI'])

export function findCpaBinary(files) {
  const candidates = files.filter(file => CPA_BINARY_NAMES.has(path.basename(file)))
  if (candidates.length !== 1) throw new Error(`Expected one CPA binary, found ${candidates.length}`)
  return candidates[0]
}
