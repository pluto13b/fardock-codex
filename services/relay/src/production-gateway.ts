import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { RelayLogger } from './logging.ts'
import {
  assertProductionGatewayPathSeparation,
  type ProductionGatewayConfig,
} from './production-config.ts'
import {
  createR3ProductionRelayServer,
  type R3ProductionRelayServer,
  type R3RelayAddress,
} from './r3-server.ts'
import { openR3RelayStateStore } from './r3-state.ts'
import {
  createOwnerAuthenticatedWeb,
  type OwnerAuthenticatedWeb,
} from './owner-auth-web.ts'
import {
  createProductionWebHandler,
  type ProductionWebHandler,
} from './production-web.ts'

export type ProductionGatewayStartErrorCode =
  | 'invalid-config'
  | 'bootstrap-required'
  | 'state-unavailable'
  | 'web-unavailable'

export class ProductionGatewayStartError extends Error {
  constructor(readonly code: ProductionGatewayStartErrorCode) {
    super(code)
    this.name = 'ProductionGatewayStartError'
  }
}

export interface ProductionGatewayRuntimeOptions {
  now?: () => number
  logger?: RelayLogger
}

export interface ProductionGateway {
  listen(): Promise<R3RelayAddress>
  getAddress(): R3RelayAddress | undefined
  close(): Promise<void>
}

class ProductionGatewayImplementation implements ProductionGateway {
  constructor(
    private readonly relay: R3ProductionRelayServer,
    private readonly bind: ProductionGatewayConfig['bind'],
    private readonly port: number,
    private readonly ownerWeb: OwnerAuthenticatedWeb,
  ) {}

  listen(): Promise<R3RelayAddress> {
    return this.relay.listen({ host: this.bind, port: this.port })
  }

  getAddress(): R3RelayAddress | undefined {
    return this.relay.getAddress()
  }

  close(): Promise<void> {
    this.ownerWeb.close()
    return this.relay.close()
  }
}

function normalized(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function within(root: string, candidate: string): boolean {
  const path = relative(normalized(root), normalized(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

export async function createProductionGateway(
  config: ProductionGatewayConfig,
  runtime: ProductionGatewayRuntimeOptions = {},
): Promise<ProductionGateway> {
  if (
    config.mode !== 'production'
    || (config.bind !== '127.0.0.1' && config.bind !== '0.0.0.0')
    || !Number.isSafeInteger(config.port)
    || config.port < 0
    || config.port > 65_535
    || !Array.isArray(config.trustedProxyIps)
    || config.trustedProxyIps.length < 1
    || within(config.webRoot, config.stateFile)
    || within(config.webRoot, config.ownerVerifierFile)
    || normalized(config.stateFile) === normalized(config.ownerVerifierFile)
    || ((config.bootstrapCredential === undefined) !== (config.bootstrapCredentialFile === undefined))
    || (
      config.bootstrapCredentialFile !== undefined
      && within(config.webRoot, config.bootstrapCredentialFile)
    )
  ) throw new ProductionGatewayStartError('invalid-config')

  try {
    await assertProductionGatewayPathSeparation({
      webRoot: config.webRoot,
      stateFile: config.stateFile,
      ...(config.bootstrapCredentialFile === undefined
        ? {}
        : { bootstrapCredentialFile: config.bootstrapCredentialFile }),
      ownerVerifierFile: config.ownerVerifierFile,
    })
  } catch {
    throw new ProductionGatewayStartError('invalid-config')
  }

  let store: Awaited<ReturnType<typeof openR3RelayStateStore>> | undefined
  let registrationClosed = false
  try {
    store = await openR3RelayStateStore(config.stateFile)
    registrationClosed = store.registrationClosed
    if (!store.registrationClosed && config.bootstrapCredential === undefined) {
      throw new ProductionGatewayStartError('bootstrap-required')
    }
  } catch (error) {
    if (error instanceof ProductionGatewayStartError) throw error
    throw new ProductionGatewayStartError('state-unavailable')
  } finally {
    await store?.close().catch(() => undefined)
  }

  let requestHandler: ProductionWebHandler
  let ownerWeb: OwnerAuthenticatedWeb
  try {
    const staticHandler = await createProductionWebHandler({
      webRoot: config.webRoot,
      publicOrigin: config.publicOrigin,
    })
    ownerWeb = createOwnerAuthenticatedWeb({
      verifier: config.ownerVerifier,
      publicOrigin: config.publicOrigin,
      staticHandler,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
    })
    requestHandler = ownerWeb.handler
  } catch {
    throw new ProductionGatewayStartError('web-unavailable')
  }

  let relay: R3ProductionRelayServer
  try {
    relay = createR3ProductionRelayServer({
      mode: 'production',
      stateFile: config.stateFile,
      relayOrigin: config.publicOrigin,
      trustedProxyIps: config.trustedProxyIps,
      ...(config.bootstrapCredential === undefined
        ? {}
        : { bootstrapCredential: config.bootstrapCredential }),
      requireRegistrationClosed: registrationClosed,
      requestHandler,
      ownerSessionAuthenticated: ownerWeb.isAuthenticated,
      pairingCodes: ownerWeb.pairingCodes,
      ...(runtime.now === undefined ? {} : { now: runtime.now }),
      ...(runtime.logger === undefined ? {} : { logger: runtime.logger }),
    })
  } catch {
    ownerWeb.close()
    throw new ProductionGatewayStartError('invalid-config')
  }
  return new ProductionGatewayImplementation(relay, config.bind, config.port, ownerWeb)
}
