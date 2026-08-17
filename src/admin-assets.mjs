import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ADMIN_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'dist')
const ADMIN_CSP = "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

export function sendAdminIndex(response) {
  let body
  try {
    body = fs.readFileSync(path.join(ADMIN_DIST_DIR, 'index.html'))
  } catch {
    sendError(response, 503, 'admin_assets_unavailable', 'Admin assets are unavailable; run npm run build:admin')
    return
  }
  send(response, 200, body, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': ADMIN_CSP
  })
}

export function sendAdminAsset(response, pathname) {
  const assetName = pathname.slice('/admin/assets/'.length)
  if (!/^[A-Za-z0-9._-]+$/.test(assetName)) {
    sendError(response, 404, 'not_found', 'Admin asset not found')
    return
  }
  let body
  try {
    body = fs.readFileSync(path.join(ADMIN_DIST_DIR, 'assets', assetName))
  } catch {
    sendError(response, 404, 'not_found', 'Admin asset not found')
    return
  }
  send(response, 200, body, {
    'content-type': assetName.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : assetName.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-security-policy': "default-src 'none'"
  })
}

function sendError(response, statusCode, code, message) {
  const body = Buffer.from(JSON.stringify({ error: { code, message } }))
  send(response, statusCode, body, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
}

function send(response, statusCode, body, headers) {
  if (response.headersSent || response.destroyed) return
  response.writeHead(statusCode, {
    ...headers,
    'content-length': String(body.length),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  })
  response.end(body)
}
