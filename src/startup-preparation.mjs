import path from 'node:path'
import { spawn } from 'node:child_process'

export const PTERODACTYL_STARTUP_MARKER = 'change this text 1'

export async function preparePterodactylStart({
  root,
  env = process.env,
  runCommand = run
}) {
  if (env.AUTO_UPDATE === '1') {
    await runCommand('git', ['pull', '--ff-only'], { cwd: root, env })
  }
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited with code ${code ?? 'unknown'}`))
    })
  })
}
