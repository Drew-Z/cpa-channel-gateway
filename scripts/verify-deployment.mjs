#!/usr/bin/env node
import { runDeploymentCheck } from '../src/deployment-check.mjs'

try {
  const port = Number(process.env.SERVER_PORT || process.env.PORT || 3000)
  const result = await runDeploymentCheck({
    origin: process.env.GATEWAY_BASE_URL || `http://127.0.0.1:${port}`,
    managementKey: process.env.CPA_MANAGEMENT_KEY,
    gatewayKey: process.env.GATEWAY_API_KEY,
    canaryModel: process.env.DEPLOYMENT_CANARY_MODEL || null,
    businessModel: process.env.DEPLOYMENT_BUSINESS_MODEL || null,
    apply: process.env.DEPLOYMENT_APPLY === '1'
  })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'deployment_check_failed',
      statusCode: Number.isSafeInteger(error?.statusCode) ? error.statusCode : null
    }
  }))
  process.exitCode = 1
}
