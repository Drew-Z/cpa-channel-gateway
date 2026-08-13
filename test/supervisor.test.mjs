import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { waitForPort } from '../src/supervisor.mjs'

test('waitForPort resolves for a listening socket', async () => {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const { port } = server.address()
    await waitForPort('127.0.0.1', port, 500)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('waitForPort times out cleanly when no process owns the port', async () => {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(
    waitForPort('127.0.0.1', port, 80, { retryIntervalMs: 10, connectTimeoutMs: 20 }),
    /did not become ready/
  )
})
