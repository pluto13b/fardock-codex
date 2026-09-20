import {
  decodePairJoinFrame,
  decodePairResultFrame,
  decodeEnvelope,
  decodeRelayAuthorizationApplied,
  decodeRelayDeviceChallenge,
  decodeRelayDeviceWelcome,
  decodeRelayPairClaimed,
  decodeRelayPairOpened,
  decodeRelayPairCodeRegistered,
  encodeRelayPairCodeRegister,
  decodeRelayReceipt,
  decodeSessionAccept,
  decodeSessionInit,
  encodeBase64Url,
  encodeRelayAuthorizationPut,
  encodeRelayDeviceHello,
  encodeRelayDeviceProof,
  encodeRelayDeviceProofSignatureInput,
  encodeRelayPairClaim,
  encodeRelayPairClose,
  encodeRelayPairOpen,
  MAX_FRAME_BYTES,
  MAX_RELAY_R3_CONTROL_BYTES,
  P256RawSignatureSchema,
  PROTOCOL_VERSION,
  RelayOriginSchema,
  type P256PublicJwk,
  type RelayAuthorizationApplied,
  type RelayAuthorizationPut,
  type RelayDeviceChallenge,
  type RelayPairClaim,
  type RelayPairClaimed,
  type RelayPairClose,
  type RelayPairOpen,
  type RelayPairOpened,
  type RelayPairCodeRegister,
  type RelayPairCodeRegistered,
  type RelayReceipt,
  type RoutedEnvelope,
} from '../../../packages/protocol/src/index.ts'
import WebSocket, { type RawData } from 'ws'

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const MAX_CONNECT_TIMEOUT_MS = 60_000
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000
const MAX_OPERATION_TIMEOUT_MS = 120_000
const CLOSE_TIMEOUT_MS = 1_000
const MAX_PENDING_RECEIPTS = 128
const MAX_INBOUND_QUEUE_FRAMES = 16
const MAX_INBOUND_QUEUE_BYTES = 8 * 1024 * 1024

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

export type R3RelayHostClientErrorCode =
  | 'invalid-options'
  | 'invalid-state'
  | 'invalid-frame'
  | 'connect-timeout'
  | 'operation-timeout'
  | 'connection-failed'
  | 'connection-closed'
  | 'authentication-failed'
  | 'protocol-violation'
  | 'queue-overflow'
  | 'handler-failed'
  | 'closed'

export class R3RelayHostClientError extends Error {
  constructor(readonly code: R3RelayHostClientErrorCode) {
    super(`R3 Relay Host client failed: ${code}.`)
    this.name = 'R3RelayHostClientError'
  }
}

export type R3RelayHostAuthentication =
  | Readonly<{
      kind: 'bootstrap'
      bootstrapCredential: string
      hostSigningKey: P256PublicJwk
      hostSigningFingerprint: string
    }>
  | Readonly<{ kind: 'resume' }>

interface R3RelayHostClientCommonOptions {
  readonly webSocketUrl: string
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly authentication: R3RelayHostAuthentication
  readonly signChallenge: (
    canonicalInput: Uint8Array,
  ) => string | Uint8Array | Promise<string | Uint8Array>
  readonly onEnvelope: (rawFrame: Uint8Array) => void | Promise<void>
  readonly onPairJoin?: (rawFrame: Uint8Array) => void | Promise<void>
  readonly onSessionInit?: (rawFrame: Uint8Array) => void | Promise<void>
  readonly now?: () => number
  readonly connectTimeoutMs?: number
  readonly operationTimeoutMs?: number
}

export interface R3LoopbackRelayHostClientOptions extends R3RelayHostClientCommonOptions {
  readonly mode: 'r3-local-test'
}

export interface R3ProductionRelayHostClientOptions extends R3RelayHostClientCommonOptions {
  readonly mode: 'production'
}

type R3RelayHostClientOptions =
  | R3LoopbackRelayHostClientOptions
  | R3ProductionRelayHostClientOptions

export type R3RelayHostWebSocketFactoryForTest = (input: Readonly<{
  url: string
  relayOrigin: string
  connectTimeoutMs: number
}>) => WebSocket

export interface R3RelayHostClient {
  connect(): Promise<void>
  putAuthorization(update: RelayAuthorizationPut): Promise<RelayAuthorizationApplied>
  openPairSession(open: RelayPairOpen): Promise<RelayPairOpened>
  registerPairingCode(request: RelayPairCodeRegister): Promise<RelayPairCodeRegistered>
  claimPairSession(claim: RelayPairClaim): Promise<RelayPairClaimed>
  sendPairResult(rawFrame: string | Uint8Array): Promise<void>
  closePairSession(close: RelayPairClose): Promise<void>
  sendSessionAccept(rawFrame: string | Uint8Array): Promise<void>
  sendEnvelope(rawFrame: string | Uint8Array): Promise<RelayReceipt>
  onUnexpectedDisconnect(
    listener: (error: R3RelayHostClientError) => void,
  ): () => void
  close(): Promise<void>
}

type ClientState = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed'
type AuthenticationPhase = 'waiting-challenge' | 'signing' | 'waiting-welcome'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

interface PendingReceipt {
  readonly resolve: (receipt: RelayReceipt) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface PendingAuthorization {
  readonly expected: RelayAuthorizationPut
  readonly resolve: (applied: RelayAuthorizationApplied) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface PendingPairControl<TExpected, TResult> {
  readonly expected: TExpected
  readonly resolve: (value: TResult) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

type InboundKind = 'envelope' | 'pair-join' | 'session-init'

interface InboundFrame {
  readonly kind: InboundKind
  readonly bytes: Uint8Array
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function requireTimeout(value: number | undefined, fallback: number, maximum: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new R3RelayHostClientError('invalid-options')
  }
  return resolved
}

function isNumericLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]'
}

function parseLoopbackWebSocketUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new R3RelayHostClientError('invalid-options')
  }
  if (
    url.protocol !== 'ws:'
    || !isNumericLoopbackHostname(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.port === ''
    || url.pathname !== '/api/ws'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new R3RelayHostClientError('invalid-options')
  }
  return url
}

function parseLoopbackRelayOrigin(value: string): URL {
  const parsed = RelayOriginSchema.safeParse(value)
  if (!parsed.success) throw new R3RelayHostClientError('invalid-options')
  const url = new URL(parsed.data)
  if (
    url.protocol !== 'http:'
    || !isNumericLoopbackHostname(url.hostname)
    || url.port === ''
  ) {
    throw new R3RelayHostClientError('invalid-options')
  }
  return url
}

function parseProductionWebSocketUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new R3RelayHostClientError('invalid-options')
  }
  if (
    url.protocol !== 'wss:'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/api/ws'
    || url.search !== ''
    || url.hash !== ''
  ) throw new R3RelayHostClientError('invalid-options')
  return url
}

function parseProductionRelayOrigin(value: string): URL {
  const parsed = RelayOriginSchema.safeParse(value)
  if (!parsed.success) throw new R3RelayHostClientError('invalid-options')
  const url = new URL(parsed.data)
  if (
    url.protocol !== 'https:'
    || url.origin !== value
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) throw new R3RelayHostClientError('invalid-options')
  return url
}

function nodeRelayHostWebSocketFactory(
  input: Parameters<R3RelayHostWebSocketFactoryForTest>[0],
): WebSocket {
  return new WebSocket(input.url, {
    origin: input.relayOrigin,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    handshakeTimeout: input.connectTimeoutMs,
  })
}

function copyRawData(data: RawData | string): Uint8Array {
  if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'utf8'))
  if (Array.isArray(data)) {
    const byteLength = data.reduce((total, part) => total + part.byteLength, 0)
    const copy = new Uint8Array(byteLength)
    let offset = 0
    for (const part of data) {
      copy.set(part, offset)
      offset += part.byteLength
    }
    return copy
  }
  const view = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(view)
}

function normalizeTextFrame(frame: string | Uint8Array): string {
  if (typeof frame === 'string') return frame
  try {
    return strictDecoder.decode(new Uint8Array(frame))
  } catch {
    throw new R3RelayHostClientError('invalid-frame')
  }
}

function receiptKey(value: Pick<RelayReceipt, 'connectionGeneration' | 'requestId' | 'seq'>): string {
  return `${value.connectionGeneration}\u0000${value.requestId}\u0000${value.seq}`
}

function sameAuthorization(
  expected: RelayAuthorizationPut,
  applied: RelayAuthorizationApplied,
): boolean {
  return expected.hostId === applied.hostId
    && expected.hostDeviceId === applied.hostDeviceId
    && expected.clientDeviceId === applied.clientDeviceId
    && expected.authorizationId === applied.authorizationId
    && expected.authorizationEpoch === applied.authorizationEpoch
    && expected.hostAuthorizationRevision === applied.hostAuthorizationRevision
    && expected.status === applied.status
}

function samePairOpen(expected: RelayPairOpen, opened: RelayPairOpened): boolean {
  return expected.hostId === opened.hostId
    && expected.hostDeviceId === opened.hostDeviceId
    && expected.pairSessionId === opened.pairSessionId
    && expected.expiresAt === opened.expiresAt
}

function samePairClaim(expected: RelayPairClaim, claimed: RelayPairClaimed): boolean {
  return expected.hostId === claimed.hostId
    && expected.hostDeviceId === claimed.hostDeviceId
    && expected.pairSessionId === claimed.pairSessionId
    && expected.joinId === claimed.joinId
}

/** Shared implementation behind runtime-pinned local and production Host clients. */
class R3RelayHostClientImplementation implements R3RelayHostClient {
  private readonly webSocketUrl: string
  private readonly relayOrigin: string
  private readonly hostId: string
  private readonly hostDeviceId: string
  private readonly helloFrame: string
  private readonly expectedAuthMode: 'bootstrap' | 'challenge'
  private readonly hostSigningFingerprint?: string
  private readonly signChallenge: R3RelayHostClientCommonOptions['signChallenge']
  private readonly onEnvelope: R3RelayHostClientCommonOptions['onEnvelope']
  private readonly onPairJoin?: R3RelayHostClientCommonOptions['onPairJoin']
  private readonly onSessionInit?: R3RelayHostClientCommonOptions['onSessionInit']
  private readonly socketFactory: R3RelayHostWebSocketFactoryForTest
  private readonly now: () => number
  private readonly connectTimeoutMs: number
  private readonly operationTimeoutMs: number

  private state: ClientState = 'idle'
  private authenticationPhase?: AuthenticationPhase
  private socket?: WebSocket
  private connectDeferred?: Deferred<void>
  private connectTimer?: NodeJS.Timeout
  private closePromise?: Promise<void>
  private pendingAuthorization?: PendingAuthorization
  private pendingPairOpen?: PendingPairControl<RelayPairOpen, RelayPairOpened>
  private pendingPairCode?: PendingPairControl<RelayPairCodeRegister, RelayPairCodeRegistered>
  private pendingPairClaim?: PendingPairControl<RelayPairClaim, RelayPairClaimed>
  private readonly pendingReceipts = new Map<string, PendingReceipt>()
  private readonly inboundQueue: InboundFrame[] = []
  private readonly unexpectedDisconnectListeners = new Set<(
    error: R3RelayHostClientError,
  ) => void>()
  private inboundQueuedBytes = 0
  private inboundProcessing = false
  private activeInboundBytes = 0

  constructor(
    options: R3RelayHostClientOptions,
    socketFactory: R3RelayHostWebSocketFactoryForTest,
  ) {
    try {
      const webSocketUrl = options.mode === 'r3-local-test'
        ? parseLoopbackWebSocketUrl(options.webSocketUrl)
        : parseProductionWebSocketUrl(options.webSocketUrl)
      const relayOrigin = options.mode === 'r3-local-test'
        ? parseLoopbackRelayOrigin(options.relayOrigin)
        : parseProductionRelayOrigin(options.relayOrigin)
      if (
        options.mode === 'r3-local-test'
          ? webSocketUrl.hostname !== relayOrigin.hostname
          : webSocketUrl.host !== relayOrigin.host
      ) {
        throw new R3RelayHostClientError('invalid-options')
      }
      if (
        typeof options.signChallenge !== 'function'
        || typeof options.onEnvelope !== 'function'
        || (options.onPairJoin !== undefined && typeof options.onPairJoin !== 'function')
        || (options.onSessionInit !== undefined && typeof options.onSessionInit !== 'function')
      ) {
        throw new R3RelayHostClientError('invalid-options')
      }
      if (options.now !== undefined && typeof options.now !== 'function') {
        throw new R3RelayHostClientError('invalid-options')
      }

      this.webSocketUrl = webSocketUrl.href
      this.relayOrigin = relayOrigin.origin
      this.hostId = options.hostId
      this.hostDeviceId = options.hostDeviceId
      this.signChallenge = options.signChallenge
      this.onEnvelope = options.onEnvelope
      this.onPairJoin = options.onPairJoin
      this.onSessionInit = options.onSessionInit
      this.socketFactory = socketFactory
      this.now = options.now ?? Date.now
      this.connectTimeoutMs = requireTimeout(
        options.connectTimeoutMs,
        DEFAULT_CONNECT_TIMEOUT_MS,
        MAX_CONNECT_TIMEOUT_MS,
      )
      this.operationTimeoutMs = requireTimeout(
        options.operationTimeoutMs,
        DEFAULT_OPERATION_TIMEOUT_MS,
        MAX_OPERATION_TIMEOUT_MS,
      )

      const common = {
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'device.hello' as const,
        relayOrigin: this.relayOrigin,
        role: 'host' as const,
        hostId: this.hostId,
        hostDeviceId: this.hostDeviceId,
        deviceId: this.hostDeviceId,
      }
      if (options.authentication.kind === 'bootstrap') {
        const hostSigningKey = {
          kty: options.authentication.hostSigningKey.kty,
          crv: options.authentication.hostSigningKey.crv,
          x: options.authentication.hostSigningKey.x,
          y: options.authentication.hostSigningKey.y,
        } as const
        this.expectedAuthMode = 'bootstrap'
        this.hostSigningFingerprint = options.authentication.hostSigningFingerprint
        this.helloFrame = encodeRelayDeviceHello({
          ...common,
          authMode: 'bootstrap',
          bootstrapCredential: options.authentication.bootstrapCredential,
          hostSigningKey,
          hostSigningFingerprint: this.hostSigningFingerprint,
        })
      } else if (options.authentication.kind === 'resume') {
        this.expectedAuthMode = 'challenge'
        this.helloFrame = encodeRelayDeviceHello({ ...common, authMode: 'challenge' })
      } else {
        throw new R3RelayHostClientError('invalid-options')
      }
    } catch (error) {
      if (error instanceof R3RelayHostClientError) throw error
      throw new R3RelayHostClientError('invalid-options')
    }
  }

  connect(): Promise<void> {
    if (this.state !== 'idle') {
      return Promise.reject(new R3RelayHostClientError('invalid-state'))
    }
    this.state = 'connecting'
    this.authenticationPhase = 'waiting-challenge'
    const connection = deferred<void>()
    this.connectDeferred = connection
    this.connectTimer = setTimeout(
      () => this.fail('connect-timeout'),
      this.connectTimeoutMs,
    )

    let socket: WebSocket
    try {
      socket = this.socketFactory({
        url: this.webSocketUrl,
        relayOrigin: this.relayOrigin,
        connectTimeoutMs: this.connectTimeoutMs,
      })
    } catch {
      this.fail('connection-failed')
      return connection.promise
    }
    this.socket = socket
    socket.on('open', () => {
      void this.sendText(this.helloFrame).catch(() => this.fail('connection-failed'))
    })
    socket.on('message', (data, isBinary) => this.handleSocketMessage(data, isBinary))
    socket.on('error', () => {
      if (this.state !== 'closing' && this.state !== 'closed') {
        this.fail('connection-failed')
      }
    })
    socket.on('close', () => {
      if (this.state !== 'closing' && this.state !== 'closed' && this.state !== 'failed') {
        this.fail('connection-closed')
      }
    })
    return connection.promise
  }

  async putAuthorization(update: RelayAuthorizationPut): Promise<RelayAuthorizationApplied> {
    this.requireReady()
    if (this.pendingAuthorization !== undefined) {
      throw new R3RelayHostClientError('invalid-state')
    }

    let frame: string
    let expected: RelayAuthorizationPut
    try {
      frame = encodeRelayAuthorizationPut(update)
      expected = update
      if (expected.hostId !== this.hostId || expected.hostDeviceId !== this.hostDeviceId) {
        throw new Error('route mismatch')
      }
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }

    const operation = deferred<RelayAuthorizationApplied>()
    const timer = setTimeout(() => this.fail('operation-timeout'), this.operationTimeoutMs)
    this.pendingAuthorization = {
      expected,
      resolve: operation.resolve,
      reject: operation.reject,
      timer,
    }
    void this.sendText(frame).catch(() => this.fail('connection-failed'))
    return await operation.promise
  }

  async openPairSession(open: RelayPairOpen): Promise<RelayPairOpened> {
    this.requireReady()
    if (this.pendingPairOpen !== undefined) throw new R3RelayHostClientError('invalid-state')
    let frame: string
    try {
      frame = encodeRelayPairOpen(open)
      if (open.hostId !== this.hostId || open.hostDeviceId !== this.hostDeviceId) {
        throw new Error('route mismatch')
      }
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }
    const operation = deferred<RelayPairOpened>()
    const timer = setTimeout(() => this.fail('operation-timeout'), this.operationTimeoutMs)
    this.pendingPairOpen = { expected: open, resolve: operation.resolve, reject: operation.reject, timer }
    void this.sendText(frame).catch(() => this.fail('connection-failed'))
    return await operation.promise
  }

  async registerPairingCode(request: RelayPairCodeRegister): Promise<RelayPairCodeRegistered> {
    this.requireReady()
    if (this.pendingPairCode !== undefined) throw new R3RelayHostClientError('invalid-state')
    const frame = encodeRelayPairCodeRegister(request)
    if (request.hostId !== this.hostId || request.hostDeviceId !== this.hostDeviceId) {
      throw new R3RelayHostClientError('invalid-frame')
    }
    const operation = deferred<RelayPairCodeRegistered>()
    const timer = setTimeout(() => this.fail('operation-timeout'), this.operationTimeoutMs)
    this.pendingPairCode = { expected: request, resolve: operation.resolve, reject: operation.reject, timer }
    void this.sendText(frame).catch(() => this.fail('connection-failed'))
    return await operation.promise
  }

  async claimPairSession(claim: RelayPairClaim): Promise<RelayPairClaimed> {
    this.requireReady()
    if (this.pendingPairClaim !== undefined) throw new R3RelayHostClientError('invalid-state')
    let frame: string
    try {
      frame = encodeRelayPairClaim(claim)
      if (claim.hostId !== this.hostId || claim.hostDeviceId !== this.hostDeviceId) {
        throw new Error('route mismatch')
      }
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }
    const operation = deferred<RelayPairClaimed>()
    const timer = setTimeout(() => this.fail('operation-timeout'), this.operationTimeoutMs)
    this.pendingPairClaim = { expected: claim, resolve: operation.resolve, reject: operation.reject, timer }
    void this.sendText(frame).catch(() => this.fail('connection-failed'))
    return await operation.promise
  }

  async sendPairResult(rawFrame: string | Uint8Array): Promise<void> {
    this.requireReady()
    const frame = normalizeTextFrame(rawFrame)
    try {
      const result = decodePairResultFrame(frame, { now: this.safeNow() })
      if (result.hostId !== this.hostId) throw new Error('route mismatch')
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }
    await this.sendText(frame)
  }

  async closePairSession(close: RelayPairClose): Promise<void> {
    this.requireReady()
    let frame: string
    try {
      frame = encodeRelayPairClose(close)
      if (close.hostId !== this.hostId || close.hostDeviceId !== this.hostDeviceId) {
        throw new Error('route mismatch')
      }
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }
    await this.sendText(frame)
  }

  async sendSessionAccept(rawFrame: string | Uint8Array): Promise<void> {
    this.requireReady()
    const frame = normalizeTextFrame(rawFrame)
    try {
      const accept = decodeSessionAccept(frame, {
        expectedRelayOrigin: this.relayOrigin,
        now: this.safeNow(),
      })
      if (accept.hostId !== this.hostId || accept.hostDeviceId !== this.hostDeviceId) {
        throw new Error('route mismatch')
      }
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }
    await this.sendText(frame)
  }

  async sendEnvelope(rawFrame: string | Uint8Array): Promise<RelayReceipt> {
    this.requireReady()
    const payload = typeof rawFrame === 'string' ? rawFrame : new Uint8Array(rawFrame)
    const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload
    let envelope: RoutedEnvelope
    try {
      envelope = decodeEnvelope(bytes, { now: this.safeNow() })
    } catch {
      throw new R3RelayHostClientError('invalid-frame')
    }
    if (
      envelope.hostId !== this.hostId
      || envelope.fromDeviceId !== this.hostDeviceId
      || envelope.toDeviceId === this.hostDeviceId
    ) {
      throw new R3RelayHostClientError('invalid-frame')
    }
    if (this.pendingReceipts.size >= MAX_PENDING_RECEIPTS) {
      throw new R3RelayHostClientError('invalid-state')
    }
    const key = receiptKey(envelope)
    if (this.pendingReceipts.has(key)) {
      throw new R3RelayHostClientError('invalid-state')
    }

    const operation = deferred<RelayReceipt>()
    const timer = setTimeout(() => this.fail('operation-timeout'), this.operationTimeoutMs)
    this.pendingReceipts.set(key, {
      resolve: operation.resolve,
      reject: operation.reject,
      timer,
    })
    void this.sendText(payload).catch(() => this.fail('connection-failed'))
    return await operation.promise
  }

  onUnexpectedDisconnect(
    listener: (error: R3RelayHostClientError) => void,
  ): () => void {
    if (typeof listener !== 'function' || this.state !== 'ready') {
      throw new R3RelayHostClientError('invalid-state')
    }
    this.unexpectedDisconnectListeners.add(listener)
    return () => {
      this.unexpectedDisconnectListeners.delete(listener)
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    const promise = this.performClose()
    this.closePromise = promise
    return promise
  }

  private async performClose(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closing'
    this.authenticationPhase = undefined
    this.clearConnectTimer()
    this.rejectOutstanding(new R3RelayHostClientError('closed'))
    this.clearInboundQueue()
    this.unexpectedDisconnectListeners.clear()

    const socket = this.socket
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      this.state = 'closed'
      return
    }
    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('close', finish)
        resolve()
      }
      const timer = setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
        finish()
      }, CLOSE_TIMEOUT_MS)
      socket.once('close', finish)
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'client-close')
      else socket.terminate()
    })
    this.state = 'closed'
  }

  private handleSocketMessage(data: RawData, isBinary: boolean): void {
    if (this.state !== 'connecting' && this.state !== 'ready') return
    if (isBinary) {
      this.fail('protocol-violation')
      return
    }
    const bytes = copyRawData(data)
    if (this.state === 'connecting') {
      if (bytes.byteLength > MAX_RELAY_R3_CONTROL_BYTES) {
        this.fail('protocol-violation')
        return
      }
      void this.handleAuthenticationFrame(bytes).catch(() => this.fail('authentication-failed'))
      return
    }
    this.handleAuthenticatedFrame(bytes)
  }

  private async handleAuthenticationFrame(bytes: Uint8Array): Promise<void> {
    if (this.state !== 'connecting') return
    if (this.authenticationPhase === 'waiting-challenge') {
      const challenge = decodeRelayDeviceChallenge(bytes, this.relayOrigin, this.safeNow())
      if (!this.matchesExpectedChallenge(challenge)) {
        throw new R3RelayHostClientError('authentication-failed')
      }
      this.authenticationPhase = 'signing'
      const signed = await this.signChallenge(
        new Uint8Array(encodeRelayDeviceProofSignatureInput(challenge)),
      )
      if (this.state !== 'connecting' || this.authenticationPhase !== 'signing') return
      const signature = typeof signed === 'string'
        ? signed
        : encodeBase64Url(new Uint8Array(signed))
      if (!P256RawSignatureSchema.safeParse(signature).success) {
        throw new R3RelayHostClientError('authentication-failed')
      }
      const common = {
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'device.proof' as const,
        relayOrigin: this.relayOrigin,
        role: 'host' as const,
        hostId: this.hostId,
        hostDeviceId: this.hostDeviceId,
        deviceId: this.hostDeviceId,
        challengeId: challenge.challengeId,
        signature,
      }
      const proof = challenge.authMode === 'bootstrap'
        ? {
            ...common,
            authMode: 'bootstrap' as const,
            hostSigningFingerprint: challenge.hostSigningFingerprint,
          }
        : { ...common, authMode: 'challenge' as const }
      this.authenticationPhase = 'waiting-welcome'
      await this.sendText(encodeRelayDeviceProof(proof))
      return
    }
    if (this.authenticationPhase !== 'waiting-welcome') {
      throw new R3RelayHostClientError('authentication-failed')
    }
    const welcome = decodeRelayDeviceWelcome(bytes, this.relayOrigin)
    if (
      welcome.role !== 'host'
      || welcome.authMode !== this.expectedAuthMode
      || welcome.hostId !== this.hostId
      || welcome.hostDeviceId !== this.hostDeviceId
      || welcome.deviceId !== this.hostDeviceId
      || (
        this.expectedAuthMode === 'bootstrap'
        && (
          welcome.authMode !== 'bootstrap'
          || welcome.hostSigningFingerprint !== this.hostSigningFingerprint
        )
      )
    ) {
      throw new R3RelayHostClientError('authentication-failed')
    }
    this.authenticationPhase = undefined
    this.state = 'ready'
    this.clearConnectTimer()
    const pending = this.connectDeferred
    this.connectDeferred = undefined
    pending?.resolve(undefined)
  }

  private matchesExpectedChallenge(challenge: RelayDeviceChallenge): boolean {
    return challenge.role === 'host'
      && challenge.authMode === this.expectedAuthMode
      && challenge.hostId === this.hostId
      && challenge.hostDeviceId === this.hostDeviceId
      && challenge.deviceId === this.hostDeviceId
      && (
        challenge.authMode !== 'bootstrap'
        || challenge.hostSigningFingerprint === this.hostSigningFingerprint
      )
  }

  private handleAuthenticatedFrame(bytes: Uint8Array): void {
    try {
      const registered = decodeRelayPairCodeRegistered(bytes)
      const pending = this.pendingPairCode
      if (pending === undefined || registered.hostId !== this.hostId || registered.hostDeviceId !== this.hostDeviceId
        || registered.pairSessionId !== pending.expected.pairSessionId
        || registered.expiresAt !== pending.expected.expiresAt || registered.expiresAt <= this.safeNow()) {
        this.fail('protocol-violation')
        return
      }
      this.pendingPairCode = undefined
      clearTimeout(pending.timer)
      pending.resolve(registered)
      return
    } catch { /* Continue strict dispatch. */ }
    try {
      const receipt = decodeRelayReceipt(bytes)
      const pending = this.pendingReceipts.get(receiptKey(receipt))
      if (pending === undefined) throw new Error('unexpected receipt')
      this.pendingReceipts.delete(receiptKey(receipt))
      clearTimeout(pending.timer)
      pending.resolve(receipt)
      return
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'unexpected receipt') {
        // The frame may be another strict R3 type.
      } else {
        this.fail('protocol-violation')
        return
      }
    }

    try {
      const applied = decodeRelayAuthorizationApplied(bytes)
      const pending = this.pendingAuthorization
      if (pending === undefined || !sameAuthorization(pending.expected, applied)) {
        this.fail('protocol-violation')
        return
      }
      this.pendingAuthorization = undefined
      clearTimeout(pending.timer)
      pending.resolve(applied)
      return
    } catch {
      // The frame may be another strict R3 type.
    }

    try {
      const opened = decodeRelayPairOpened(bytes, this.safeNow())
      const pending = this.pendingPairOpen
      if (pending === undefined || !samePairOpen(pending.expected, opened)) {
        this.fail('protocol-violation')
        return
      }
      this.pendingPairOpen = undefined
      clearTimeout(pending.timer)
      pending.resolve(opened)
      return
    } catch {
      // Continue strict dispatch.
    }

    try {
      const claimed = decodeRelayPairClaimed(bytes)
      const pending = this.pendingPairClaim
      if (pending === undefined || !samePairClaim(pending.expected, claimed)) {
        this.fail('protocol-violation')
        return
      }
      this.pendingPairClaim = undefined
      clearTimeout(pending.timer)
      pending.resolve(claimed)
      return
    } catch {
      // Continue strict dispatch.
    }

    try {
      const join = decodePairJoinFrame(bytes, { now: this.safeNow() })
      if (
        join.hostId !== this.hostId
        || join.hostDeviceId !== this.hostDeviceId
        || this.onPairJoin === undefined
      ) {
        this.fail('protocol-violation')
        return
      }
      this.enqueueInbound('pair-join', bytes)
      return
    } catch {
      // Continue strict dispatch.
    }

    try {
      const init = decodeSessionInit(bytes, {
        expectedRelayOrigin: this.relayOrigin,
        now: this.safeNow(),
      })
      if (
        init.hostId !== this.hostId
        || init.hostDeviceId !== this.hostDeviceId
        || this.onSessionInit === undefined
      ) {
        this.fail('protocol-violation')
        return
      }
      this.enqueueInbound('session-init', bytes)
      return
    } catch {
      // Continue with a strict RoutedEnvelope.
    }

    let envelope: RoutedEnvelope
    try {
      envelope = decodeEnvelope(bytes, { now: this.safeNow() })
    } catch {
      this.fail('protocol-violation')
      return
    }
    if (
      envelope.hostId !== this.hostId
      || envelope.toDeviceId !== this.hostDeviceId
      || envelope.fromDeviceId === this.hostDeviceId
    ) {
      this.fail('protocol-violation')
      return
    }
    this.enqueueInbound('envelope', bytes)
  }

  private enqueueInbound(kind: InboundKind, bytes: Uint8Array): void {
    const activeFrames = this.inboundProcessing ? 1 : 0
    if (
      activeFrames + this.inboundQueue.length + 1 > MAX_INBOUND_QUEUE_FRAMES
      || this.activeInboundBytes + this.inboundQueuedBytes + bytes.byteLength > MAX_INBOUND_QUEUE_BYTES
    ) {
      this.fail('queue-overflow')
      return
    }
    this.inboundQueue.push({ kind, bytes })
    this.inboundQueuedBytes += bytes.byteLength
    if (!this.inboundProcessing) void this.drainInboundQueue()
  }

  private async drainInboundQueue(): Promise<void> {
    if (this.inboundProcessing || this.state !== 'ready') return
    this.inboundProcessing = true
    try {
      while (this.state === 'ready') {
        const frame = this.inboundQueue.shift()
        if (frame === undefined) return
        this.inboundQueuedBytes -= frame.bytes.byteLength
        this.activeInboundBytes = frame.bytes.byteLength
        try {
          const handler = frame.kind === 'envelope'
            ? this.onEnvelope
            : frame.kind === 'pair-join'
              ? this.onPairJoin
              : this.onSessionInit
          if (handler === undefined) throw new R3RelayHostClientError('protocol-violation')
          await handler(new Uint8Array(frame.bytes))
        } catch {
          this.fail('handler-failed')
          return
        } finally {
          this.activeInboundBytes = 0
        }
      }
    } finally {
      this.inboundProcessing = false
      if (this.state === 'ready' && this.inboundQueue.length > 0) {
        void this.drainInboundQueue()
      }
    }
  }

  private requireReady(): void {
    if (this.state !== 'ready') throw new R3RelayHostClientError('invalid-state')
  }

  private safeNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new R3RelayHostClientError('protocol-violation')
    }
    return value
  }

  private sendText(frame: string | Uint8Array): Promise<void> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new R3RelayHostClientError('connection-closed'))
    }
    return new Promise<void>((resolve, reject) => {
      socket.send(frame, { binary: false, compress: false }, error => {
        if (error == null) resolve()
        else reject(new R3RelayHostClientError('connection-failed'))
      })
    })
  }

  private fail(code: R3RelayHostClientErrorCode): void {
    if (this.state === 'closing' || this.state === 'closed' || this.state === 'failed') return
    const wasReady = this.state === 'ready'
    this.state = 'failed'
    this.authenticationPhase = undefined
    this.clearConnectTimer()
    const error = new R3RelayHostClientError(code)
    this.rejectOutstanding(error)
    this.clearInboundQueue()
    const disconnectListeners = wasReady
      ? [...this.unexpectedDisconnectListeners]
      : []
    this.unexpectedDisconnectListeners.clear()
    const socket = this.socket
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) socket.terminate()
    for (const listener of disconnectListeners) {
      try {
        listener(error)
      } catch {
        // Lifecycle observers cannot affect the fail-closed Host client state.
      }
    }
  }

  private rejectOutstanding(error: Error): void {
    const pairCode = this.pendingPairCode
    this.pendingPairCode = undefined
    if (pairCode !== undefined) {
      clearTimeout(pairCode.timer)
      pairCode.reject(error)
    }
    const connection = this.connectDeferred
    this.connectDeferred = undefined
    connection?.reject(error)
    const authorization = this.pendingAuthorization
    this.pendingAuthorization = undefined
    if (authorization !== undefined) {
      clearTimeout(authorization.timer)
      authorization.reject(error)
    }
    const pairOpen = this.pendingPairOpen
    this.pendingPairOpen = undefined
    if (pairOpen !== undefined) {
      clearTimeout(pairOpen.timer)
      pairOpen.reject(error)
    }
    const pairClaim = this.pendingPairClaim
    this.pendingPairClaim = undefined
    if (pairClaim !== undefined) {
      clearTimeout(pairClaim.timer)
      pairClaim.reject(error)
    }
    for (const pending of this.pendingReceipts.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingReceipts.clear()
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === undefined) return
    clearTimeout(this.connectTimer)
    this.connectTimer = undefined
  }

  private clearInboundQueue(): void {
    this.inboundQueue.length = 0
    this.inboundQueuedBytes = 0
  }
}

export class R3LoopbackRelayHostClient extends R3RelayHostClientImplementation {
  constructor(options: R3LoopbackRelayHostClientOptions) {
    if ((options as { mode?: unknown }).mode !== 'r3-local-test') {
      throw new R3RelayHostClientError('invalid-options')
    }
    super(options, nodeRelayHostWebSocketFactory)
  }
}

export class R3ProductionRelayHostClient extends R3RelayHostClientImplementation {
  constructor(options: R3ProductionRelayHostClientOptions) {
    if ((options as { mode?: unknown }).mode !== 'production') {
      throw new R3RelayHostClientError('invalid-options')
    }
    super(options, nodeRelayHostWebSocketFactory)
  }
}

/** @internal Production WSS test seam for a workspace-local test CA. */
export function createR3ProductionRelayHostClientForTest(
  options: R3ProductionRelayHostClientOptions,
  socketFactory: R3RelayHostWebSocketFactoryForTest,
): R3RelayHostClient {
  if ((options as { mode?: unknown }).mode !== 'production') {
    throw new R3RelayHostClientError('invalid-options')
  }
  return new R3RelayHostClientImplementation(options, socketFactory)
}
