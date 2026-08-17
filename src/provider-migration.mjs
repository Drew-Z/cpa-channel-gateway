import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { validateAndNormalize, loadConfig } from './config.mjs'
import { parseEnv, serializeEnv } from './env.mjs'
import { providerDocumentFromLegacy, routeDocumentForProviders, stripLegacyChannelEnv } from './providers.mjs'

export class ProviderMigrationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProviderMigrationError'
    this.code = code
  }
}
export function planProviderMigration(root) {
  const configDir = path.join(root, 'config')
  const envPath = path.join(configDir, 'channels.local.env')
  const routesPath = path.join(configDir, 'routes.local.json')
  const providersPath = path.join(configDir, 'providers.local.json')
  if (fs.existsSync(providersPath)) throw new ProviderMigrationError('providers_already_exist', 'providers.local.json already exists')
  if (!fs.existsSync(envPath) || !fs.existsSync(routesPath)) throw new ProviderMigrationError('missing_legacy_config', 'Legacy channel configuration is incomplete')

  const current = loadConfig(root, { allowEmptyEnabledChannels: true })
  const originalEnv = fs.readFileSync(envPath, 'utf8')
  const originalRoutes = fs.readFileSync(routesPath, 'utf8')
  const env = parseEnv(originalEnv)
  const routes = JSON.parse(originalRoutes)
  const providers = providerDocumentFromLegacy({ env, routes })
  const nextEnv = stripLegacyChannelEnv(env)
  const nextRoutes = routeDocumentForProviders(routes)
  const candidate = validateAndNormalize({
    gateway: JSON.parse(fs.readFileSync(path.join(configDir, 'gateway.json'), 'utf8')),
    routes: nextRoutes,
    env: nextEnv,
    providers,
    paths: { routesPath, envPath, providersPath },
    allowEmptyEnabledChannels: true
  })
  if (JSON.stringify(configSemanticView(current)) !== JSON.stringify(configSemanticView(candidate))) {
    throw new ProviderMigrationError('semantic_mismatch', 'Provider migration changed normalized configuration semantics')
  }
  return {
    root,
    envPath,
    routesPath,
    providersPath,
    originalEnv,
    originalRoutes,
    nextEnv: serializeEnv(nextEnv),
    nextRoutes: JSON.stringify(nextRoutes, null, 2) + '\n',
    nextProviders: JSON.stringify(providers, null, 2) + '\n',
    report: {
      mode: 'providers',
      providerCount: providers.providers.length,
      channelIds: providers.providers.map(provider => provider.id),
      routesChanged: originalRoutes !== JSON.stringify(nextRoutes, null, 2) + '\n',
      envChannelEntriesRemoved: Object.keys(env).filter(key => /^CHANNEL_[A-Z][A-Z0-9_]*_(?:NAME|BASE_URL|API_KEY|PROTOCOL|ENABLED)$/.test(key)).length
    }
  }
}

export function applyProviderMigration(plan) {
  const revisionRoot = path.join(plan.root, 'runtime', 'config-revisions')
  const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const backupDir = path.join(revisionRoot, `${stamp}-providers-migration`)
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(backupDir, 'channels.local.env'), plan.originalEnv, { mode: 0o600 })
  fs.writeFileSync(path.join(backupDir, 'routes.local.json'), plan.originalRoutes, { mode: 0o600 })
  try {
    atomicWrite(plan.providersPath, plan.nextProviders)
    atomicWrite(plan.routesPath, plan.nextRoutes)
    atomicWrite(plan.envPath, plan.nextEnv)
    loadConfig(plan.root, { allowEmptyEnabledChannels: true })
  } catch (error) {
    atomicWrite(plan.envPath, plan.originalEnv)
    atomicWrite(plan.routesPath, plan.originalRoutes)
    if (fs.existsSync(plan.providersPath)) fs.rmSync(plan.providersPath, { force: true })
    throw new ProviderMigrationError('migration_failed', 'Provider migration failed validation; original private configuration was restored')
  }
  return {
    ...plan.report,
    applied: true,
    backup: path.relative(plan.root, backupDir).replaceAll('\\', '/')
  }
}

function configSemanticView(config) {
  return {
    gatewayKey: config.gatewayKey,
    managementKey: config.managementKey,
    cloudflareTunnel: config.cloudflareTunnel,
    channels: config.channels.map(channel => ({
      id: channel.id,
      name: channel.name,
      enabled: channel.enabled,
      staged: channel.staged,
      runtimeEnabled: channel.runtimeEnabled,
      upstream: channel.upstream.toString(),
      apiKey: channel.apiKey,
      protocol: channel.protocol,
      priority: channel.priority,
      models: channel.models
    })),
    logicalModels: config.logicalModels,
    stableAliases: config.stableAliases,
    pinnedAliases: config.pinnedAliases
  }
}

function atomicWrite(filePath, content) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`
  fs.writeFileSync(temporary, content, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}
