import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import test from 'node:test'
import { waitForHttpOk, waitForPort } from '../src/supervisor.mjs'

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

test('waitForHttpOk waits until a readiness endpoint returns 2xx', async () => {
  let requests = 0
  const server = http.createServer((request, response) => {
    requests += 1
    response.writeHead(requests < 2 ? 503 : 204)
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const { port } = server.address()
    await waitForHttpOk(`http://127.0.0.1:${port}/ready`, 500, { retryIntervalMs: 10 })
    assert.ok(requests >= 2)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('waitForHttpOk times out cleanly when the readiness endpoint is unavailable', async () => {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  await assert.rejects(
    waitForHttpOk(`http://127.0.0.1:${port}/ready`, 80, { retryIntervalMs: 10, requestTimeoutMs: 20 }),
    /did not return 2xx/
  )
})

test('waitForHttpOk stops promptly when aborted', async () => {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 10)
  try {
    await assert.rejects(
      waitForHttpOk('http://127.0.0.1:1/ready', 5000, { signal: controller.signal, retryIntervalMs: 50 }),
      error => error?.name === 'AbortError'
    )
  } finally {
    clearTimeout(abortTimer)
  }
})
