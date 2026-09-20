import { VisibleDeadlines } from './visible-deadlines.ts'
import {
  decodeEnvelope,
  decodeRelayDeviceChallenge,
  decodeRelayDeviceWelcome,
  decodeRelayReceipt,
  decodeRelayPong,
  encodeRelayPing,
  decodeSessionAccept,
  decodeSessionInit,
  encodeBase64Url,
  encodeRelayDeviceHello,
  encodeRelayDeviceProof,
  encodeRelayDeviceProofSignatureInput,
  MAX_FRAME_BYTES,
  MAX_RELAY_R3_CONTROL_BYTES,
  P256RawSignatureSchema,
  PROTOCOL_VERSION,
  RelayOriginSchema,
  type RelayDeviceChallenge,
  type RelayReceipt,
  type RoutedEnvelope,
  type SessionInit,
} from '@codex-plus/protocol'

import type { RelayEnvelopeCarrier } from './relay-transport.ts'

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const MAX_CONNECT_TIMEOUT_MS = 60_000
const DEFAULT_RECEIPT_TIMEOUT_MS = 10_000
const MAX_RECEIPT_TIMEOUT_MS = 120_000
const CLOSE_TIMEOUT_MS = 500
const MAX_PENDING_RECEIPTS = 128
const MAX_INBOUND_QUEUE_FRAMES = 16
const MAX_INBOUND_QUEUE_BYTES = 8 * 1024 * 1024

const OPEN = 1
const CLOSED = 3
const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

type RawEnvelope = string | Uint8Array
type CarrierState = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed' | 'failed'
type AuthenticationPhase = 'opening' | 'waiting-challenge' | 'signing' | 'waiting-welcome'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

interface PendingReceipt {
  readonly resolve: (receipt: RelayReceipt) => void
  readonly reject: (error: Error) => void
  readonly timer: { cancel(): void }
}

interface PendingSessionAccept {
  readonly init: SessionInit
  readonly resolve: (frame: string) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** @internal Package-private socket surface used only by the real-R3 Node test. */
export interface R3RelayWebSocketForTest {
  readonly readyState: number
  send(frame: string): void
  close(code?: number, reason?: string): void
  onOpen(listener: () => void): void
  onMessage(listener: (data: unknown, isBinary: boolean) => void): void
  onError(listener: () => void): void
  onClose(listener: () => void): void
}

/** @internal Package-private socket factory used only by the real-R3 Node test. */
export type R3RelayWebSocketFactoryForTest = (input: Readonly<{
  url: string
  relayOrigin: string
  connectTimeoutMs: number
}>) => R3RelayWebSocketForTest

interface R3RelayClientCarrierCommonOptions {
  readonly webSocketUrl: string
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly signChallenge: (
    canonicalInput: Uint8Array,
  ) => string | Uint8Array | Promise<string | Uint8Array>
  readonly now?: () => number
  readonly connectTimeoutMs?: number
  readonly receiptTimeoutMs?: number
}

export interface R3LoopbackRelayClientCarrierOptions extends R3RelayClientCarrierCommonOptions {
  readonly mode: 'r3-local-test'
}

export interface R3ProductionRelayClientCarrierOptions extends R3RelayClientCarrierCommonOptions {
  readonly mode: 'production'
}

type R3RelayClientCarrierOptions =
  | R3LoopbackRelayClientCarrierOptions
  | R3ProductionRelayClientCarrierOptions

export interface R3RelayClientCarrier extends RelayEnvelopeCarrier {
  ping?(): Promise<boolean>
  setPageVisible?(visible: boolean): void
  isConnected?(): boolean
  connect(): Promise<void>
  exchangeSessionInit(frame: RawEnvelope): Promise<string>
  onUnexpectedDisconnect(
    listener: (error: R3RelayClientCarrierError) => void,
  ): () => void
  close(): Promise<void>
}

export type R3LoopbackRelayClientCarrier = R3RelayClientCarrier
export type R3ProductionRelayClientCarrier = R3RelayClientCarrier

export type R3RelayClientCarrierErrorCode =
  | 'invalid-options'
  | 'invalid-state'
  | 'invalid-frame'
  | 'connect-timeout'
  | 'receipt-timeout'
  | 'connection-failed'
  | 'connection-closed'
  | 'authentication-failed'
  | 'protocol-violation'
  | 'queue-overflow'
  | 'handler-failed'
  | 'closed'

export class R3RelayClientCarrierError extends Error {
  constructor(readonly code: R3RelayClientCarrierErrorCode) {
    super(`R3 Relay Client carrier failed: ${code}.`)
    this.name = 'R3RelayClientCarrierError'
  }
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

function requireTimeout(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new R3RelayClientCarrierError('invalid-options')
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
    throw new R3RelayClientCarrierError('invalid-options')
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
    throw new R3RelayClientCarrierError('invalid-options')
  }
  return url
}

function parseLoopbackRelayOrigin(value: string): URL {
  const parsed = RelayOriginSchema.safeParse(value)
  if (!parsed.success) throw new R3RelayClientCarrierError('invalid-options')
  const url = new URL(parsed.data)
  if (
    url.protocol !== 'http:'
    || !isNumericLoopbackHostname(url.hostname)
    || url.port === ''
  ) {
    throw new R3RelayClientCarrierError('invalid-options')
  }
  return url
}

function parseProductionWebSocketUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new R3RelayClientCarrierError('invalid-options')
  }
  if (
    url.protocol !== 'wss:'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/api/ws'
    || url.search !== ''
    || url.hash !== ''
  ) throw new R3RelayClientCarrierError('invalid-options')
  return url
}

function parseProductionRelayOrigin(value: string): URL {
  const parsed = RelayOriginSchema.safeParse(value)
  if (!parsed.success) throw new R3RelayClientCarrierError('invalid-options')
  const url = new URL(parsed.data)
  if (
    url.protocol !== 'https:'
    || url.origin !== value
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) throw new R3RelayClientCarrierError('invalid-options')
  return url
}

function receiptKey(
  value: Pick<RelayReceipt, 'connectionGeneration' | 'requestId' | 'seq'>,
): string {
  return `${value.connectionGeneration}\u0000${value.requestId}\u0000${value.seq}`
}

function normalizeTextFrame(frame: RawEnvelope): string {
  if (typeof frame === 'string') return frame
  try {
    return strictDecoder.decode(new Uint8Array(frame))
  } catch {
    throw new R3RelayClientCarrierError('invalid-frame')
  }
}

function browserWebSocketFactory(
  input: Parameters<R3RelayWebSocketFactoryForTest>[0],
): R3RelayWebSocketForTest {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new R3RelayClientCarrierError('connection-failed')
  }
  const socket = new globalThis.WebSocket(input.url)
  socket.binaryType = 'arraybuffer'
  return {
    get readyState() {
      return socket.readyState
    },
    send(frame) {
      socket.send(frame)
    },
    close(code, reason) {
      socket.close(code, reason)
    },
    onOpen(listener) {
      socket.addEventListener('open', listener)
    },
    onMessage(listener) {
      socket.addEventListener('message', event => {
        listener(event.data, typeof event.data !== 'string')
      })
    },
    onError(listener) {
      socket.addEventListener('error', listener)
    },
    onClose(listener) {
      socket.addEventListener('close', listener)
    },
  }
}

/**
 * Authenticated Client carrier shared by runtime-pinned local and production
 * factories. It transports raw encrypted envelopes; it is not application authority.
 */
class R3RelayClientCarrierImplementation implements R3RelayClientCarrier {
  private readonly webSocketUrl: string
  private readonly relayOrigin: string
  private readonly hostId: string
  private readonly hostDeviceId: string
  private readonly clientDeviceId: string
  private readonly authorizationId: string
  private readonly authorizationEpoch: number
  private readonly helloFrame: string
  private readonly signChallenge: R3RelayClientCarrierCommonOptions['signChallenge']
  private readonly now: () => number
  private readonly connectTimeoutMs: number
  private readonly receiptTimeoutMs: number
  private readonly socketFactory: R3RelayWebSocketFactoryForTest

  private state: CarrierState = 'idle'
  private authenticationPhase?: AuthenticationPhase
  private socket?: R3RelayWebSocketForTest
  private connectDeferred?: Deferred<void>
  private socketClosed?: Deferred<void>
  private connectTimer?: ReturnType<typeof setTimeout>
  private closePromise?: Promise<void>
  private readonly deadlines = new VisibleDeadlines()
  private pendingPing?: { nonce: string; finish: (ok: boolean) => void }
  private readonly pendingReceipts = new Map<string, PendingReceipt>()
  private pendingSessionAccept?: PendingSessionAccept
  private listener?: (frame: RawEnvelope) => void | Promise<void>
  private readonly inboundQueue: string[] = []
  private readonly unexpectedDisconnectListeners = new Set<(
    error: R3RelayClientCarrierError,
  ) => void>()
  private inboundQueuedBytes = 0
  private inboundProcessing = false
  private activeInboundBytes = 0

  constructor(
    options: R3RelayClientCarrierOptions,
    socketFactory: R3RelayWebSocketFactoryForTest,
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
        throw new R3RelayClientCarrierError('invalid-options')
      }
      if (typeof options.signChallenge !== 'function') {
        throw new R3RelayClientCarrierError('invalid-options')
      }
      if (options.now !== undefined && typeof options.now !== 'function') {
        throw new R3RelayClientCarrierError('invalid-options')
      }

      this.webSocketUrl = webSocketUrl.href
      this.relayOrigin = relayOrigin.origin
      this.hostId = options.hostId
      this.hostDeviceId = options.hostDeviceId
      this.clientDeviceId = options.clientDeviceId
      this.authorizationId = options.authorizationId
      this.authorizationEpoch = options.authorizationEpoch
      this.signChallenge = options.signChallenge
      this.now = options.now ?? Date.now
      this.connectTimeoutMs = requireTimeout(
        options.connectTimeoutMs,
        DEFAULT_CONNECT_TIMEOUT_MS,
        MAX_CONNECT_TIMEOUT_MS,
      )
      this.receiptTimeoutMs = requireTimeout(
        options.receiptTimeoutMs,
        DEFAULT_RECEIPT_TIMEOUT_MS,
        MAX_RECEIPT_TIMEOUT_MS,
      )
      this.socketFactory = socketFactory
      this.helloFrame = encodeRelayDeviceHello({
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'device.hello',
        relayOrigin: this.relayOrigin,
        role: 'client',
        authMode: 'challenge',
        hostId: this.hostId,
        hostDeviceId: this.hostDeviceId,
        deviceId: this.clientDeviceId,
        authorizationId: this.authorizationId,
        authorizationEpoch: this.authorizationEpoch,
      })
    } catch (error) {
      if (error instanceof R3RelayClientCarrierError) throw error
      throw new R3RelayClientCarrierError('invalid-options')
    }
  }

  connect(): Promise<void> {
    if (this.state !== 'idle') {
      return Promise.reject(new R3RelayClientCarrierError('invalid-state'))
    }
    this.state = 'connecting'
    this.authenticationPhase = 'opening'
    const connection = deferred<void>()
    this.connectDeferred = connection
    this.socketClosed = deferred<void>()
    this.connectTimer = setTimeout(
      () => this.fail('connect-timeout'),
      this.connectTimeoutMs,
    )

    let socket: R3RelayWebSocketForTest
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
    socket.onOpen(() => this.handleOpen())
    socket.onMessage((data, isBinary) => this.handleSocketMessage(data, isBinary))
    socket.onError(() => {
      if (this.state !== 'closing' && this.state !== 'closed') {
        this.fail('connection-failed')
      }
    })
    socket.onClose(() => this.handleSocketClose())
    return connection.promise
  }

  async sendEnvelope(rawFrame: RawEnvelope): Promise<RelayReceipt> {
    this.requireReady()
    const frame = normalizeTextFrame(rawFrame)
    const bytes = encoder.encode(frame)
    let envelope: RoutedEnvelope
    try {
      envelope = decodeEnvelope(bytes, { now: this.safeNow() })
    } catch {
      throw new R3RelayClientCarrierError('invalid-frame')
    }
    if (
      envelope.hostId !== this.hostId
      || envelope.fromDeviceId !== this.clientDeviceId
      || envelope.toDeviceId !== this.hostDeviceId
    ) {
      throw new R3RelayClientCarrierError('invalid-frame')
    }
    if (this.pendingReceipts.size >= MAX_PENDING_RECEIPTS) {
      throw new R3RelayClientCarrierError('queue-overflow')
    }
    const key = receiptKey(envelope)
    if (this.pendingReceipts.has(key)) {
      throw new R3RelayClientCarrierError('invalid-state')
    }

    const pending = deferred<RelayReceipt>()
    const timer = this.deadlines.after(this.receiptTimeoutMs, () => this.fail('receipt-timeout'))
    this.pendingReceipts.set(key, {
      resolve: pending.resolve,
      reject: pending.reject,
      timer,
    })
    try {
      this.sendText(frame)
    } catch {
      this.fail('connection-failed')
    }
    return await pending.promise
  }

  async exchangeSessionInit(rawFrame: RawEnvelope): Promise<string> {
    this.requireReady()
    if (this.pendingSessionAccept !== undefined) {
      throw new R3RelayClientCarrierError('invalid-state')
    }
    const frame = normalizeTextFrame(rawFrame)
    let init: SessionInit
    try {
      init = decodeSessionInit(frame, {
        expectedRelayOrigin: this.relayOrigin,
        now: this.safeNow(),
      })
      if (
        init.hostId !== this.hostId
        || init.hostDeviceId !== this.hostDeviceId
        || init.clientDeviceId !== this.clientDeviceId
        || init.authorizationId !== this.authorizationId
        || init.authorizationEpoch !== this.authorizationEpoch
      ) {
        throw new Error('route mismatch')
      }
    } catch {
      throw new R3RelayClientCarrierError('invalid-frame')
    }
    const pending = deferred<string>()
    const timer = setTimeout(() => this.fail('receipt-timeout'), this.receiptTimeoutMs)
    this.pendingSessionAccept = {
      init,
      resolve: pending.resolve,
      reject: pending.reject,
      timer,
    }
    try {
      this.sendText(frame)
    } catch {
      this.fail('connection-failed')
    }
    return await pending.promise
  }

  subscribe(listener: (frame: RawEnvelope) => void | Promise<void>): () => void {
    if (
      typeof listener !== 'function'
      || this.listener !== undefined
      || this.state === 'closing'
      || this.state === 'closed'
      || this.state === 'failed'
    ) {
      throw new R3RelayClientCarrierError('invalid-state')
    }
    this.listener = listener
    if (this.state === 'ready' && this.inboundQueue.length > 0) {
      void this.drainInboundQueue()
    }
    return () => {
      if (this.listener === listener) this.listener = undefined
    }
  }

  onUnexpectedDisconnect(
    listener: (error: R3RelayClientCarrierError) => void,
  ): () => void {
    if (typeof listener !== 'function' || this.state !== 'ready') {
      throw new R3RelayClientCarrierError('invalid-state')
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

  private handleOpen(): void {
    if (this.state !== 'connecting' || this.authenticationPhase !== 'opening') {
      this.fail('protocol-violation')
      return
    }
    this.authenticationPhase = 'waiting-challenge'
    try {
      this.sendText(this.helloFrame)
    } catch {
      this.fail('connection-failed')
    }
  }

  private handleSocketMessage(data: unknown, isBinary: boolean): void {
    if (this.state !== 'connecting' && this.state !== 'ready') return
    if (isBinary || typeof data !== 'string') {
      this.fail('protocol-violation')
      return
    }
    const byteLength = encoder.encode(data).byteLength
    if (
      byteLength > MAX_FRAME_BYTES
      || (this.state === 'connecting' && byteLength > MAX_RELAY_R3_CONTROL_BYTES)
    ) {
      this.fail('protocol-violation')
      return
    }
    if (this.state === 'connecting') {
      void this.handleAuthenticationFrame(data).catch(() => {
        this.fail('authentication-failed')
      })
      return
    }
    this.handleAuthenticatedFrame(data, byteLength)
  }

  private async handleAuthenticationFrame(frame: string): Promise<void> {
    if (this.state !== 'connecting') return
    if (this.authenticationPhase === 'waiting-challenge') {
      const challenge = decodeRelayDeviceChallenge(
        frame,
        this.relayOrigin,
        this.safeNow(),
      )
      if (!this.matchesChallenge(challenge)) {
        throw new R3RelayClientCarrierError('authentication-failed')
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
        throw new R3RelayClientCarrierError('authentication-failed')
      }
      this.authenticationPhase = 'waiting-welcome'
      this.sendText(encodeRelayDeviceProof({
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'device.proof',
        relayOrigin: this.relayOrigin,
        role: 'client',
        authMode: 'challenge',
        hostId: this.hostId,
        hostDeviceId: this.hostDeviceId,
        deviceId: this.clientDeviceId,
        authorizationId: this.authorizationId,
        authorizationEpoch: this.authorizationEpoch,
        challengeId: challenge.challengeId,
        signature,
      }))
      return
    }
    if (this.authenticationPhase !== 'waiting-welcome') {
      throw new R3RelayClientCarrierError('authentication-failed')
    }
    const welcome = decodeRelayDeviceWelcome(frame, this.relayOrigin)
    if (
      welcome.role !== 'client'
      || welcome.authMode !== 'challenge'
      || welcome.hostId !== this.hostId
      || welcome.hostDeviceId !== this.hostDeviceId
      || welcome.deviceId !== this.clientDeviceId
      || welcome.authorizationId !== this.authorizationId
      || welcome.authorizationEpoch !== this.authorizationEpoch
      || welcome.maxFrameBytes !== MAX_FRAME_BYTES
    ) {
      throw new R3RelayClientCarrierError('authentication-failed')
    }
    this.authenticationPhase = undefined
    this.state = 'ready'
    this.clearConnectTimer()
    const connection = this.connectDeferred
    this.connectDeferred = undefined
    connection?.resolve(undefined)
    if (this.listener !== undefined && this.inboundQueue.length > 0) {
      void this.drainInboundQueue()
    }
  }

  setPageVisible(visible: boolean): void { this.deadlines.setActive(visible) }
  isConnected(): boolean { return this.state === 'ready' && this.socket?.readyState === OPEN }
  ping(): Promise<boolean> {
    if (!this.isConnected() || this.pendingPing !== undefined) return Promise.resolve(false)
    return new Promise(resolvePing => {
      const nonce = globalThis.crypto.randomUUID()
      const timer = setTimeout(() => finish(false), 750)
      const finish = (ok: boolean) => {
        clearTimeout(timer)
        if (this.pendingPing?.nonce === nonce) this.pendingPing = undefined
        resolvePing(ok)
      }
      this.pendingPing = { nonce, finish }
      try { this.sendText(encodeRelayPing({ protocolVersion: PROTOCOL_VERSION, relayType: 'device.ping', nonce })) }
      catch { finish(false) }
    })
  }

  private matchesChallenge(challenge: RelayDeviceChallenge): boolean {
    return challenge.role === 'client'
      && challenge.authMode === 'challenge'
      && challenge.hostId === this.hostId
      && challenge.hostDeviceId === this.hostDeviceId
      && challenge.deviceId === this.clientDeviceId
      && challenge.authorizationId === this.authorizationId
      && challenge.authorizationEpoch === this.authorizationEpoch
  }

  private handleAuthenticatedFrame(frame: string, byteLength: number): void {
    try {
      const pong = decodeRelayPong(frame)
      if (this.pendingPing?.nonce !== pong.nonce) { this.fail('protocol-violation'); return }
      this.pendingPing.finish(true)
      return
    } catch { /* remaining strict server frames */ }
    try {
      const receipt = decodeRelayReceipt(frame)
      const key = receiptKey(receipt)
      const pending = this.pendingReceipts.get(key)
      if (pending === undefined) {
        this.fail('protocol-violation')
        return
      }
      this.pendingReceipts.delete(key)
      pending.timer.cancel()
      pending.resolve(receipt)
      return
    } catch {
      // The frame may be a session.accept or raw RoutedEnvelope.
    }

    try {
      const accept = decodeSessionAccept(frame, {
        expectedRelayOrigin: this.relayOrigin,
        now: this.safeNow(),
      })
      const pending = this.pendingSessionAccept
      if (
        pending === undefined
        || accept.hostId !== pending.init.hostId
        || accept.hostDeviceId !== pending.init.hostDeviceId
        || accept.clientDeviceId !== pending.init.clientDeviceId
        || accept.authorizationId !== pending.init.authorizationId
        || accept.authorizationEpoch !== pending.init.authorizationEpoch
        || accept.handshakeId !== pending.init.handshakeId
      ) {
        this.fail('protocol-violation')
        return
      }
      this.pendingSessionAccept = undefined
      clearTimeout(pending.timer)
      pending.resolve(frame)
      return
    } catch {
      // The only remaining authenticated server frame is a raw RoutedEnvelope.
    }

    let envelope: RoutedEnvelope
    try {
      envelope = decodeEnvelope(frame, { now: this.safeNow() })
    } catch {
      this.fail('protocol-violation')
      return
    }
    if (
      envelope.hostId !== this.hostId
      || envelope.fromDeviceId !== this.hostDeviceId
      || envelope.toDeviceId !== this.clientDeviceId
    ) {
      this.fail('protocol-violation')
      return
    }
    this.enqueueInbound(frame, byteLength)
  }

  private enqueueInbound(frame: string, byteLength: number): void {
    const activeFrames = this.inboundProcessing ? 1 : 0
    if (
      activeFrames + this.inboundQueue.length + 1 > MAX_INBOUND_QUEUE_FRAMES
      || this.activeInboundBytes + this.inboundQueuedBytes + byteLength > MAX_INBOUND_QUEUE_BYTES
    ) {
      this.fail('queue-overflow')
      return
    }
    this.inboundQueue.push(frame)
    this.inboundQueuedBytes += byteLength
    if (this.listener !== undefined && !this.inboundProcessing) {
      void this.drainInboundQueue()
    }
  }

  private async drainInboundQueue(): Promise<void> {
    if (
      this.inboundProcessing
      || this.state !== 'ready'
      || this.listener === undefined
    ) return
    this.inboundProcessing = true
    try {
      while (this.state === 'ready' && this.listener !== undefined) {
        const frame = this.inboundQueue.shift()
        if (frame === undefined) return
        const byteLength = encoder.encode(frame).byteLength
        this.inboundQueuedBytes -= byteLength
        this.activeInboundBytes = byteLength
        try {
          await this.listener(frame)
        } catch {
          this.fail('handler-failed')
          return
        } finally {
          this.activeInboundBytes = 0
        }
      }
    } finally {
      this.inboundProcessing = false
      if (
        this.state === 'ready'
        && this.listener !== undefined
        && this.inboundQueue.length > 0
      ) {
        void this.drainInboundQueue()
      }
    }
  }

  private async performClose(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closing'
    this.authenticationPhase = undefined
    this.clearConnectTimer()
    this.rejectOutstanding(new R3RelayClientCarrierError('closed'))
    this.clearInboundQueue()
    this.listener = undefined
    this.unexpectedDisconnectListeners.clear()

    const socket = this.socket
    if (socket === undefined || socket.readyState === CLOSED) {
      this.state = 'closed'
      return
    }
    try {
      socket.close(1000, 'client-close')
    } catch {
      // A bounded close does not depend on the platform surfacing another event.
    }
    await Promise.race([
      this.socketClosed?.promise ?? Promise.resolve(),
      new Promise<void>(resolve => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ])
    this.state = 'closed'
  }

  private handleSocketClose(): void {
    this.socketClosed?.resolve(undefined)
    if (this.state === 'closing' || this.state === 'closed') return
    this.fail('connection-closed', false)
  }

  private sendText(frame: string): void {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== OPEN) {
      throw new R3RelayClientCarrierError('connection-closed')
    }
    socket.send(frame)
  }

  private requireReady(): void {
    if (this.state !== 'ready') {
      throw new R3RelayClientCarrierError('invalid-state')
    }
  }

  private safeNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new R3RelayClientCarrierError('protocol-violation')
    }
    return value
  }

  private fail(code: R3RelayClientCarrierErrorCode, closeSocket = true): void {
    if (this.state === 'closing' || this.state === 'closed' || this.state === 'failed') return
    const wasReady = this.state === 'ready'
    this.state = 'failed'
    this.authenticationPhase = undefined
    this.clearConnectTimer()
    const error = new R3RelayClientCarrierError(code)
    this.rejectOutstanding(error)
    this.clearInboundQueue()
    this.listener = undefined
    const disconnectListeners = wasReady
      ? [...this.unexpectedDisconnectListeners]
      : []
    this.unexpectedDisconnectListeners.clear()
    const socket = this.socket
    if (closeSocket && socket !== undefined && socket.readyState !== CLOSED) {
      try {
        socket.close(4002, 'protocol-violation')
      } catch {
        // The carrier is already failed closed.
      }
    }
    for (const listener of disconnectListeners) {
      try {
        listener(error)
      } catch {
        // Lifecycle observers cannot affect the fail-closed carrier state.
      }
    }
  }

  private rejectOutstanding(error: Error): void {
    this.pendingPing?.finish(false)
    const connection = this.connectDeferred
    this.connectDeferred = undefined
    connection?.reject(error)
    for (const pending of this.pendingReceipts.values()) {
      pending.timer.cancel()
      pending.reject(error)
    }
    this.pendingReceipts.clear()
    const session = this.pendingSessionAccept
    this.pendingSessionAccept = undefined
    if (session !== undefined) {
      clearTimeout(session.timer)
      session.reject(error)
    }
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

export function createR3LoopbackRelayClientCarrier(
  options: R3LoopbackRelayClientCarrierOptions,
): R3LoopbackRelayClientCarrier {
  if ((options as { mode?: unknown }).mode !== 'r3-local-test') {
    throw new R3RelayClientCarrierError('invalid-options')
  }
  return new R3RelayClientCarrierImplementation(
    options,
    browserWebSocketFactory,
  )
}

export function createR3ProductionRelayClientCarrier(
  options: R3ProductionRelayClientCarrierOptions,
): R3ProductionRelayClientCarrier {
  if ((options as { mode?: unknown }).mode !== 'production') {
    throw new R3RelayClientCarrierError('invalid-options')
  }
  return new R3RelayClientCarrierImplementation(options, browserWebSocketFactory)
}

/** @internal Package-private test seam; it is not imported by the formal app. */
export function createR3LoopbackRelayClientCarrierForTest(
  options: R3LoopbackRelayClientCarrierOptions,
  socketFactory: R3RelayWebSocketFactoryForTest,
): R3LoopbackRelayClientCarrier {
  if ((options as { mode?: unknown }).mode !== 'r3-local-test') {
    throw new R3RelayClientCarrierError('invalid-options')
  }
  return new R3RelayClientCarrierImplementation(options, socketFactory)
}

/** @internal Package-private production WSS test seam. */
export function createR3ProductionRelayClientCarrierForTest(
  options: R3ProductionRelayClientCarrierOptions,
  socketFactory: R3RelayWebSocketFactoryForTest,
): R3ProductionRelayClientCarrier {
  if ((options as { mode?: unknown }).mode !== 'production') {
    throw new R3RelayClientCarrierError('invalid-options')
  }
  return new R3RelayClientCarrierImplementation(options, socketFactory)
}
