import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const node = process.execPath
const expected = JSON.parse(fs.readFileSync(path.join(root, 'config', 'gateway.json'), 'utf8')).runtime
const versionPath = path.join(root, 'bin', 'versions.json')
let installed = null
try { installed = JSON.parse(fs.readFileSync(versionPath, 'utf8')) } catch {}

if (!fs.existsSync(path.join(root, 'bin', 'CLIProxyAPI')) ||
    !fs.existsSync(path.join(root, 'bin', 'haproxy')) ||
    installed?.cpaVersion !== expected.cpaVersion ||
    installed?.haproxyVersion !== expected.haproxyVersion) {
  await run(node, [path.join(root, 'scripts', 'install-runtime.mjs')])
}

const gateway = spawn(node, [path.join(root, 'scripts', 'gateway.mjs'), 'start'], {
  cwd: root,
  env: { ...process.env, GATEWAY_ROOT: root },
  stdio: 'inherit'
})

let stopping = false
function stop(signal = 'SIGINT') {
  if (stopping) return
  stopping = true
  if (!gateway.killed) gateway.kill(signal)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
gateway.once('exit', code => process.exit(code ?? 1))

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, GATEWAY_ROOT: root }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)))
  })
}
