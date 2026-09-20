import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, resolve, win32 as windowsPath } from 'node:path'
import { createInterface, type Interface } from 'node:readline/promises'
import { createLiveTextProjection } from './live-text-projection.ts'

import {
  exportPublicJwk,
  fingerprintP256PublicKey,
  getEstablishedSessionChannelInfo,
  invalidateEstablishedSession,
  type SessionAuthority,
} from '../../../packages/e2ee/src/index.ts'
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/index.ts'

import {
  createPersistentMultiClientHostRuntime,
  type PersistentMultiClientHostRuntime,
} from './persistent-multi-client-runtime.ts'
import {
  writeProductionPairingQr,
  type ProductionPairingQr,
} from './production-pairing-qr.ts'
import {
  parseProductionRunnerOptions,
  type ProductionRunnerOptions,
} from './production-runner-options.ts'
import { AppServerReadProjection } from './read-projection.ts'
import { createWindowsCompanionReadySessionHandler } from './ready-session.ts'
import {
  R3ProductionRelayHostClient,
  type R3RelayHostAuthentication,
  type R3RelayHostClient,
} from './relay-host-client.ts'
import { establishRuntimeCompatibility } from './runtime-binding.ts'
import {
  APP_SERVER_METHODS,
  AppServerSupervisor,
  type SupervisorLogEvent,
} from './supervisor.ts'
import {
  WindowsAnchoredActionState,
} from './windows-action-state-store.ts'
import {
  WindowsIdentityStore,
  type ActionRequestFingerprinter,
  type WindowsHostIdentity,
} from './windows-identity-store.ts'
import type { AcceptedTextTurnProof } from './action-controller.ts'
import { createProductionDiagnosticLog, type ProductionDiagnosticLog } from './production-diagnostics.ts'
import {
  createLiveRequestAuthority,
  type LiveRequestAuthority,
} from './live-request-authority.ts'

const EXPECTED_SETTINGS = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'xhigh' as const,
  permission: 'full-access' as const,
})
const RECONNECT_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 5_000])
const WORKSPACE_ID = 'workspace.production'

type PathKind = 'missing' | 'file' | 'other'

export class ProductionRunnerError extends Error {
  constructor(readonly code: string) {
    super(`production-runner:${code}`)
    this.name = 'ProductionRunnerError'
  }
}

function fail(code: string): never {
  throw new ProductionRunnerError(code)
}

interface ConnectableHostAttempt<TRuntime = unknown> {
  readonly client: R3RelayHostClient
  readonly runtime: TRuntime
}

interface ActionAuthorityFactory<T> {
  readonly inspect: (path: string) => Promise<PathKind>
  readonly create: () => Promise<T>
  readonly open: () => Promise<T>
}

/** Package-private storage seam used to prove that partial authority state never recreates. */
export async function openProductionActionAuthority<T>(input: Readonly<{
  databasePath: string
  anchorPath: string
  factory: ActionAuthorityFactory<T>
}>): Promise<T> {
  const [database, anchor] = await Promise.all([
    input.factory.inspect(input.databasePath),
    input.factory.inspect(input.anchorPath),
  ])
  if (database === 'missing' && anchor === 'missing') return input.factory.create()
  if (database === 'file' && anchor === 'file') return input.factory.open()
  return fail('action-authority-incomplete')
}

/** A boundary is anchored both before accepting work and after any possible mutation. */
export async function runAnchoredRequestBoundary<T>(
  authority: Pick<WindowsAnchoredActionState, 'syncAfterRequestBoundary'>,
  operation: () => Promise<T>,
): Promise<T> {
  await authority.syncAfterRequestBoundary()
  try {
    return await operation()
  } finally {
    await authority.syncAfterRequestBoundary()
  }
}

/**
 * Bootstrap success is acknowledged only by connect(), which resolves after the
 * Relay welcome. If that outcome was ambiguous, exactly one challenge attempt
 * with the same signing identity is allowed.
 */
export async function connectProductionHostWithBootstrapFallback<T extends ConnectableHostAttempt>(
  input: Readonly<{
    bootstrapAuthentication?: Extract<R3RelayHostAuthentication, { kind: 'bootstrap' }>
    createAttempt: (authentication: R3RelayHostAuthentication) => Promise<T>
    markBootstrapRegistered: () => Promise<void>
  }>,
): Promise<T> {
  if (input.bootstrapAuthentication === undefined) {
    const attempt = await input.createAttempt({ kind: 'resume' })
    try {
      await attempt.client.connect()
      return attempt
    } catch {
      await attempt.client.close().catch(() => undefined)
      return fail('relay-connect-failed')
    }
  }

  const bootstrap = await input.createAttempt(input.bootstrapAuthentication)
  try {
    await bootstrap.client.connect()
  } catch {
    await bootstrap.client.close().catch(() => undefined)
    const resumed = await input.createAttempt({ kind: 'resume' })
    try {
      await resumed.client.connect()
    } catch {
      await resumed.client.close().catch(() => undefined)
      return fail('bootstrap-ambiguous')
    }
    try {
      await input.markBootstrapRegistered()
      return resumed
    } catch (error) {
      await resumed.client.close().catch(() => undefined)
      throw error
    }
  }
  try {
    await input.markBootstrapRegistered()
    return bootstrap
  } catch (error) {
    await bootstrap.client.close().catch(() => undefined)
    throw error
  }
}

export function createProductionTurnOwnership(): Readonly<{
  onAcceptedTextTurn: (proof: AcceptedTextTurnProof) => void
  ownsTask: (taskId: string) => boolean
  ownsTurn: (taskId: string, turnId: string) => boolean
  clear: () => void
}> {
  const turns = new Map<string, string>()
  return Object.freeze({
    onAcceptedTextTurn: proof => { turns.set(proof.taskId, proof.turnId) },
    ownsTask: taskId => turns.has(taskId),
    ownsTurn: (taskId, turnId) => turns.get(taskId) === turnId,
    clear: () => { turns.clear() },
  })
}

export function createProductionSupervisorFailureBoundary(input: Readonly<{
  write: (line: string) => void
  requestStop: () => void
  record?: (code: string) => void
}>): Readonly<{
  logger: (event: SupervisorLogEvent) => void
  failed: () => boolean
}> {
  let failed = false
  return Object.freeze({
    logger: event => {
      if (
        failed
        || event.event !== 'lifecycle'
        || event.state !== 'failed'
      ) return
      failed = true
      input.write(`${JSON.stringify({
        event: 'production.app_server_failed',
        code: event.code ?? 'unknown',
        detail: event.detail ?? 'unknown',
        method: event.pendingMethod ?? 'none',
      })}\n`)
      try { input.record?.(event.code ?? 'unknown') } catch {}
      input.requestStop()
    },
    failed: () => failed,
  })
}

export function bindProductionTerminalInterrupt(
  terminal: Pick<Interface, 'on' | 'off'>,
  requestStop: () => void,
): () => void {
  let active = true
  const handler = (): void => {
    if (active) requestStop()
  }
  terminal.on('SIGINT', handler)
  return () => {
    if (!active) return
    active = false
    terminal.off('SIGINT', handler)
  }
}

export async function requestExactProductionPairingDecision(
  confirmation: Readonly<{
    deviceDisplayName: string
    sas: string
    clientSigningFingerprint: string
    expiresAt: number
  }>,
  io: Readonly<{
    write: (line: string) => void
    question: (prompt: string) => Promise<string>
  }>,
): Promise<Readonly<{ decision: 'approve' | 'deny' }>> {
  io.write(`${JSON.stringify({
    event: 'production.pairing_confirmation_required',
    deviceDisplayName: confirmation.deviceDisplayName,
    clientSigningFingerprint: confirmation.clientSigningFingerprint,
    sas: confirmation.sas,
    expiresAt: confirmation.expiresAt,
  })}\n`)
  const answer = await io.question(`Type exact APPROVE ${confirmation.sas}: `)
  return Object.freeze({
    decision: answer === `APPROVE ${confirmation.sas}` ? 'approve' : 'deny',
  })
}

export function createCurrentAuthorizationAssertion(
  store: Pick<WindowsIdentityStore, 'loadAuthorization'>,
  relayOrigin: string,
): ((authority: Readonly<SessionAuthority>) => Promise<void>) & Readonly<{
  invalidate: (authorizationId: string) => void
}> {
  const cached = new Map<string, Readonly<{
    relayOrigin: string
    hostId: string
    hostDeviceId: string
    clientDeviceId: string
    authorizationId: string
    authorizationEpoch: number
  }>>()
  const assertCurrent = async (authority: Readonly<SessionAuthority>): Promise<void> => {
    const current = cached.get(authority.authorizationId)
    if (current !== undefined) {
      if (
        current.relayOrigin !== relayOrigin
        || current.hostId !== authority.hostId
        || current.hostDeviceId !== authority.hostDeviceId
        || current.clientDeviceId !== authority.clientDeviceId
        || current.authorizationEpoch !== authority.authorizationEpoch
      ) fail('stale-authorization')
      return
    }
    const loaded = await store.loadAuthorization(authority.authorizationId)
    const claims = loaded.material.grantClaims
    if (
      claims.relayOrigin !== relayOrigin
      || claims.hostId !== authority.hostId
      || claims.hostDeviceId !== authority.hostDeviceId
      || claims.clientDeviceId !== authority.clientDeviceId
      || claims.authorizationId !== authority.authorizationId
      || claims.authorizationEpoch !== authority.authorizationEpoch
    ) fail('stale-authorization')
    cached.set(authority.authorizationId, Object.freeze({
      relayOrigin: claims.relayOrigin,
      hostId: claims.hostId,
      hostDeviceId: claims.hostDeviceId,
      clientDeviceId: claims.clientDeviceId,
      authorizationId: claims.authorizationId,
      authorizationEpoch: claims.authorizationEpoch,
    }))
  }
  return Object.assign(assertCurrent, {
    invalidate: (authorizationId: string) => { cached.delete(authorizationId) },
  })
}

export async function syncCurrentActiveAuthorizations(
  store: Pick<WindowsIdentityStore, 'activeAuthorizationIds' | 'loadAuthorization'>,
  client: Pick<R3RelayHostClient, 'putAuthorization'>,
): Promise<number> {
  const loaded = await Promise.all((await store.activeAuthorizationIds()).map(id => store.loadAuthorization(id)))
  loaded.sort((left, right) => left.hostAuthorizationRevision - right.hostAuthorizationRevision)
  for (const authorization of loaded) {
    const claims = authorization.material.grantClaims
    const [clientSigningKey, clientSigningFingerprint] = await Promise.all([
      exportPublicJwk(authorization.material.clientSigningPublicKey),
      fingerprintP256PublicKey(authorization.material.clientSigningPublicKey),
    ])
    if (clientSigningFingerprint !== claims.clientSigningFingerprint) fail('stale-authorization')
    const applied = await client.putAuthorization({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'authorization.put',
      hostId: claims.hostId,
      hostDeviceId: claims.hostDeviceId,
      clientDeviceId: claims.clientDeviceId,
      authorizationId: claims.authorizationId,
      authorizationEpoch: claims.authorizationEpoch,
      hostAuthorizationRevision: authorization.hostAuthorizationRevision,
      status: 'active',
      clientSigningKey,
      clientSigningFingerprint,
    })
    if (
      applied.hostId !== claims.hostId
      || applied.hostDeviceId !== claims.hostDeviceId
      || applied.clientDeviceId !== claims.clientDeviceId
      || applied.authorizationId !== claims.authorizationId
      || applied.authorizationEpoch !== claims.authorizationEpoch
      || applied.hostAuthorizationRevision !== authorization.hostAuthorizationRevision
      || applied.status !== 'active'
    ) fail('stale-authorization')
  }
  return loaded.length
}

async function inspectRegularFile(path: string): Promise<PathKind> {
  try {
    const facts = await lstat(path)
    return facts.isFile() && !facts.isSymbolicLink() ? 'file' : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return fail('storage-failed')
  }
}

async function ensureExactDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  const canonical = await realpath(path).catch(() => fail('unsafe-path'))
  if (windowsPath.normalize(canonical).toLowerCase() !== windowsPath.normalize(path).toLowerCase()) {
    fail('unsafe-path')
  }
}

async function signChallenge(
  identity: WindowsHostIdentity,
  canonicalInput: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.hostSigningPrivateKey,
    new Uint8Array(canonicalInput),
  ))
}

function emit(stream: NodeJS.WritableStream, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  stream.write(`${JSON.stringify({ event, ...fields })}\n`)
}

export function classifyProductionSessionHandshakeFailure(error: unknown):
'validate-session-init'
| 'create-session-accept:protocol-ttl-exceeded'
| 'create-session-accept:protocol-stale-authority'
| 'create-session-accept:e2ee-authentication-failed'
| 'create-session-accept:e2ee-crypto-operation-failed'
| 'create-session-accept:e2ee-invalid-key'
| 'create-session-accept:unknown'
| 'send-session-accept'
| 'unknown' {
  if (!(error instanceof Error)) return 'unknown'
  if (error.message === 'runtime-stage:validate-session-init') return 'validate-session-init'
  if (error.message === 'runtime-stage:create-session-accept:protocol-ttl-exceeded') {
    return 'create-session-accept:protocol-ttl-exceeded'
  }
  if (error.message === 'runtime-stage:create-session-accept:protocol-stale-authority') {
    return 'create-session-accept:protocol-stale-authority'
  }
  if (error.message === 'runtime-stage:create-session-accept:e2ee-authentication-failed') {
    return 'create-session-accept:e2ee-authentication-failed'
  }
  if (error.message === 'runtime-stage:create-session-accept:e2ee-crypto-operation-failed') {
    return 'create-session-accept:e2ee-crypto-operation-failed'
  }
  if (error.message === 'runtime-stage:create-session-accept:e2ee-invalid-key') {
    return 'create-session-accept:e2ee-invalid-key'
  }
  if (error.message.startsWith('runtime-stage:create-session-accept:')) {
    return 'create-session-accept:unknown'
  }
  if (error.message === 'runtime-stage:send-session-accept') return 'send-session-accept'
  return 'unknown'
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolvePromise!: () => void
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  let settled = false
  return Object.freeze({
    promise,
    resolve: () => {
      if (settled) return
      settled = true
      resolvePromise()
    },
  })
}

function waitForReconnect(milliseconds: number, shutdown: Promise<void>): Promise<void> {
  return new Promise(resolveWait => {
    const timer = setTimeout(resolveWait, milliseconds)
    shutdown.then(() => {
      clearTimeout(timer)
      resolveWait()
    }, () => resolveWait())
  })
}

async function openActionAuthority(options: ProductionRunnerOptions): Promise<WindowsAnchoredActionState> {
  const derivedAnchor = `${options.actionDatabase}.anchor.dpapi`
  if (windowsPath.normalize(derivedAnchor).toLowerCase() !== windowsPath.normalize(options.actionAnchor).toLowerCase()) {
    fail('action-anchor-path-mismatch')
  }
  return openProductionActionAuthority({
    databasePath: options.actionDatabase,
    anchorPath: options.actionAnchor,
    factory: {
      inspect: inspectRegularFile,
      create: () => WindowsAnchoredActionState.create({
        workspaceRoot: options.workspaceRoot,
        databasePath: options.actionDatabase,
      }),
      open: () => WindowsAnchoredActionState.openExisting({
        workspaceRoot: options.workspaceRoot,
        databasePath: options.actionDatabase,
      }),
    },
  })
}

export async function runProductionCompanion(
  options: ProductionRunnerOptions,
  lifecycle: Readonly<{
    signal?: AbortSignal
    interactive?: boolean
    onLocalPairingReady?: (create: (() => Promise<Readonly<{ code: string; expiresAt: number }>>) | undefined) => void
    onPairingCompleted?: () => void
  }> = {},
): Promise<void> {
  if (lifecycle.signal?.aborted) return
  const identityStore = await WindowsIdentityStore.open({
    workspaceRoot: options.workspaceRoot,
    identityFile: options.identityFile,
  })
  // loadIdentity deliberately has no initialize fallback.
  let identity = await identityStore.loadIdentity()
  await ensureExactDirectory(options.attachmentDirectory)
  await ensureExactDirectory(options.temporaryDirectory)

  const actionAuthority = await openActionAuthority(options)
  let fingerprinter: ActionRequestFingerprinter | undefined
  let supervisor: AppServerSupervisor | undefined
  let terminal: Interface | undefined
  let unbindTerminalInterrupt: (() => void) | undefined
  let projection: AppServerReadProjection | undefined
  let liveRequests: LiveRequestAuthority | undefined
  let pairingQr: ProductionPairingQr | undefined
  let activeClient: R3RelayHostClient | undefined
  let activeRuntime: PersistentMultiClientHostRuntime | undefined
  const readyHandlers = new Map<string, ReturnType<typeof createWindowsCompanionReadySessionHandler>>()
  let unsubscribeDisconnect: (() => void) | undefined
  let unsubscribeNotifications: (() => void) | undefined
  let closing: Promise<void> | undefined
  let stopped = false
  let fatalActionAuthority = false
  let diagnostics: ProductionDiagnosticLog | undefined
  const shutdown = deferred()
  const ownership = createProductionTurnOwnership()
  const liveText = createLiveTextProjection(ownership.ownsTurn, durationMs => {
    diagnostics?.record({ event: 'text.first-snapshot', durationMs })
  }, durationMs => {
    diagnostics?.record({ event: 'turn.first-text', durationMs })
  })
  const activeRequestBoundaries = new Set<Promise<unknown>>()

  const requestStop = (): void => {
    if (stopped) return
    stopped = true
    lifecycle.onLocalPairingReady?.(undefined)
    shutdown.resolve()
    void activeClient?.close().catch(() => undefined)
  }
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    requestStop()
    closing = (async () => {
      try { unsubscribeDisconnect?.() } catch { /* cleanup continues */ }
      unsubscribeDisconnect = undefined
      readyHandlers.clear()
      for (const channel of activeRuntime?.readyChannels() ?? []) {
        try { invalidateEstablishedSession(channel) } catch { /* already invalid */ }
      }
      await pairingQr?.dispose().catch(() => undefined)
      pairingQr = undefined
      await activeClient?.close().catch(() => undefined)
      activeClient = undefined
      unbindTerminalInterrupt?.()
      unbindTerminalInterrupt = undefined
      try { terminal?.close() } catch { /* cleanup continues */ }
      try { unsubscribeNotifications?.() } catch { /* cleanup continues */ }
      unsubscribeNotifications = undefined
      try { fingerprinter?.close() } catch { /* cleanup continues */ }
      await supervisor?.close().catch(() => undefined)
      await Promise.allSettled([...activeRequestBoundaries])
      await actionAuthority.close().catch(() => undefined)
      await diagnostics?.close().catch(() => undefined)
      ownership.clear()
      liveText.clear()
    })()
    return closing
  }

  const signal = (): void => { requestStop() }
  process.once('SIGINT', signal)
  process.once('SIGTERM', signal)
  lifecycle.signal?.addEventListener('abort', signal, { once: true })
  if (lifecycle.signal?.aborted) signal()

  try {
    if (stopped) return
    diagnostics = await createProductionDiagnosticLog(options.stateDirectory)
    fingerprinter = await identityStore.openActionRequestFingerprinter()
    liveRequests = createLiveRequestAuthority({
      isTaskOwned: ownership.ownsTurn,
    })
    const supervisorFailure = createProductionSupervisorFailureBoundary({
      write: line => process.stderr.write(line),
      requestStop,
      record: code => diagnostics?.record({ event: 'app-server.failed', category: code }),
    })
    supervisor = new AppServerSupervisor({
      command: {
        executable: options.codexExecutable,
        args: ['app-server'],
        cwd: options.workspaceRoot,
      },
      clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.1.0' },
      allowedMethods: [...APP_SERVER_METHODS],
      onServerRequest: request => liveRequests!.handleServerRequest(request),
      logger: event => {
        supervisorFailure.logger(event)
        if (event.event === 'request') diagnostics?.record({
          event: 'app-server.request', method: event.method,
          outcome: event.outcome, durationMs: event.durationMs,
        })
      },
    })
    projection = new AppServerReadProjection({
      supervisor,
      workspaces: [{
        id: WORKSPACE_ID,
        name: basename(options.workspaceRoot),
        path: options.workspaceRoot,
        pathLabel: basename(options.workspaceRoot),
      }],
      allowAllLocalThreads: true,
      paginateTurns: true,
    })
    if (lifecycle.interactive !== false) {
      terminal = createInterface({ input: process.stdin, output: process.stdout })
      unbindTerminalInterrupt = bindProductionTerminalInterrupt(terminal, signal)
    }

    await supervisor.start()
    unsubscribeNotifications = supervisor.onNotification(notification => liveText.observe(notification))
    const compatibility = await establishRuntimeCompatibility(supervisor)
    emit(process.stdout, 'production.runtime_binding', {
      state: compatibility.state,
      ...(compatibility.state === 'read-only' ? { reason: compatibility.reason } : {}),
    })
    const assertAuthorizationActive = createCurrentAuthorizationAssertion(identityStore, options.origin)
    const syncActionAnchor = async (): Promise<void> => {
      try {
        await actionAuthority.syncAfterRequestBoundary()
      } catch (error) {
        fatalActionAuthority = true
        throw error
      }
    }
    const anchoredBoundary = async <T>(operation: () => Promise<T>): Promise<T> => {
      const running = (async () => {
        await syncActionAnchor()
        try {
          return await operation()
        } finally {
          await syncActionAnchor()
        }
      })()
      activeRequestBoundaries.add(running)
      void running.then(
        () => { activeRequestBoundaries.delete(running) },
        () => { activeRequestBoundaries.delete(running) },
      )
      return await running
    }
    let reconnectAttempt = 0

    while (!stopped) {
      const disconnected = deferred()
      let cycle: ConnectableHostAttempt<PersistentMultiClientHostRuntime> | undefined
      try {
        const activeAuthorizationIds = await identityStore.activeAuthorizationIds()
        const signingKey = await exportPublicJwk(identity.hostSigningPublicKey)
        const signingFingerprint = await fingerprintP256PublicKey(identity.hostSigningPublicKey)

        const createAttempt = async (
          requestedAuthentication: R3RelayHostAuthentication,
        ): Promise<ConnectableHostAttempt<PersistentMultiClientHostRuntime>> => {
          let runtime!: PersistentMultiClientHostRuntime
          let client!: R3RelayHostClient
          const authentication: R3RelayHostAuthentication = requestedAuthentication.kind === 'bootstrap'
            ? Object.freeze({
                kind: 'bootstrap' as const,
                bootstrapCredential: requestedAuthentication.bootstrapCredential,
                hostSigningKey: signingKey,
                hostSigningFingerprint: signingFingerprint,
              })
            : Object.freeze({ kind: 'resume' as const })
          client = new R3ProductionRelayHostClient({
            mode: 'production',
            webSocketUrl: options.webSocketUrl,
            relayOrigin: options.origin,
            hostId: identity.hostId,
            hostDeviceId: identity.hostDeviceId,
            authentication,
            signChallenge: canonical => signChallenge(identity, canonical),
            onPairJoin: frame => anchoredBoundary(() => runtime.handlePairJoin(frame)),
            onSessionInit: async frame => {
              try {
                await anchoredBoundary(() => runtime.handleSessionInit(frame))
              } catch (error) {
                diagnostics?.record({
                  event: 'session.handshake-failed',
                  stage: classifyProductionSessionHandshakeFailure(error),
                })
                emit(process.stderr, 'production.session_handshake_failed', {
                  stage: classifyProductionSessionHandshakeFailure(error),
                })
                throw error
              }
            },
            onEnvelope: async frame => {
              const startedAt = Date.now()
              let outcome: 'succeeded' | 'failed' = 'failed'
              try {
                await anchoredBoundary(() => runtime.handleSessionEnvelope(frame))
                outcome = 'succeeded'
              } finally {
                diagnostics?.record({
                  event: 'request.boundary',
                  operation: 'other',
                  outcome,
                  durationMs: Math.max(0, Date.now() - startedAt),
                  frameBytes: frame.byteLength,
                })
              }
            },
          })
          runtime = await createPersistentMultiClientHostRuntime({
            store: identityStore,
            relayClient: client,
            relayOrigin: options.origin,
            remotePermissionModes: ['ask', 'read-only', 'full-access'],
            ...(lifecycle.onPairingCompleted === undefined ? {} : { onPairingCompleted: lifecycle.onPairingCompleted }),
            requestLocalDecision: confirmation => terminal === undefined
              ? Promise.resolve({ decision: 'deny' as const })
              : requestExactProductionPairingDecision(confirmation, {
              write: line => process.stdout.write(line),
              question: prompt => terminal!.question(prompt),
            }),
            onSessionReplacing: async channel => {
              const info = getEstablishedSessionChannelInfo(channel)
              readyHandlers.delete(info.authority.authorizationId)
              await pairingQr?.dispose().catch(() => undefined)
              pairingQr = undefined
            },
            onAuthorizationRevoked: async (tombstone, connectionGeneration) => {
              assertAuthorizationActive.invalidate(tombstone.authorizationId)
              readyHandlers.delete(tombstone.authorizationId)
              if (connectionGeneration !== undefined) {
                actionAuthority.store.applyAuthorization({
                  hostId: tombstone.hostId,
                  authorizationId: tombstone.authorizationId,
                  clientDeviceId: tombstone.clientDeviceId,
                  authorizationEpoch: tombstone.authorizationEpoch,
                  connectionGeneration,
                  status: 'revoked',
                  revision: tombstone.hostAuthorizationRevision,
                })
              }
            },
            onApplicationEnvelope: async (channel, frame) => {
              const info = getEstablishedSessionChannelInfo(channel)
              const handler = readyHandlers.get(info.authority.authorizationId)
              if (handler === undefined) fail('session-handler-unavailable')
              await handler(frame)
            },
            onReady: async channel => {
              const info = getEstablishedSessionChannelInfo(channel)
              const persisted = await identityStore.loadAuthorization(info.authority.authorizationId)
              const claims = persisted.material.grantClaims
              if (
                claims.relayOrigin !== options.origin
                || claims.hostId !== info.authority.hostId
                || claims.hostDeviceId !== info.authority.hostDeviceId
                || claims.clientDeviceId !== info.authority.clientDeviceId
                || claims.authorizationEpoch !== info.authority.authorizationEpoch
              ) fail('stale-authorization')
              actionAuthority.store.applyAuthorization({
                hostId: info.authority.hostId,
                authorizationId: info.authority.authorizationId,
                clientDeviceId: info.authority.clientDeviceId,
                authorizationEpoch: info.authority.authorizationEpoch,
                connectionGeneration: info.authority.connectionGeneration,
                status: 'active',
                revision: persisted.hostAuthorizationRevision,
              })
              actionAuthority.store.activateChannel({
                hostId: info.authority.hostId,
                authorizationId: info.authority.authorizationId,
                authorizationEpoch: info.authority.authorizationEpoch,
                connectionGeneration: info.authority.connectionGeneration,
                inboundKeyId: info.inboundKeyId,
                outboundKeyId: info.outboundKeyId,
                lastInboundSequence: info.sequenceState.lastAcceptedInboundSequence,
                lastPeerAck: info.sequenceState.lastPeerAck,
                maxSentSequence: info.sequenceState.maxSentSequence,
              })
              await syncActionAnchor()
              let lastTaskSendDisabledReason: string | undefined
              const readyHandler = createWindowsCompanionReadySessionHandler({
                state: channel,
                store: actionAuthority.store,
                projection: projection!,
                supervisor: supervisor!,
                compatibility,
                expectedSettings: EXPECTED_SETTINGS,
                attachmentDirectory: options.attachmentDirectory,
                allowFullAccess: true,
                isTaskDemoOwned: ownership.ownsTask,
                canStartTask: false,
                listManagedDevices: input => identityStore.listManagedDevices({
                  ...input,
                  onlineClientDeviceIds: runtime.readyClientDeviceIds(),
                }),
                managementActions: runtime.managementActions,
                liveRequests,
                readLiveText: taskId => liveText.read(taskId),
                onAcceptedTextTurn: proof => {
                  ownership.onAcceptedTextTurn(proof)
                  liveText.markAcceptedTurn(proof.taskId, proof.turnId)
                },
                onRuntimeFailure: code => {
                  emit(process.stderr, 'production.write_runtime_failed', { code })
                  diagnostics?.record({ event: 'app-server.failed', category: `write-${code}` })
                },
                assertAuthorizationActive,
                fingerprintCanonicalRequest: bytes => fingerprinter!.fingerprintCanonicalRequest(bytes),
                onReadFailure: (operation, category, stage) => {
                  diagnostics?.record({ event: 'read.failed', operation, category, stage })
                  emit(process.stderr, 'production.read_failed', { operation, category, stage })
                },
                onTaskSendDisabled: reason => {
                  if (lastTaskSendDisabledReason === reason) return
                  lastTaskSendDisabledReason = reason
                  diagnostics?.record({ event: 'task.send-disabled', reason })
                  emit(process.stderr, 'production.task_send_disabled', { reason })
                },
                sendEnvelope: frame => client.sendEnvelope(frame),
              })
              readyHandlers.set(info.authority.authorizationId, readyHandler)
              await pairingQr?.dispose().catch(() => undefined)
              pairingQr = undefined
              emit(process.stdout, 'production.session_ready', {
                connectionGeneration: info.authority.connectionGeneration,
              })
              diagnostics?.record({ event: 'session.ready', generation: info.authority.connectionGeneration })
            },
          })
          activeClient = client
          activeRuntime = runtime
          return Object.freeze({ client, runtime })
        }

        cycle = await connectProductionHostWithBootstrapFallback({
          ...(identity.bootstrapCredential === undefined
            ? {}
            : {
                bootstrapAuthentication: Object.freeze({
                  kind: 'bootstrap' as const,
                  bootstrapCredential: identity.bootstrapCredential,
                  hostSigningKey: signingKey,
                  hostSigningFingerprint: signingFingerprint,
                }),
              }),
          createAttempt,
          markBootstrapRegistered: () => identityStore.markBootstrapRegistered(),
        })
        await syncCurrentActiveAuthorizations(identityStore, cycle.client)
        activeClient = cycle.client
        activeRuntime = cycle.runtime
        if (identity.bootstrapCredential !== undefined) identity = await identityStore.loadIdentity()
        unsubscribeDisconnect = cycle.client.onUnexpectedDisconnect(() => {
          lifecycle.onLocalPairingReady?.(undefined)
          readyHandlers.clear()
          for (const channel of cycle?.runtime.readyChannels() ?? []) {
            try { invalidateEstablishedSession(channel) } catch { /* already invalid */ }
          }
          disconnected.resolve()
        })

        if (activeAuthorizationIds.length === 0 && lifecycle.interactive !== false) {
          const invitation = await cycle.runtime.createInvitation()
          pairingQr = await writeProductionPairingQr({
            pairingUrl: `${options.origin}/pair#${invitation.invitationFragment}`,
            expiresAt: invitation.handle.expiresAt,
            file: options.pairingQrFile,
            temporaryRoot: options.temporaryDirectory,
          })
          emit(process.stdout, 'production.pairing_qr', {
            file: pairingQr.file,
            expiresAt: pairingQr.expiresAt,
          })
        }
        emit(process.stdout, 'production.host_connected')
        const currentRuntime = cycle.runtime
        lifecycle.onLocalPairingReady?.(() => {
          if (stopped || activeRuntime !== currentRuntime) return Promise.reject(new Error('pairing-unavailable'))
          return anchoredBoundary(() => currentRuntime.createLocalPairingCode())
        })
        diagnostics?.record({ event: 'host.connected' })
        reconnectAttempt = 0
        await Promise.race([disconnected.promise, shutdown.promise])
        if (!stopped && fatalActionAuthority) fail('action-authority-failed')
      } catch (error) {
        if (fatalActionAuthority) fail('action-authority-failed')
        if (!stopped && identity.bootstrapCredential !== undefined) throw error
        if (!stopped) {
          emit(process.stderr, 'production.reconnect_pending')
          diagnostics?.record({ event: 'host.reconnect' })
        }
      } finally {
        unsubscribeDisconnect?.()
        unsubscribeDisconnect = undefined
        readyHandlers.clear()
        await pairingQr?.dispose().catch(() => undefined)
        pairingQr = undefined
        const closingClient = cycle?.client ?? activeClient
        const closingRuntime = cycle?.runtime ?? activeRuntime
        await closingClient?.close().catch(() => undefined)
        if (activeClient === closingClient) activeClient = undefined
        if (activeRuntime === closingRuntime) activeRuntime = undefined
      }
      if (stopped) break
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]!
      reconnectAttempt += 1
      await waitForReconnect(delay, shutdown.promise)
    }
    if (supervisorFailure.failed()) fail('app-server-failed')
  } finally {
    process.off('SIGINT', signal)
    process.off('SIGTERM', signal)
    lifecycle.signal?.removeEventListener('abort', signal)
    await close()
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  const current = resolve(import.meta.filename)
  const requested = resolve(entry)
  return process.platform === 'win32'
    ? current.toLowerCase() === requested.toLowerCase()
    : current === requested
}

if (typeof import.meta.filename === 'string' && isDirectExecution()) {
  const projectRoot = resolve(import.meta.dirname, '..', '..', '..')
  let options: ProductionRunnerOptions | undefined
  try {
    options = parseProductionRunnerOptions(process.argv.slice(2), projectRoot)
  } catch {
    emit(process.stderr, 'production.invalid_arguments')
    process.exitCode = 2
  }
  if (options !== undefined) {
    void runProductionCompanion(options).catch(() => {
      emit(process.stderr, 'production.failed_closed')
      process.exitCode = 1
    })
  }
}
