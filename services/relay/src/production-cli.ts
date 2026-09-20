import process from 'node:process'

import type { RelayLogger } from './logging.ts'
import {
  loadProductionGatewayConfig,
  ProductionGatewayConfigError,
  type ProductionGatewayEnvironment,
} from './production-config.ts'
import {
  createProductionGateway,
  ProductionGatewayStartError,
} from './production-gateway.ts'

function namedEnvironment(): ProductionGatewayEnvironment {
  return {
    CODEX_PLUS_MODE: process.env.CODEX_PLUS_MODE,
    CODEX_PLUS_BIND: process.env.CODEX_PLUS_BIND,
    CODEX_PLUS_PORT: process.env.CODEX_PLUS_PORT,
    CODEX_PLUS_PUBLIC_ORIGIN: process.env.CODEX_PLUS_PUBLIC_ORIGIN,
    CODEX_PLUS_TRUSTED_PROXY_IPS: process.env.CODEX_PLUS_TRUSTED_PROXY_IPS,
    CODEX_PLUS_STATE_FILE: process.env.CODEX_PLUS_STATE_FILE,
    CODEX_PLUS_WEB_ROOT: process.env.CODEX_PLUS_WEB_ROOT,
    CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: process.env.CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE,
    CODEX_PLUS_OWNER_VERIFIER_FILE: process.env.CODEX_PLUS_OWNER_VERIFIER_FILE,
    CODEX_PLUS_LOG_LEVEL: process.env.CODEX_PLUS_LOG_LEVEL,
  }
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function loggerFor(level: 'info' | 'warn' | 'error'): RelayLogger | undefined {
  if (level !== 'info') return undefined
  return entry => {
    process.stdout.write(jsonLine(entry))
  }
}

async function run(): Promise<void> {
  const config = await loadProductionGatewayConfig(namedEnvironment())
  const gateway = await createProductionGateway(config, {
    logger: loggerFor(config.logLevel),
  })
  await gateway.listen()

  await new Promise<void>(resolve => {
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await gateway.close()
}

void run().catch(error => {
  const reason = error instanceof ProductionGatewayConfigError
    ? 'configuration'
    : error instanceof ProductionGatewayStartError
      ? 'startup'
      : 'internal'
  process.stderr.write(jsonLine({ event: 'gateway.start_failed', reason }))
  process.exitCode = 1
})
