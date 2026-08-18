import assert from 'node:assert/strict'
import test from 'node:test'
import { PTERODACTYL_STARTUP_MARKER, preparePterodactylStart } from '../src/startup-preparation.mjs'

test('strictly updates and installs before starting when auto update is enabled', async () => {
  const calls = []

  await preparePterodactylStart({
    root: '/fixture',
    env: { AUTO_UPDATE: '1' },
    runCommand: async (command, args, options) => calls.push({ command, args, options })
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].args, ['pull', '--ff-only'])
  assert.deepEqual(calls[1].args, ['install', '--no-audit', '--no-fund'])
  assert.equal(calls[0].options.cwd, '/fixture')
})

test('does not install dependencies after an update failure', async () => {
  const calls = []

  await assert.rejects(
    preparePterodactylStart({
      root: '/fixture',
      env: { AUTO_UPDATE: '1' },
      runCommand: async (command, args) => {
        calls.push({ command, args })
        throw new Error('fixture update failure')
      }
    }),
    /fixture update failure/
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['pull', '--ff-only'])
})

test('skips the update but still verifies dependency installation when auto update is disabled', async () => {
  const calls = []

  await preparePterodactylStart({
    root: '/fixture',
    env: { AUTO_UPDATE: '0' },
    runCommand: async (command, args) => calls.push({ command, args })
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['install', '--no-audit', '--no-fund'])
  assert.equal(PTERODACTYL_STARTUP_MARKER, 'change this text 1')
})
