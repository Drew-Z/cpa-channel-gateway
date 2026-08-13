import fs from 'node:fs'

export function parseEnv(text) {
  const values = {}
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new Error(`Invalid env line: ${rawLine}`)
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

export function readEnvFile(filePath) {
  return parseEnv(fs.readFileSync(filePath, 'utf8'))
}

export function serializeEnv(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${quoteEnv(String(value))}`)
    .join('\n') + '\n'
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_./:@+-]*$/.test(value)) return value
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
