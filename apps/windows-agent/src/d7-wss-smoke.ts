import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import {
  exportPublicJwk,
  fingerprintP256PublicKey,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  getEstablishedSessionChannelInfo,
  openEstablishedApplication,
  sealEstablishedApplication,
  type ClientAuthorizationMaterial,
  type EstablishedSessionChannel,
  type HostAuthorizationMaterial,
} from '../../../packages/e2ee/src/index.ts'
import {
  ApplicationResponseSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  Secret32Schema,
  type EnvelopeHeader,
  type RelayReceipt,
} from '../../../packages/protocol/src/index.ts'
import {
  establishEphemeralClientSession,
  pairEphemeralClientForTest,
  signEphemeralClientRelayChallenge,
} from '../../codex-web/src/pairing-session-runtime.ts'
import {
  createR3ProductionRelayClientCarrierForTest,
  type R3RelayClientCarrier,
  type R3RelayWebSocketFactoryForTest,
} from '../../codex-web/src/relay-carrier.ts'
import WebSocket, { type RawData } from 'ws'

import {
  createEphemeralHostPairingRuntime,
  type EphemeralHostPairingRuntime,
} from './pairing-session-runtime.ts'
import {
  R3ProductionRelayHostClient,
  type R3RelayHostClient,
} from './relay-host-client.ts'

const WORKSPACE_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SYNTHETIC_ROOT = resolve(WORKSPACE_ROOT, '.tmp')
const DEFAULT_RESTART_TIMEOUT_MS = 5 * 60_000
const MAX_RESTART_TIMEOUT_MS = 15 * 60_000
const OPERATION_TIMEOUT_MS = 15_000

export interface D7WssSmokeOptions {
  readonly origin: string
  readonly webSocketUrl: string
  readonly bootstrapFile: string
  readonly restartTimeoutMs: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

interface PhaseRuntime {
  readonly host: R3RelayHostClient
  readonly runtime: EphemeralHostPairingRuntime
  readonly ready: Promise<EstablishedSessionChannel>
  readonly releaseApplication: () => void
  readonly hostChallengeCount: () => number
}

class D7WssSmokeError extends Error {
  constructor(readonly stage: string) {
    super(`D7 WSS smoke failed closed: ${stage}.`)
    this.name = 'D7WssSmokeError'
  }
}

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void
  let rejectValue!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise
    rejectValue = rejectPromise
  })
  return { promise, resolve: resolveValue, reject: rejectValue }
}

function fail(stage: string): never {
  throw new D7WssSmokeError(stage)
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function exactProductionOrigin(value: string): URL {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:'
      || url.origin !== value
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) fail('invalid-arguments')
    return url
  } catch (error) {
    if (error instanceof D7WssSmokeError) throw error
    return fail('invalid-arguments')
  }
}

/** Strict parser kept exported for focused, offline argument-boundary tests. */
export function parseD7WssSmokeArguments(
  argv: readonly string[],
  workspaceRoot = WORKSPACE_ROOT,
): D7WssSmokeOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (
      (
        name !== '--origin'
        && name !== '--bootstrap-file'
        && name !== '--restart-timeout-ms'
        && name !== '--confirm-disposable-d7-gateway'
      )
      || value === undefined
      || value.length === 0
      || values.has(name)
    ) fail('invalid-arguments')
    values.set(name, value)
  }
  const originValue = values.get('--origin')
  const bootstrapValue = values.get('--bootstrap-file')
  if (
    originValue === undefined
    || bootstrapValue === undefined
    || values.get('--confirm-disposable-d7-gateway') !== 'yes'
  ) fail('invalid-arguments')
  const origin = exactProductionOrigin(originValue)
  if (!isAbsolute(bootstrapValue) || bootstrapValue.includes('\0')) fail('invalid-arguments')
  const bootstrapFile = resolve(bootstrapValue)
  const syntheticRoot = resolve(workspaceRoot, '.tmp')
  if (!within(syntheticRoot, bootstrapFile)) fail('invalid-arguments')
  const timeoutValue = values.get('--restart-timeout-ms')
  const restartTimeoutMs = timeoutValue === undefined
    ? DEFAULT_RESTART_TIMEOUT_MS
    : Number(timeoutValue)
  if (
    !Number.isSafeInteger(restartTimeoutMs)
    || restartTimeoutMs < 1_000
    || restartTimeoutMs > MAX_RESTART_TIMEOUT_MS
  ) fail('invalid-arguments')
  return Object.freeze({
    origin: origin.origin,
    webSocketUrl: `wss://${origin.host}/api/ws`,
    bootstrapFile,
    restartTimeoutMs,
  })
}

async function readSyntheticBootstrap(file: string): Promise<string> {
  try {
    const metadata = await lstat(file)
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size < 1 || metadata.size > 128) {
      return fail('bootstrap-file')
    }
    const [canonicalFile, canonicalRoot] = await Promise.all([
      realpath(file),
      realpath(SYNTHETIC_ROOT),
    ])
    if (!within(canonicalRoot, canonicalFile)) return fail('bootstrap-file')
    const credential = await readFile(canonicalFile, 'utf8')
    if (!Secret32Schema.safeParse(credential).success) return fail('bootstrap-file')
    return credential
  } catch (error) {
    if (error instanceof D7WssSmokeError) throw error
    return fail('bootstrap-file')
  }
}

function copyRawData(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
}

function nodeProductionSocketFactory(): R3RelayWebSocketFactoryForTest {
  return input => {
    const socket = new WebSocket(input.url, {
      origin: input.relayOrigin,
      rejectUnauthorized: true,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: input.connectTimeoutMs,
    })
    return {
      get readyState() { return socket.readyState },
      send(frame) { socket.send(frame, { binary: false, compress: false }) },
      close(code, reason) { socket.close(code, reason) },
      onOpen(listener) { socket.on('open', listener) },
      onMessage(listener) {
        socket.on('message', (data, isBinary) => {
          listener(isBinary ? data : copyRawData(data), isBinary)
        })
      },
      onError(listener) { socket.on('error', listener) },
      onClose(listener) { socket.on('close', listener) },
    }
  }
}

async function signChallenge(key: CryptoKey, input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(input),
  ))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new D7WssSmokeError(stage)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function waitForLine(): Promise<void> {
  return new Promise((resolveWait, rejectWait) => {
    const done = (): void => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      resolveWait()
    }
    const onData = (): void => done()
    const onEnd = (): void => {
      process.stdin.off('data', onData)
      rejectWait(new D7WssSmokeError('restart-signal'))
    }
    process.stdin.once('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.resume()
  })
}

function emit(event: string, detail: Readonly<Record<string, string | number | boolean>> = {}): void {
  process.stdout.write(`${JSON.stringify({ event, ...detail })}\n`)
}

function syntheticManagementResponse(input: Readonly<{
  now: number
  channel: EstablishedSessionChannel
  clientSigningFingerprint: string
}>): unknown {
  const info = getEstablishedSessionChannelInfo(input.channel)
  const deviceId = info.authority.clientDeviceId
  return ApplicationResponseSchema.parse({
    kind: 'response',
    operation: 'manage.read',
    ok: true,
    result: {
      generatedAt: input.now,
      hostId: info.authority.hostId,
      connectionGeneration: info.authority.connectionGeneration,
      layers: {
        gateway: 'healthy',
        relaySocket: 'authenticated',
        host: 'online',
        e2ee: 'ready',
        companion: 'online',
        appServer: 'read-only',
      },
      devices: [{
        deviceId,
        displayName: 'D7 Synthetic Client',
        shortId: deviceId.slice(-12),
        signingFingerprint: input.clientSigningFingerprint,
        authorizationId: info.authority.authorizationId,
        authorizationEpoch: info.authority.authorizationEpoch,
        status: 'active',
        presence: 'online',
        pairedAt: input.now,
        lastSeenAt: input.now,
        isCurrent: true,
      }],
      events: [],
    },
  })
}

async function respondToSyntheticManageRead(input: Readonly<{
  frame: string | Uint8Array
  channel: EstablishedSessionChannel
  relayHost: R3RelayHostClient
  clientSigningFingerprint: string
}>): Promise<void> {
  const now = Date.now()
  const info = getEstablishedSessionChannelInfo(input.channel)
  const opened = await openEstablishedApplication({
    state: input.channel,
    frame: input.frame,
    now,
    assertAuthorizationActive: async () => {},
    commitInbound: async () => {},
  })
  if (
    opened.message.kind !== 'request'
    || opened.message.operation !== 'manage.read'
    || opened.envelope.messageType !== 'request'
    || opened.envelope.taskId !== undefined
  ) fail('host-request-binding')
  const sealed = await sealEstablishedApplication({
    state: input.channel,
    header: {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: info.authority.connectionGeneration,
      fromDeviceId: info.authority.hostDeviceId,
      toDeviceId: info.authority.clientDeviceId,
      hostId: info.authority.hostId,
      keyId: info.outboundKeyId,
      requestId: opened.envelope.requestId,
      sentAt: now,
      expiresAt: now + 10_000,
      messageType: 'response',
    },
    message: syntheticManagementResponse({
      now,
      channel: input.channel,
      clientSigningFingerprint: input.clientSigningFingerprint,
    }),
    now,
    assertAuthorizationActive: async () => {},
    persistence: {
      reserveSequence: async request => request.expectedSequence,
      commitFrame: async () => {},
    },
  })
  const receipt = await input.relayHost.sendEnvelope(sealed.wireText)
  if (receipt.state !== 'relayed') fail('host-response-relay')
}

async function createPhaseRuntime(input: Readonly<{
  options: D7WssSmokeOptions
  authentication: ConstructorParameters<typeof R3ProductionRelayHostClient>[0]['authentication']
  hostId: string
  hostDeviceId: string
  hostAgreement: CryptoKeyPair
  hostSigning: CryptoKeyPair
  initialAuthorization?: HostAuthorizationMaterial
  initialNextGeneration?: number
  commitAuthorization?: (authorization: HostAuthorizationMaterial) => void
  clientSigningFingerprint: () => string
}>): Promise<PhaseRuntime> {
  const ready = deferred<EstablishedSessionChannel>()
  const applicationGate = deferred<void>()
  let currentChannel: EstablishedSessionChannel | undefined
  let challengeCount = 0
  let runtime!: EphemeralHostPairingRuntime
  let relayHost!: R3RelayHostClient
  relayHost = new R3ProductionRelayHostClient({
    mode: 'production',
    webSocketUrl: input.options.webSocketUrl,
    relayOrigin: input.options.origin,
    hostId: input.hostId,
    hostDeviceId: input.hostDeviceId,
    authentication: input.authentication,
    signChallenge: async canonicalInput => {
      challengeCount += 1
      return signChallenge(input.hostSigning.privateKey, canonicalInput)
    },
    onPairJoin: frame => runtime.handlePairJoin(frame),
    onSessionInit: frame => runtime.handleSessionInit(frame),
    onEnvelope: async frame => {
      if (currentChannel === undefined) {
        await runtime.handleSessionEnvelope(frame)
        return
      }
      await applicationGate.promise
      await respondToSyntheticManageRead({
        frame,
        channel: currentChannel,
        relayHost,
        clientSigningFingerprint: input.clientSigningFingerprint(),
      })
    },
    connectTimeoutMs: OPERATION_TIMEOUT_MS,
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
  })
  runtime = createEphemeralHostPairingRuntime({
    relayClient: relayHost,
    relayOrigin: input.options.origin,
    hostId: input.hostId,
    hostDeviceId: input.hostDeviceId,
    hostAgreementPrivateKey: input.hostAgreement.privateKey,
    hostAgreementPublicKey: input.hostAgreement.publicKey,
    hostSigningPrivateKey: input.hostSigning.privateKey,
    hostSigningPublicKey: input.hostSigning.publicKey,
    requestLocalDecision: async () => ({ decision: 'approve' }),
    commitAuthorizationLocally: async authorization => {
      input.commitAuthorization?.(authorization)
      return { hostAuthorizationRevision: 1, nextGeneration: 1 }
    },
    ...(input.initialAuthorization === undefined
      ? {}
      : {
          initialAuthorization: input.initialAuthorization,
          initialNextGeneration: input.initialNextGeneration,
        }),
    onReady: channel => {
      currentChannel = channel
      ready.resolve(channel)
    },
  })
  return Object.freeze({
    host: relayHost,
    runtime,
    ready: ready.promise,
    releaseApplication: () => applicationGate.resolve(undefined),
    hostChallengeCount: () => challengeCount,
  })
}

function createClientCarrier(input: Readonly<{
  options: D7WssSmokeOptions
  authorization: ClientAuthorizationMaterial
  onChallenge: () => void
}>): R3RelayClientCarrier {
  const claims = input.authorization.grantClaims
  return createR3ProductionRelayClientCarrierForTest({
    mode: 'production',
    webSocketUrl: input.options.webSocketUrl,
    relayOrigin: input.options.origin,
    hostId: claims.hostId,
    hostDeviceId: claims.hostDeviceId,
    clientDeviceId: claims.clientDeviceId,
    authorizationId: claims.authorizationId,
    authorizationEpoch: claims.authorizationEpoch,
    signChallenge: async canonicalInput => {
      input.onChallenge()
      return signEphemeralClientRelayChallenge(input.authorization, canonicalInput)
    },
    connectTimeoutMs: OPERATION_TIMEOUT_MS,
    receiptTimeoutMs: OPERATION_TIMEOUT_MS,
  }, nodeProductionSocketFactory())
}

async function runManageRoundTrip(input: Readonly<{
  channel: EstablishedSessionChannel
  carrier: R3RelayClientCarrier
  releaseHostApplication: () => void
}>): Promise<number> {
  const now = Date.now()
  const info = getEstablishedSessionChannelInfo(input.channel)
  const requestId = `d7.manage.${info.authority.connectionGeneration}`
  const responseFrame = deferred<string | Uint8Array>()
  let responseSettled = false
  const unsubscribe = input.carrier.subscribe(frame => responseFrame.resolve(frame))
  try {
    const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: info.authority.connectionGeneration,
      fromDeviceId: info.authority.clientDeviceId,
      toDeviceId: info.authority.hostDeviceId,
      hostId: info.authority.hostId,
      keyId: info.outboundKeyId,
      requestId,
      sentAt: now,
      expiresAt: now + 10_000,
      messageType: 'request',
    }
    const sealed = await sealEstablishedApplication({
      state: input.channel,
      header,
      message: { kind: 'request', operation: 'manage.read', params: {} },
      now,
      assertAuthorizationActive: async () => {},
      persistence: {
        reserveSequence: async request => request.expectedSequence,
        commitFrame: async () => {},
      },
    })
    void responseFrame.promise.finally(() => { responseSettled = true }).catch(() => {})
    const receipt: RelayReceipt = await input.carrier.sendEnvelope(sealed.wireText)
    if (receipt.state !== 'relayed' || Object.hasOwn(receipt, 'result')) fail('client-relay-receipt')
    await new Promise<void>(resolveTurn => setImmediate(resolveTurn))
    if (responseSettled) fail('relay-receipt-completed-request')
    input.releaseHostApplication()
    const rawResponse = await withTimeout(
      responseFrame.promise,
      OPERATION_TIMEOUT_MS,
      'client-response-timeout',
    )
    const opened = await openEstablishedApplication({
      state: input.channel,
      frame: rawResponse,
      now: Date.now(),
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })
    const response = ApplicationResponseSchema.parse(opened.message)
    if (
      response.kind !== 'response'
      || response.operation !== 'manage.read'
      || !response.ok
      || response.result.connectionGeneration !== info.authority.connectionGeneration
      || response.result.layers.e2ee !== 'ready'
      || opened.envelope.requestId !== requestId
    ) fail('client-response-binding')
    return info.authority.connectionGeneration
  } finally {
    unsubscribe()
  }
}

async function closeQuietly(value: { close(): Promise<void> }): Promise<void> {
  try {
    await value.close()
  } catch {
    // Cleanup cannot turn a completed security assertion into a false success.
  }
}

async function run(): Promise<void> {
  const options = parseD7WssSmokeArguments(process.argv.slice(2))
  const bootstrapCredential = await readSyntheticBootstrap(options.bootstrapFile)
  const hostId = `host.d7.${randomUUID()}`
  const hostDeviceId = `device.d7.host.${randomUUID()}`
  const [hostAgreement, hostSigning] = await Promise.all([
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const hostSigningKey = await exportPublicJwk(hostSigning.publicKey)
  const hostSigningFingerprint = await fingerprintP256PublicKey(hostSigning.publicKey)
  let clientSigningFingerprint = ''
  let hostAuthorization: HostAuthorizationMaterial | undefined
  let clientAuthorization: ClientAuthorizationMaterial | undefined
  const hosts: R3RelayHostClient[] = []
  const clients: R3RelayClientCarrier[] = []

  try {
    const first = await createPhaseRuntime({
      options,
      authentication: {
        kind: 'bootstrap',
        bootstrapCredential,
        hostSigningKey,
        hostSigningFingerprint,
      },
      hostId,
      hostDeviceId,
      hostAgreement,
      hostSigning,
      commitAuthorization: authorization => { hostAuthorization = authorization },
      clientSigningFingerprint: () => clientSigningFingerprint,
    })
    hosts.push(first.host)
    await first.host.connect()
    if (first.hostChallengeCount() !== 1) fail('bootstrap-challenge')
    const invitation = await first.runtime.createInvitation()
    let fragmentCleared = false
    const paired = await pairEphemeralClientForTest({
      mode: 'production',
      invitationFragment: invitation.invitationFragment,
      expectedRelayOrigin: options.origin,
      webSocketUrl: options.webSocketUrl,
      deviceDisplayName: 'D7 Synthetic Client',
      clearInvitationFragment: () => { fragmentCleared = true },
      timeoutMs: OPERATION_TIMEOUT_MS,
    }, nodeProductionSocketFactory())
    if (!fragmentCleared || hostAuthorization === undefined) fail('pairing')
    clientAuthorization = paired.authorization
    clientSigningFingerprint = paired.clientSigningFingerprint
    let firstClientChallenges = 0
    const firstClient = createClientCarrier({
      options,
      authorization: clientAuthorization,
      onChallenge: () => { firstClientChallenges += 1 },
    })
    clients.push(firstClient)
    await firstClient.connect()
    if (firstClientChallenges !== 1) fail('client-challenge')
    const firstDisconnect = deferred<void>()
    firstClient.onUnexpectedDisconnect(() => firstDisconnect.resolve(undefined))
    const firstClientChannel = await establishEphemeralClientSession({
      authorization: clientAuthorization,
      carrier: firstClient,
    })
    await withTimeout(first.ready, OPERATION_TIMEOUT_MS, 'host-session-ready')
    const firstGeneration = await runManageRoundTrip({
      channel: firstClientChannel,
      carrier: firstClient,
      releaseHostApplication: first.releaseApplication,
    })
    emit('d7.wss.phase1-passed', {
      generation: firstGeneration,
      relayReceiptOnly: true,
      e2eeManageRead: true,
    })
    emit('d7.wss.restart-ready', {
      timeoutMs: options.restartTimeoutMs,
      instruction: 'restart-gateway-then-press-enter',
    })
    await withTimeout(
      Promise.all([firstDisconnect.promise, waitForLine()]).then(() => undefined),
      options.restartTimeoutMs,
      'restart-not-observed',
    )
    await Promise.all([closeQuietly(firstClient), closeQuietly(first.host)])

    let secondClientChallenges = 0
    const second = await createPhaseRuntime({
      options,
      authentication: { kind: 'resume' },
      hostId,
      hostDeviceId,
      hostAgreement,
      hostSigning,
      initialAuthorization: hostAuthorization,
      initialNextGeneration: firstGeneration + 1,
      clientSigningFingerprint: () => clientSigningFingerprint,
    })
    hosts.push(second.host)
    await second.host.connect()
    if (second.hostChallengeCount() !== 1) fail('host-resume-challenge')
    const secondClient = createClientCarrier({
      options,
      authorization: clientAuthorization,
      onChallenge: () => { secondClientChallenges += 1 },
    })
    clients.push(secondClient)
    await secondClient.connect()
    if (secondClientChallenges !== 1) fail('client-resume-challenge')
    let clientGenerationHighWater = firstGeneration
    const secondClientChannel = await establishEphemeralClientSession({
      authorization: clientAuthorization,
      carrier: secondClient,
      installGeneration: async request => {
        const previous = clientGenerationHighWater
        if (request.connectionGeneration <= previous) fail('generation-replay')
        clientGenerationHighWater = request.connectionGeneration
        return previous
      },
    })
    await withTimeout(second.ready, OPERATION_TIMEOUT_MS, 'host-resume-ready')
    const secondGeneration = await runManageRoundTrip({
      channel: secondClientChannel,
      carrier: secondClient,
      releaseHostApplication: second.releaseApplication,
    })
    if (secondGeneration <= firstGeneration) fail('generation-not-advanced')
    emit('d7.wss.gateway-restart-passed', {
      initialGeneration: firstGeneration,
      resumedGeneration: secondGeneration,
      gatewayRestartObserved: true,
      endpointProcessRestarted: false,
      hostChallenge: true,
      clientChallenge: true,
      pairedAgain: false,
      relayReceiptOnly: true,
      e2eeManageRead: true,
    })
  } finally {
    process.stdin.pause()
    await Promise.all([
      ...clients.map(closeQuietly),
      ...hosts.map(closeQuietly),
    ])
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

if (isDirectExecution()) {
  void run().catch(error => {
    const stage = error instanceof D7WssSmokeError ? error.stage : 'internal'
    process.stderr.write(`${JSON.stringify({ event: 'd7.wss.failed', stage })}\n`)
    process.exitCode = 1
  })
}
