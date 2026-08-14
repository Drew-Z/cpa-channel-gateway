#!/usr/bin/env node
import { request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { buildCanaryRequest, extractCanaryContent, resolveCanaryUrl } from '../src/canary.mjs'

const port = Number(process.env.SERVER_PORT || process.env.PORT || 3000)
const apiKey = process.env.GATEWAY_API_KEY
if (!apiKey) throw new Error('GATEWAY_API_KEY is required')
const model = process.env.CANARY_MODEL || 'coding-main'
const protocol = process.env.CANARY_PROTOCOL || 'responses'
const prompt = process.env.CANARY_PROMPT || '请写一首四句七言绝句，主题是秋夜读书。只输出诗题和诗句。'
const requestShape = buildCanaryRequest(protocol, model, prompt)
const result = await post(resolveCanaryUrl(process.env.GATEWAY_BASE_URL, port, requestShape.path), JSON.stringify(requestShape.body), {
  Authorization: `Bearer ${apiKey}`,
  ...(protocol === 'claude' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : {})
})
if (result.status < 200 || result.status >= 300) throw new Error(`Canary failed with HTTP ${result.status}: ${sanitize(result.body)}`)
let parsed
try { parsed = JSON.parse(result.body) } catch { throw new Error('Canary returned invalid JSON') }
const content = extractCanaryContent(protocol, parsed)
if (typeof content !== 'string' || content.trim().length < 8) throw new Error('Canary returned empty content')
console.log(JSON.stringify({ ok: true, protocol, model, status: result.status, contentLength: content.trim().length }, null, 2))

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? httpsRequest : request
    const req = transport(target, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(180_000, () => req.destroy(new Error('Canary request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

function sanitize(value) {
  return String(value)
    .replaceAll(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replaceAll(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .slice(0, 500)
}
