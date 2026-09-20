import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { isAbsolute } from 'node:path'

import {
  decodeBase64Url,
  decodeEnvelope,
  decodePairJoinFrame,
  decodePairingInvitationFragment,
  decodeRelayPairCodeRegister,
  encodeRelayPairCodeRegistered,
  decodePairResultFrame,
  decodeRelayAuthorizationPut,
  decodeRelayDeviceHello,
  decodeRelayDeviceProof,
  decodeRelayPing,
  encodeRelayPong,
  decodeRelayPairClaim,
  decodeRelayPairClose,
  decodeRelayPairOpen,
  decodeSessionAccept,
  decodeSessionInit,
  encodeRelayAuthorizationApplied,
  encodeRelayDeviceChallenge,
  encodeRelayDeviceProofSignatureInput,
  encodeRelayDeviceWelcome,
  encodeRelayNotAuthenticated,
  encodeRelayPairClaimed,
  encodeRelayPairOpened,
  encodeRelayReceipt,
  MAX_FRAME_BYTES,
  MAX_RELAY_CHALLENGE_TTL_MS,
  MAX_RELAY_R3_CONTROL_BYTES,
  PROTOCOL_VERSION,
  RelayOriginSchema,
  Secret32Schema,
  type P256PublicJwk,
  type RelayAuthorizationPut,
  type RelayDeviceChallenge,
  type RelayDeviceHello,
  type RelayDeviceProof,
  type RelayReceipt,
  type RelayRole,
  type RoutedEnvelope,
} from '@codex-plus/protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import type { RelayLogEntry, RelayLogEventName, RelayLogger } from './logging.ts'
import type { PairingCodeAuthority } from './pairing-code.ts'
import { normalizeIpLiteral } from './production-config.ts'
import {
  openR3RelayStateStore,
  type R3RelayActiveAuthorizationRecord,
  type R3RelayHostRegistration,
  type R3RelayStateStore,
} from './r3-state.ts'

export const R3_RELAY_CLOSE = {
  notAuthenticated: 4001,
  protocolViolation: 4002,
  rateLimited: 4008,
  replaced: 4009,
  heartbeatTimeout: 4010,
  serviceRestart: 1012,
} as const

const CLOSE_REASON = {
  notAuthenticated: 'not-authenticated',
  protocolViolation: 'protocol-violation',
  rateLimited: 'rate-limited',
  replaced: 'replaced',
  heartbeatTimeout: 'heartbeat-timeout',
  serviceRestart: 'service-restart',
  pairComplete: 'pair-complete',
} as const

const MAX_ALLOWED_ORIGINS = 16
const MAX_RATE_FRAMES = 10_000
const MAX_RATE_BYTES = 64 * MAX_FRAME_BYTES
const MAX_RATE_VIOLATIONS = 16
const MAX_BUFFERED_BYTES = 16 * MAX_FRAME_BYTES
const MAX_CONNECTIONS = 128
const MAX_PAIR_SESSIONS = 32
const MAX_PAIR_ATTEMPTS = 5
const MAX_INBOUND_QUEUE_FRAMES = 16
const MAX_INBOUND_QUEUE_BYTES = 8 * 1024 * 1024

export interface R3RelayServerOptions {
  mode: 'r3-local-test'
  stateFile: string
  relayOrigin: string
  bootstrapCredential: string
  allowedOrigins?: readonly string[]
  heartbeatIntervalMs?: number
  helloTimeoutMs?: number
  challengeTtlMs?: number
  rateLimitWindowMs?: number
  maxFramesPerWindow?: number
  maxBytesPerWindow?: number
  maxRateLimitViolations?: number
  maxOutboundBufferedBytes?: number
  maxConnections?: number
  maxPairSessions?: number
  now?: () => number
  logger?: RelayLogger
}

export interface R3ProductionRelayServerOptions extends Omit<
  R3RelayServerOptions,
  'mode' | 'bootstrapCredential' | 'allowedOrigins'
> {
  mode: 'production'
  bootstrapCredential?: string
  requireRegistrationClosed?: boolean
  trustedProxyIps: readonly string[]
  requestHandler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>
  ownerSessionAuthenticated: (request: IncomingMessage) => boolean
  pairingCodes?: Pick<PairingCodeAuthority, 'register' | 'revoke'>
}

export interface R3RelayListenOptions {
  host: '127.0.0.1' | '::1'
  port?: number
}

export interface R3ProductionRelayListenOptions {
  host: '127.0.0.1' | '0.0.0.0'
  port: number
}

export interface R3RelayAddress {
  host: '127.0.0.1' | '::1' | '0.0.0.0'
  port: number
  httpOrigin: string
  webSocketUrl: string
}

export interface R3LocalTestRelayServer {
  listen(options: R3RelayListenOptions): Promise<R3RelayAddress>
  getAddress(): R3RelayAddress | undefined
  sweepHeartbeats(): void
  close(): Promise<void>
}

export interface R3ProductionRelayServer {
  listen(options: R3ProductionRelayListenOptions): Promise<R3RelayAddress>
  getAddress(): R3RelayAddress | undefined
  close(): Promise<void>
}

interface HostIdentity {
  role: 'host'
  hostId: string
  hostDeviceId: string
  deviceId: string
}

interface ClientIdentity {
  role: 'client'
  hostId: string
  hostDeviceId: string
  deviceId: string
  authorizationId: string
  authorizationEpoch: number
}

type AuthenticatedIdentity = HostIdentity | ClientIdentity

interface PendingChallenge {
  challenge: RelayDeviceChallenge
  publicKey: KeyObject
  registration?: R3RelayHostRegistration
}

interface PairAttempt {
  connection: ConnectionRecord
  joinId: string
}

interface PairSession {
  host: ConnectionRecord
  hostId: string
  hostDeviceId: string
  pairSessionId: string
  expiresAt: number
  attemptCount: number
  attempts: Map<string, PairAttempt>
  claimed?: PairAttempt
  resultSent: boolean
  codeRegistered?: boolean
  expiryTimer: NodeJS.Timeout
}

interface ConnectionRecord {
  socket: WebSocket
  origin?: string
  ownerSessionCheck: () => boolean
  identity?: AuthenticatedIdentity
  pendingChallenge?: PendingChallenge
  pairAttempt?: { pairSessionId: string; joinId: string }
  processing: boolean
  inboundQueue: Uint8Array[]
  inboundQueuedBytes: number
  closing: boolean
  isAlive: boolean
  authTimer: NodeJS.Timeout
  terminationTimer?: NodeJS.Timeout
  rate: RateWindow
}

interface RateWindow {
  startedAt: number
  frames: number
  bytes: number
  violations: number
}

interface LogFields {
  role?: RelayRole
  outcome?: RelayLogEntry['outcome']
  frameBytes?: number
  closeCode?: number
}

function requirePositiveInteger(
  name: string,
  value: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid R3 Relay numeric option: ${name}.`)
  }
  return value
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return data
}

function identityKey(identity: AuthenticatedIdentity): string {
  return `${identity.role}\u0000${identity.hostId}\u0000${identity.deviceId}`
}

function clientIdentityKey(hostId: string, clientDeviceId: string): string {
  return `client\u0000${hostId}\u0000${clientDeviceId}`
}

function hostIdentityKey(hostId: string, hostDeviceId: string): string {
  return `host\u0000${hostId}\u0000${hostDeviceId}`
}

function decodeFixedBase64Url(value: string, expectedBytes: number): Buffer | undefined {
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== expectedBytes) return undefined
  return Buffer.from(decoded)
}

function credentialDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function credentialMatches(value: string, expectedDigest: Buffer): boolean {
  const actual = credentialDigest(value)
  return timingSafeEqual(actual, expectedDigest)
}

function importP256PublicKey(value: P256PublicJwk): KeyObject | undefined {
  try {
    const key = createPublicKey({ key: value, format: 'jwk' })
    if (
      key.asymmetricKeyType !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
    ) return undefined
    return key
  } catch {
    return undefined
  }
}

function fingerprintP256PublicKey(value: P256PublicJwk): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: value.crv, kty: value.kty, x: value.x, y: value.y }), 'utf8')
    .digest('base64url')
}

function verifyChallengeProof(
  pending: PendingChallenge,
  proof: RelayDeviceProof,
): boolean {
  const challenge = pending.challenge
  if (
    proof.role !== challenge.role
    || proof.authMode !== challenge.authMode
    || proof.hostId !== challenge.hostId
    || proof.hostDeviceId !== challenge.hostDeviceId
    || proof.deviceId !== challenge.deviceId
    || proof.challengeId !== challenge.challengeId
  ) return false
  if (
    (proof.role === 'client') !== (challenge.role === 'client')
    || (
      proof.role === 'client'
      && challenge.role === 'client'
      && (
        proof.authorizationId !== challenge.authorizationId
        || proof.authorizationEpoch !== challenge.authorizationEpoch
      )
    )
    || (
      proof.authMode === 'bootstrap'
      && challenge.authMode === 'bootstrap'
      && proof.hostSigningFingerprint !== challenge.hostSigningFingerprint
    )
  ) return false

  const signature = decodeFixedBase64Url(proof.signature, 64)
  if (signature === undefined) return false
  try {
    return verify(
      'sha256',
      encodeRelayDeviceProofSignatureInput(challenge),
      { key: pending.publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    )
  } catch {
    return false
  }
}

function numericLoopbackOrigin(value: string): boolean {
  if (!RelayOriginSchema.safeParse(value).success) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

function exactHttpsOrigin(value: string): boolean {
  if (!RelayOriginSchema.safeParse(value).success) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.origin === value
      && url.username === ''
      && url.password === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

function rejectUpgrade(
  socket: import('node:stream').Duplex,
  status: '404 Not Found' | '403 Forbidden' | '503 Service Unavailable',
): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function samePairOpen(
  session: PairSession,
  value: { hostId: string; hostDeviceId: string; pairSessionId: string; expiresAt: number },
): boolean {
  return session.hostId === value.hostId
    && session.hostDeviceId === value.hostDeviceId
    && session.pairSessionId === value.pairSessionId
    && session.expiresAt === value.expiresAt
}

class R3RelayServer {
  private readonly mode: 'r3-local-test' | 'production'
  private readonly stateFile: string
  private readonly relayOrigin: string
  private readonly bootstrapDigest?: Buffer
  private readonly allowedOrigins: ReadonlySet<string>
  private readonly requestHandler?: R3ProductionRelayServerOptions['requestHandler']
  private readonly ownerSessionAuthenticated?: R3ProductionRelayServerOptions['ownerSessionAuthenticated']
  private readonly requireRegistrationClosed: boolean
  private readonly publicHost?: string
  private readonly trustedProxyIps?: ReadonlySet<string>
  private readonly heartbeatIntervalMs: number
  private readonly helloTimeoutMs: number
  private readonly challengeTtlMs: number
  private readonly rateLimitWindowMs: number
  private readonly maxFramesPerWindow: number
  private readonly maxBytesPerWindow: number
  private readonly maxRateLimitViolations: number
  private readonly maxOutboundBufferedBytes: number
  private readonly maxConnections: number
  private readonly maxPairSessions: number
  private readonly now: () => number
  private readonly logger?: RelayLogger
  private readonly webSocketServer: WebSocketServer
  private readonly connections = new Set<ConnectionRecord>()
  private readonly online = new Map<string, ConnectionRecord>()
  private readonly pairSessions = new Map<string, PairSession>()
  private readonly pairingCodes?: Pick<PairingCodeAuthority, 'register' | 'revoke'>
  private readonly tcpSockets = new Set<Socket>()
  private readonly activeOperations = new Set<Promise<void>>()
  private stateStore?: R3RelayStateStore
  private httpServer?: HttpServer
  private heartbeatTimer?: NodeJS.Timeout
  private address?: R3RelayAddress
  private shuttingDown = false
  private lifecycle: 'idle' | 'starting' | 'listening' | 'closing' | 'closed' = 'idle'
  private listenPromise?: Promise<R3RelayAddress>
  private closePromise?: Promise<void>

  constructor(options: R3RelayServerOptions | R3ProductionRelayServerOptions) {
    if (!isAbsolute(options.stateFile)) {
      throw new Error('R3 Relay stateFile must be absolute.')
    }
    if (options.mode === 'r3-local-test') {
      if (!numericLoopbackOrigin(options.relayOrigin)) {
        throw new Error('R3 Relay origin must be a numeric loopback HTTP origin.')
      }
      if (!Secret32Schema.safeParse(options.bootstrapCredential).success) {
        throw new Error('R3 Relay bootstrap credential is invalid.')
      }
      const origins = options.allowedOrigins ?? [options.relayOrigin]
      if (
        origins.length > MAX_ALLOWED_ORIGINS
        || origins.some(origin => !numericLoopbackOrigin(origin))
        || new Set(origins).size !== origins.length
        || !origins.includes(options.relayOrigin)
      ) {
        throw new Error('R3 Relay allowedOrigins must contain its numeric loopback origin.')
      }
      this.allowedOrigins = new Set(origins)
    } else if (options.mode === 'production') {
      if (!exactHttpsOrigin(options.relayOrigin)) {
        throw new Error('Production R3 Relay requires an exact HTTPS origin.')
      }
      if (
        options.bootstrapCredential !== undefined
        && !Secret32Schema.safeParse(options.bootstrapCredential).success
      ) {
        throw new Error('Production R3 Relay bootstrap credential is invalid.')
      }
      if (typeof options.requestHandler !== 'function') {
        throw new Error('Production R3 Relay request handler is required.')
      }
      if (typeof options.ownerSessionAuthenticated !== 'function') {
        throw new Error('Production R3 Relay owner session gate is required.')
      }
      const proxyIps = options.trustedProxyIps.map(normalizeIpLiteral)
      if (
        options.trustedProxyIps.length < 1
        || options.trustedProxyIps.length > 8
        || proxyIps.some(value => value === undefined)
        || new Set(proxyIps).size !== proxyIps.length
      ) {
        throw new Error('Production R3 Relay trusted proxy IPs are invalid.')
      }
      this.allowedOrigins = new Set([options.relayOrigin])
      this.requestHandler = options.requestHandler
      this.ownerSessionAuthenticated = options.ownerSessionAuthenticated
      this.pairingCodes = options.pairingCodes
      this.publicHost = new URL(options.relayOrigin).host
      this.trustedProxyIps = new Set(proxyIps as string[])
    } else {
      throw new Error('R3 Relay mode is invalid.')
    }
    this.mode = options.mode
    this.requireRegistrationClosed = options.mode === 'production'
      && options.requireRegistrationClosed === true
    this.stateFile = options.stateFile
    this.relayOrigin = options.relayOrigin
    this.bootstrapDigest = options.bootstrapCredential === undefined
      ? undefined
      : credentialDigest(options.bootstrapCredential)
    this.heartbeatIntervalMs = requirePositiveInteger(
      'heartbeatIntervalMs', options.heartbeatIntervalMs ?? 30_000, 60_000,
    )
    this.helloTimeoutMs = requirePositiveInteger(
      'helloTimeoutMs', options.helloTimeoutMs ?? 5_000, 60_000,
    )
    this.challengeTtlMs = requirePositiveInteger(
      'challengeTtlMs', options.challengeTtlMs ?? 10_000, MAX_RELAY_CHALLENGE_TTL_MS,
    )
    this.rateLimitWindowMs = requirePositiveInteger(
      'rateLimitWindowMs', options.rateLimitWindowMs ?? 10_000, 3_600_000,
    )
    this.maxFramesPerWindow = requirePositiveInteger(
      'maxFramesPerWindow', options.maxFramesPerWindow ?? 120, MAX_RATE_FRAMES,
    )
    this.maxBytesPerWindow = requirePositiveInteger(
      'maxBytesPerWindow', options.maxBytesPerWindow ?? 8 * MAX_FRAME_BYTES, MAX_RATE_BYTES,
    )
    this.maxRateLimitViolations = requirePositiveInteger(
      'maxRateLimitViolations', options.maxRateLimitViolations ?? 2, MAX_RATE_VIOLATIONS,
    )
    this.maxOutboundBufferedBytes = requirePositiveInteger(
      'maxOutboundBufferedBytes', options.maxOutboundBufferedBytes ?? 1024 * 1024,
      MAX_BUFFERED_BYTES,
    )
    this.maxConnections = requirePositiveInteger(
      'maxConnections', options.maxConnections ?? 32, MAX_CONNECTIONS,
    )
    this.maxPairSessions = requirePositiveInteger(
      'maxPairSessions', options.maxPairSessions ?? 8, MAX_PAIR_SESSIONS,
    )
    this.now = options.now ?? Date.now
    this.logger = options.logger

    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    })
  }

  listen(options: R3RelayListenOptions | R3ProductionRelayListenOptions): Promise<R3RelayAddress> {
    if (this.lifecycle !== 'idle') {
      return Promise.reject(new Error('R3 Relay listen may only be called once.'))
    }
    this.lifecycle = 'starting'
    const promise = this.startListening(options)
    this.listenPromise = promise
    void promise.then(
      () => {
        if (this.lifecycle === 'starting') this.lifecycle = 'listening'
      },
      () => {
        if (this.lifecycle === 'starting') this.lifecycle = 'closed'
      },
    )
    return promise
  }

  private async startListening(
    options: R3RelayListenOptions | R3ProductionRelayListenOptions,
  ): Promise<R3RelayAddress> {
    if (
      this.mode === 'r3-local-test'
        ? options.host !== '127.0.0.1' && options.host !== '::1'
        : options.host !== '127.0.0.1' && options.host !== '0.0.0.0'
    ) {
      throw new Error(this.mode === 'r3-local-test'
        ? 'R3 Relay must bind a numeric loopback address.'
        : 'Production R3 Relay bind address is invalid.')
    }
    const port = options.port ?? 0
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
      throw new Error('R3 Relay port is invalid.')
    }

    const store = await openR3RelayStateStore(this.stateFile)
    if (
      this.mode === 'production'
      && !store.registrationClosed
      && (this.bootstrapDigest === undefined || this.requireRegistrationClosed)
    ) {
      await store.close()
      throw new Error('Production R3 Relay state is unavailable.')
    }
    this.stateStore = store
    if (this.shuttingDown) {
      await store.close()
      throw new Error('R3 Relay start was cancelled.')
    }

    const server = createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => {
      if (this.shuttingDown) {
        response.writeHead(503, { connection: 'close', 'content-length': '0' })
        response.end()
        return
      }
      if (request.method === 'GET' && request.url === '/healthz') {
        const body = this.mode === 'r3-local-test'
          ? '{"status":"ok","mode":"r3-local-test","insecure":true}'
          : '{"status":"ok"}'
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
        })
        response.end(body)
        return
      }
      if (this.mode === 'production' && !this.isTrustedProductionProxyRequest(request)) {
        response.writeHead(403, {
          connection: 'close',
          'content-length': '0',
          'x-content-type-options': 'nosniff',
        })
        response.end()
        return
      }
      if (this.requestHandler !== undefined) {
        void Promise.resolve()
          .then(() => this.requestHandler?.(request, response))
          .catch(() => {
            if (response.headersSent || response.writableEnded) {
              response.destroy()
              return
            }
            response.writeHead(500, {
              connection: 'close',
              'content-length': '0',
              'x-content-type-options': 'nosniff',
            })
            response.end()
          })
        return
      }
      response.writeHead(404, {
        'content-length': '0',
        'x-content-type-options': 'nosniff',
      })
      response.end()
    })
    const httpTimeoutMs = Math.min(10_000, Math.max(1_000, this.helloTimeoutMs))
    server.maxConnections = this.maxConnections
    server.maxHeadersCount = 32
    server.headersTimeout = httpTimeoutMs
    server.requestTimeout = httpTimeoutMs
    server.keepAliveTimeout = 1_000
    server.timeout = httpTimeoutMs
    server.on('connection', socket => {
      this.tcpSockets.add(socket)
      socket.once('close', () => this.tcpSockets.delete(socket))
      if (this.shuttingDown) socket.destroy()
    })
    server.on('upgrade', (request, socket, head) => {
      if (this.shuttingDown) {
        rejectUpgrade(socket, '503 Service Unavailable')
        return
      }
      if (this.mode === 'production' && !this.isTrustedProductionProxyRequest(request)) {
        rejectUpgrade(socket, '403 Forbidden')
        return
      }
      if (request.url !== '/api/ws') {
        rejectUpgrade(socket, '404 Not Found')
        return
      }
      const origin = request.headers.origin
      if (
        (this.mode === 'production' && origin === undefined)
        || (origin !== undefined && !this.allowedOrigins.has(origin))
      ) {
        rejectUpgrade(socket, '403 Forbidden')
        return
      }
      if (this.connections.size >= this.maxConnections) {
        rejectUpgrade(socket, '503 Service Unavailable')
        return
      }
      this.webSocketServer.handleUpgrade(request, socket, head, webSocket => {
        const ownerSessionCheck = this.mode !== 'production'
          ? () => true
          : () => {
          try {
            return this.ownerSessionAuthenticated?.(request) === true
          } catch {
            return false
          }
        }
        this.acceptConnection(webSocket, origin, ownerSessionCheck)
      })
    })

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen({ host: options.host, port, exclusive: true }, () => {
          server.off('error', onError)
          resolve()
        })
      })
      const actual = server.address()
      if (actual === null || typeof actual === 'string') {
        throw new Error('R3 Relay listener did not expose a numeric address.')
      }
      const address = actual as AddressInfo
      if (address.address !== options.host) {
        throw new Error('R3 Relay listener escaped the requested loopback address.')
      }
      if (this.shuttingDown) {
        for (const socket of this.tcpSockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        throw new Error('R3 Relay start was cancelled.')
      }
      const bracketedHost = options.host === '::1' ? '[::1]' : options.host
      this.httpServer = server
      this.address = {
        host: options.host,
        port: address.port,
        httpOrigin: `http://${bracketedHost}:${address.port}`,
        webSocketUrl: `ws://${bracketedHost}:${address.port}/api/ws`,
      }
      this.heartbeatTimer = setInterval(() => this.sweepHeartbeats(), this.heartbeatIntervalMs)
      this.heartbeatTimer.unref()
      this.log('relay.started')
      return this.address
    } catch (error) {
      for (const socket of this.tcpSockets) socket.destroy()
      if (server.listening) {
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      await store.close().catch(() => undefined)
      this.stateStore = undefined
      throw error
    }
  }

  getAddress(): R3RelayAddress | undefined {
    return this.address
  }

  sweepHeartbeats(): void {
    for (const record of this.connections) {
      if (record.closing || (record.identity === undefined && record.pairAttempt === undefined)) {
        continue
      }
      if (record.identity !== undefined && !this.isCurrent(record)) {
        this.beginClose(record, R3_RELAY_CLOSE.replaced, CLOSE_REASON.replaced)
        continue
      }
      if (!record.isAlive) {
        this.log('heartbeat.terminated', {
          role: record.identity?.role,
          outcome: 'terminated',
          closeCode: R3_RELAY_CLOSE.heartbeatTimeout,
        })
        this.beginClose(
          record,
          R3_RELAY_CLOSE.heartbeatTimeout,
          CLOSE_REASON.heartbeatTimeout,
        )
        continue
      }
      record.isAlive = false
      try {
        record.socket.ping()
      } catch {
        record.socket.terminate()
      }
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.shuttingDown = true
    this.lifecycle = 'closing'
    const promise = this.performClose()
    this.closePromise = promise
    return promise
  }

  private async performClose(): Promise<void> {
    if (this.listenPromise !== undefined) await this.listenPromise.catch(() => undefined)
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    for (const session of [...this.pairSessions.values()]) this.destroyPairSession(session, false)

    const server = this.httpServer
    this.httpServer = undefined
    this.address = undefined
    for (const record of this.connections) {
      clearTimeout(record.authTimer)
      if (record.terminationTimer !== undefined) clearTimeout(record.terminationTimer)
      if (
        record.socket.readyState === WebSocket.OPEN
        || record.socket.readyState === WebSocket.CONNECTING
      ) {
        record.socket.close(R3_RELAY_CLOSE.serviceRestart, CLOSE_REASON.serviceRestart)
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const record of this.connections) {
      if (record.socket.readyState !== WebSocket.CLOSED) record.socket.terminate()
    }
    for (const socket of this.tcpSockets) socket.destroy()
    await Promise.allSettled([...this.activeOperations])
    if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
    if (this.stateStore !== undefined) await this.stateStore.close()
    this.stateStore = undefined
    this.online.clear()
    this.connections.clear()
    this.tcpSockets.clear()
    this.lifecycle = 'closed'
    this.log('relay.stopped')
  }

  private acceptConnection(
    socket: WebSocket,
    origin: string | undefined,
    ownerSessionCheck: () => boolean = () => this.mode !== 'production',
  ): void {
    const currentNow = this.safeNow()
    const record = {} as ConnectionRecord
    Object.assign(record, {
      socket,
      ...(origin === undefined ? {} : { origin }),
      ownerSessionCheck,
      processing: false,
      inboundQueue: [],
      inboundQueuedBytes: 0,
      closing: false,
      isAlive: true,
      rate: { startedAt: currentNow, frames: 0, bytes: 0, violations: 0 },
      authTimer: setTimeout(() => this.rejectAuthentication(record), this.helloTimeoutMs),
    } satisfies Partial<ConnectionRecord>)
    record.authTimer.unref()
    this.connections.add(record)

    socket.on('pong', () => {
      record.isAlive = true
    })
    socket.on('message', (data, isBinary) => {
      const rawBytes = rawDataBytes(data)
      if (isBinary || rawBytes.byteLength > MAX_FRAME_BYTES) {
        if (record.identity === undefined) this.rejectAuthentication(record)
        else this.closeProtocolViolation(record)
        return
      }
      const bytes = Uint8Array.from(rawBytes)
      if (record.processing) {
        if (record.identity === undefined) this.rejectAuthentication(record)
        else this.enqueueAuthenticatedMessage(record, bytes)
        return
      }
      if (record.identity !== undefined) {
        this.enqueueAuthenticatedMessage(record, bytes)
        return
      }
      record.processing = true
      const operation = this.handleMessage(record, bytes)
        .catch(() => {
          if (record.identity === undefined) this.rejectAuthentication(record)
          else this.closeProtocolViolation(record)
        })
        .finally(() => {
          record.processing = false
        })
      this.activeOperations.add(operation)
      void operation.finally(() => this.activeOperations.delete(operation))
    })
    socket.on('close', code => this.connectionClosed(record, code))
    socket.on('error', () => {
      // Error details and raw frames are deliberately never logged.
    })
  }

  private async handleMessage(
    record: ConnectionRecord,
    bytes: Uint8Array,
  ): Promise<void> {
    if (this.shuttingDown || record.closing || record.socket.readyState !== WebSocket.OPEN) return
    if (record.identity !== undefined) {
      if (record.identity.role === 'client' && !this.ownerSessionActive(record)) {
        this.rejectAuthentication(record)
        return
      }
      if (!this.isCurrent(record)) {
        this.beginClose(record, R3_RELAY_CLOSE.replaced, CLOSE_REASON.replaced)
        return
      }
      await this.handleAuthenticatedMessage(record, bytes)
      return
    }
    if (record.pairAttempt !== undefined) {
      if (!this.ownerSessionActive(record)) {
        this.rejectAuthentication(record)
        return
      }
      this.rejectAuthentication(record)
      return
    }
    if (bytes.byteLength > MAX_RELAY_R3_CONTROL_BYTES) {
      this.rejectAuthentication(record)
      return
    }
    if (record.pendingChallenge !== undefined) {
      await this.handleProof(record, bytes)
      return
    }
    await this.handleFirstFrame(record, bytes)
  }

  private enqueueAuthenticatedMessage(record: ConnectionRecord, bytes: Uint8Array): void {
    if (
      this.shuttingDown
      || record.closing
      || record.identity === undefined
      || record.socket.readyState !== WebSocket.OPEN
    ) return
    if (
      record.inboundQueue.length >= MAX_INBOUND_QUEUE_FRAMES
      || record.inboundQueuedBytes + bytes.byteLength > MAX_INBOUND_QUEUE_BYTES
    ) {
      this.discardInboundQueue(record)
      this.beginClose(record, R3_RELAY_CLOSE.rateLimited, CLOSE_REASON.rateLimited)
      return
    }
    record.inboundQueue.push(bytes)
    record.inboundQueuedBytes += bytes.byteLength
    if (record.processing) return

    record.processing = true
    const operation = this.drainAuthenticatedMessages(record).finally(() => {
      record.processing = false
    })
    this.activeOperations.add(operation)
    void operation.finally(() => this.activeOperations.delete(operation))
  }

  private async drainAuthenticatedMessages(record: ConnectionRecord): Promise<void> {
    while (record.inboundQueue.length > 0) {
      if (
        this.shuttingDown
        || record.closing
        || record.identity === undefined
        || record.socket.readyState !== WebSocket.OPEN
      ) {
        this.discardInboundQueue(record)
        return
      }
      if (!this.isCurrent(record)) {
        this.discardInboundQueue(record)
        this.beginClose(record, R3_RELAY_CLOSE.replaced, CLOSE_REASON.replaced)
        return
      }
      const bytes = record.inboundQueue.shift()
      if (bytes === undefined) return
      record.inboundQueuedBytes -= bytes.byteLength
      try {
        await this.handleMessage(record, bytes)
      } catch {
        this.discardInboundQueue(record)
        this.closeProtocolViolation(record)
        return
      }
    }
  }

  private discardInboundQueue(record: ConnectionRecord): void {
    record.inboundQueue.length = 0
    record.inboundQueuedBytes = 0
  }

  private async handleFirstFrame(record: ConnectionRecord, bytes: Uint8Array): Promise<void> {
    try {
      const hello = decodeRelayDeviceHello(bytes, this.relayOrigin)
      if (hello.role === 'client' && !this.ownerSessionActive(record)) {
        this.rejectAuthentication(record)
        return
      }
      await this.issueChallenge(record, hello)
      return
    } catch {
      // The only other unauthenticated first-frame type is canonical pair.join.
    }
    if (record.origin !== this.relayOrigin || !this.ownerSessionActive(record)) {
      this.rejectAuthentication(record)
      return
    }
    let join
    try {
      join = decodePairJoinFrame(bytes, { now: this.safeNow() })
    } catch {
      this.rejectAuthentication(record)
      return
    }
    const session = this.pairSessions.get(join.pairSessionId)
    if (
      session === undefined
      || session.hostId !== join.hostId
      || session.hostDeviceId !== join.hostDeviceId
      || session.expiresAt <= this.safeNow()
      || !this.isCurrent(session.host)
      || session.claimed !== undefined
      || session.attempts.has(join.joinId)
      || join.expiresAt > session.expiresAt
    ) {
      this.rejectAuthentication(record)
      return
    }
    if (session.attemptCount >= MAX_PAIR_ATTEMPTS) {
      this.destroyPairSession(session, true)
      this.rejectAuthentication(record)
      return
    }
    if (!this.canSend(session.host, bytes.byteLength)) {
      this.destroyPairSession(session, true)
      this.rejectAuthentication(record)
      return
    }
    session.attemptCount += 1
    const attempt = { connection: record, joinId: join.joinId }
    session.attempts.set(join.joinId, attempt)
    record.pairAttempt = { pairSessionId: join.pairSessionId, joinId: join.joinId }
    clearTimeout(record.authTimer)
    try {
      await this.sendRaw(session.host, bytes)
      this.log('route.relayed', { outcome: 'relayed', frameBytes: bytes.byteLength })
    } catch {
      this.destroyPairSession(session, true)
    }
  }

  private ownerSessionActive(record: ConnectionRecord): boolean {
    try {
      return record.ownerSessionCheck()
    } catch {
      return false
    }
  }

  private async issueChallenge(record: ConnectionRecord, hello: RelayDeviceHello): Promise<void> {
    if (hello.role === 'client' && record.origin !== this.relayOrigin) {
      this.rejectAuthentication(record)
      return
    }
    if (record.origin !== undefined && record.origin !== this.relayOrigin) {
      this.rejectAuthentication(record)
      return
    }
    const store = this.requireStore()
    let publicKey: KeyObject | undefined
    let registration: R3RelayHostRegistration | undefined
    if (hello.authMode === 'bootstrap') {
      if (
        store.registrationClosed
        || this.bootstrapDigest === undefined
        || !credentialMatches(hello.bootstrapCredential, this.bootstrapDigest)
        || fingerprintP256PublicKey(hello.hostSigningKey) !== hello.hostSigningFingerprint
      ) {
        this.rejectAuthentication(record)
        return
      }
      publicKey = importP256PublicKey(hello.hostSigningKey)
      registration = {
        hostId: hello.hostId,
        hostDeviceId: hello.hostDeviceId,
        hostSigningKey: hello.hostSigningKey,
        hostSigningFingerprint: hello.hostSigningFingerprint,
      }
    } else if (hello.role === 'host') {
      const host = store.hostRegistration()
      if (
        host === undefined
        || host.hostId !== hello.hostId
        || host.hostDeviceId !== hello.hostDeviceId
      ) {
        this.rejectAuthentication(record)
        return
      }
      publicKey = importP256PublicKey(host.hostSigningKey)
    } else {
      const authorization = store.activeAuthorization({
        hostId: hello.hostId,
        hostDeviceId: hello.hostDeviceId,
        clientDeviceId: hello.deviceId,
        authorizationId: hello.authorizationId,
        authorizationEpoch: hello.authorizationEpoch,
      })
      if (authorization === undefined) {
        this.rejectAuthentication(record)
        return
      }
      publicKey = importP256PublicKey(authorization.clientSigningKey)
    }
    if (publicKey === undefined) {
      this.rejectAuthentication(record)
      return
    }

    const issuedAt = this.safeNow()
    const common = {
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'device.challenge' as const,
      relayOrigin: this.relayOrigin,
      role: hello.role,
      authMode: hello.authMode,
      hostId: hello.hostId,
      hostDeviceId: hello.hostDeviceId,
      deviceId: hello.deviceId,
      challengeId: `challenge.${randomBytes(18).toString('base64url')}`,
      challenge: randomBytes(32).toString('base64url'),
      issuedAt,
      expiresAt: issuedAt + this.challengeTtlMs,
    }
    const challenge: RelayDeviceChallenge = hello.authMode === 'bootstrap'
      ? { ...common, role: 'host', authMode: 'bootstrap', hostSigningFingerprint: hello.hostSigningFingerprint }
      : hello.role === 'host'
        ? { ...common, role: 'host', authMode: 'challenge' }
        : {
            ...common,
            role: 'client',
            authMode: 'challenge',
            authorizationId: hello.authorizationId,
            authorizationEpoch: hello.authorizationEpoch,
          }
    record.pendingChallenge = {
      challenge,
      publicKey,
      ...(registration === undefined ? {} : { registration }),
    }
    clearTimeout(record.authTimer)
    record.authTimer = setTimeout(() => this.rejectAuthentication(record), this.challengeTtlMs)
    record.authTimer.unref()
    await this.sendControl(record, encodeRelayDeviceChallenge(challenge))
  }

  private async handleProof(record: ConnectionRecord, bytes: Uint8Array): Promise<void> {
    const pending = record.pendingChallenge
    record.pendingChallenge = undefined
    if (pending === undefined) {
      this.rejectAuthentication(record)
      return
    }
    let proof
    try {
      proof = decodeRelayDeviceProof(bytes, this.relayOrigin)
    } catch {
      this.rejectAuthentication(record)
      return
    }
    const now = this.safeNow()
    if (
      now < pending.challenge.issuedAt
      || now >= pending.challenge.expiresAt
      || !verifyChallengeProof(pending, proof)
    ) {
      this.rejectAuthentication(record)
      return
    }
    if (pending.registration !== undefined) {
      try {
        await this.requireStore().bootstrapHost(pending.registration)
      } catch {
        this.rejectAuthentication(record)
        return
      }
    } else if (!this.challengeStillAuthorized(pending.challenge)) {
      this.rejectAuthentication(record)
      return
    }

    const identity: AuthenticatedIdentity = pending.challenge.role === 'host'
      ? {
          role: 'host',
          hostId: pending.challenge.hostId,
          hostDeviceId: pending.challenge.hostDeviceId,
          deviceId: pending.challenge.deviceId,
        }
      : {
          role: 'client',
          hostId: pending.challenge.hostId,
          hostDeviceId: pending.challenge.hostDeviceId,
          deviceId: pending.challenge.deviceId,
          authorizationId: pending.challenge.authorizationId,
          authorizationEpoch: pending.challenge.authorizationEpoch,
        }
    const welcome = encodeRelayDeviceWelcome({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'device.welcome',
      relayOrigin: this.relayOrigin,
      ...identity,
      authMode: pending.challenge.authMode,
      ...(pending.challenge.authMode === 'bootstrap'
        ? { hostSigningFingerprint: pending.challenge.hostSigningFingerprint }
        : {}),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      maxFrameBytes: MAX_FRAME_BYTES,
    })
    await this.sendControl(record, welcome)
    if (record.closing || record.socket.readyState !== WebSocket.OPEN) return
    clearTimeout(record.authTimer)
    record.identity = identity
    record.isAlive = true
    const key = identityKey(identity)
    const previous = this.online.get(key)
    this.online.set(key, record)
    if (previous !== undefined && previous !== record) {
      this.beginClose(previous, R3_RELAY_CLOSE.replaced, CLOSE_REASON.replaced)
    }
    this.log('connection.authenticated', { role: identity.role, outcome: 'authenticated' })
  }

  private challengeStillAuthorized(challenge: RelayDeviceChallenge): boolean {
    const store = this.requireStore()
    if (challenge.role === 'host') {
      const host = store.hostRegistration()
      return host !== undefined
        && host.hostId === challenge.hostId
        && host.hostDeviceId === challenge.hostDeviceId
    }
    return store.activeAuthorization({
      hostId: challenge.hostId,
      hostDeviceId: challenge.hostDeviceId,
      clientDeviceId: challenge.deviceId,
      authorizationId: challenge.authorizationId,
      authorizationEpoch: challenge.authorizationEpoch,
    }) !== undefined
  }

  private async handleAuthenticatedMessage(
    record: ConnectionRecord,
    bytes: Uint8Array,
  ): Promise<void> {
    const identity = record.identity
    if (identity === undefined) return
    const rate = this.consumeRate(record, bytes.byteLength)
    if (!rate.allowed) {
      if (rate.closeAfterSend) {
        this.beginClose(record, R3_RELAY_CLOSE.rateLimited, CLOSE_REASON.rateLimited)
        return
      }
      let envelope: RoutedEnvelope
      try {
        envelope = decodeEnvelope(bytes, { now: this.safeNow() })
      } catch {
        this.beginClose(record, R3_RELAY_CLOSE.rateLimited, CLOSE_REASON.rateLimited)
        return
      }
      await this.routeEnvelope(record, identity, envelope, bytes, 'rate-limited')
      return
    }
    if (identity.role === 'host') {
      if (await this.tryHostControl(record, identity, bytes)) return
      if (await this.tryHostSessionOrPairResult(record, identity, bytes)) return
    } else {
      try {
        const ping = decodeRelayPing(bytes)
        if (!this.isCurrent(record)) { this.closeProtocolViolation(record); return }
        await this.sendControl(record, encodeRelayPong({ ...ping, relayType: 'device.pong' }))
        return
      } catch { /* continue with strict client frames */ }
      if (await this.tryClientSession(record, identity, bytes)) return
    }
    let envelope: RoutedEnvelope
    try {
      envelope = decodeEnvelope(bytes, { now: this.safeNow() })
    } catch {
      this.closeProtocolViolation(record)
      return
    }
    await this.routeEnvelope(record, identity, envelope, bytes)
  }

  private async tryHostControl(
    record: ConnectionRecord,
    identity: HostIdentity,
    bytes: Uint8Array,
  ): Promise<boolean> {
    try {
      const request = decodeRelayPairCodeRegister(bytes)
      const invitation = decodePairingInvitationFragment(request.invitationFragment, this.relayOrigin, this.safeNow())
      const session = this.pairSessions.get(request.pairSessionId)
      if (this.pairingCodes === undefined || !this.matchesHost(identity, request)
        || session === undefined || session.host !== record || session.claimed !== undefined
        || session.codeRegistered || session.expiresAt <= this.safeNow()
        || request.expiresAt !== session.expiresAt
        || invitation.hostId !== identity.hostId || invitation.hostDeviceId !== identity.hostDeviceId
        || invitation.pairSessionId !== session.pairSessionId || invitation.expiresAt !== session.expiresAt) {
        this.closeProtocolViolation(record)
        return true
      }
      const registered = this.pairingCodes.register(request.invitationFragment, request.expiresAt)
      session.codeRegistered = true
      await this.sendControl(record, encodeRelayPairCodeRegistered({
        protocolVersion: PROTOCOL_VERSION, relayType: 'pair.code.registered',
        hostId: identity.hostId, hostDeviceId: identity.hostDeviceId,
        pairSessionId: session.pairSessionId, ...registered,
      }))
      return true
    } catch { /* Continue strict dispatch; invalid code controls fail closed. */ }
    try {
      const update = decodeRelayAuthorizationPut(bytes)
      if (!this.matchesHost(identity, update)) {
        this.closeProtocolViolation(record)
        return true
      }
      let applied
      try {
        applied = await this.requireStore().applyAuthorization(update)
      } catch {
        this.closeProtocolViolation(record)
        return true
      }
      this.invalidateClientAfterAuthorization(update)
      await this.sendControl(record, encodeRelayAuthorizationApplied({
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'authorization.applied',
        hostId: update.hostId,
        hostDeviceId: update.hostDeviceId,
        clientDeviceId: update.clientDeviceId,
        authorizationId: update.authorizationId,
        authorizationEpoch: update.authorizationEpoch,
        hostAuthorizationRevision: update.hostAuthorizationRevision,
        status: applied.authorization.status,
      }))
      return true
    } catch {
      // Try the remaining Host-only strict control frames.
    }

    try {
      const open = decodeRelayPairOpen(bytes, this.safeNow())
      if (!this.matchesHost(identity, open)) {
        this.closeProtocolViolation(record)
        return true
      }
      const existing = this.pairSessions.get(open.pairSessionId)
      if (existing !== undefined) {
        if (!samePairOpen(existing, open) || existing.host !== record) {
          this.closeProtocolViolation(record)
          return true
        }
      } else {
        if (this.pairSessions.size >= this.maxPairSessions) {
          this.closeProtocolViolation(record)
          return true
        }
        const session = {} as PairSession
        Object.assign(session, {
          host: record,
          hostId: open.hostId,
          hostDeviceId: open.hostDeviceId,
          pairSessionId: open.pairSessionId,
          expiresAt: open.expiresAt,
          attemptCount: 0,
          attempts: new Map<string, PairAttempt>(),
          resultSent: false,
          expiryTimer: setTimeout(() => this.destroyPairSession(session, true), open.expiresAt - this.safeNow()),
        } satisfies Partial<PairSession>)
        session.expiryTimer.unref()
        this.pairSessions.set(open.pairSessionId, session)
      }
      await this.sendControl(record, encodeRelayPairOpened({ ...open, relayType: 'pair.opened' }))
      return true
    } catch {
      // Continue strict dispatch.
    }

    try {
      const claim = decodeRelayPairClaim(bytes)
      if (!this.matchesHost(identity, claim)) {
        this.closeProtocolViolation(record)
        return true
      }
      const session = this.pairSessions.get(claim.pairSessionId)
      const attempt = session?.attempts.get(claim.joinId)
      if (
        session === undefined
        || session.host !== record
        || session.claimed !== undefined
        || attempt === undefined
        || attempt.connection.closing
      ) {
        this.closeProtocolViolation(record)
        return true
      }
      session.claimed = attempt
      for (const other of [...session.attempts.values()]) {
        if (other !== attempt) this.rejectAuthentication(other.connection)
      }
      await this.sendControl(record, encodeRelayPairClaimed({ ...claim, relayType: 'pair.claimed' }))
      return true
    } catch {
      // Continue strict dispatch.
    }

    try {
      const close = decodeRelayPairClose(bytes)
      if (!this.matchesHost(identity, close)) {
        this.closeProtocolViolation(record)
        return true
      }
      const session = this.pairSessions.get(close.pairSessionId)
      if (session === undefined || session.host !== record) {
        this.closeProtocolViolation(record)
        return true
      }
      this.destroyPairSession(session, true)
      return true
    } catch {
      return false
    }
  }

  private async tryHostSessionOrPairResult(
    record: ConnectionRecord,
    identity: HostIdentity,
    bytes: Uint8Array,
  ): Promise<boolean> {
    try {
      const accept = decodeSessionAccept(bytes, {
        expectedRelayOrigin: this.relayOrigin,
        now: this.safeNow(),
      })
      if (!this.matchesHost(identity, accept)) {
        this.closeProtocolViolation(record)
        return true
      }
      const authorization = this.activeAuthorizationForClient(accept.clientDeviceId)
      if (!this.authorizationMatchesHandshake(authorization, accept)) {
        this.closeProtocolViolation(record)
        return true
      }
      const target = this.online.get(clientIdentityKey(accept.hostId, accept.clientDeviceId))
      if (target !== undefined && this.isCurrent(target)) {
        if (!this.clientRecordMatchesAuthorization(target, authorization)) {
          this.rejectAuthentication(target)
          return true
        }
        if (this.canSend(target, bytes.byteLength)) {
          try {
            await this.sendRaw(target, bytes)
            this.log('route.relayed', { role: 'host', outcome: 'relayed', frameBytes: bytes.byteLength })
          } catch {
            this.log('route.unavailable', { role: 'host', outcome: 'unavailable', frameBytes: bytes.byteLength })
          }
        } else {
          this.log('route.backpressure', { role: 'host', outcome: 'backpressure', frameBytes: bytes.byteLength })
        }
      }
      return true
    } catch {
      // Try pair.result.
    }
    try {
      const result = decodePairResultFrame(bytes, { now: this.safeNow() })
      if (!this.matchesHost(identity, result)) {
        this.closeProtocolViolation(record)
        return true
      }
      const session = this.pairSessions.get(result.pairSessionId)
      const claimed = session?.claimed
      if (
        session === undefined
        || session.host !== record
        || claimed === undefined
        || claimed.joinId !== result.joinId
        || claimed.connection.closing
        || session.resultSent
        || session.expiresAt <= this.safeNow()
        || result.expiresAt > session.expiresAt
      ) {
        this.closeProtocolViolation(record)
        return true
      }
      try {
        await this.sendRaw(claimed.connection, bytes)
        session.resultSent = true
        this.log('route.relayed', { role: 'host', outcome: 'relayed', frameBytes: bytes.byteLength })
      } catch {
        this.destroyPairSession(session, true)
      }
      return true
    } catch {
      return false
    }
  }

  private async tryClientSession(
    record: ConnectionRecord,
    identity: ClientIdentity,
    bytes: Uint8Array,
  ): Promise<boolean> {
    try {
      const init = decodeSessionInit(bytes, {
        expectedRelayOrigin: this.relayOrigin,
        now: this.safeNow(),
      })
      if (
        init.hostId !== identity.hostId
        || init.hostDeviceId !== identity.hostDeviceId
        || init.clientDeviceId !== identity.deviceId
        || init.authorizationId !== identity.authorizationId
        || init.authorizationEpoch !== identity.authorizationEpoch
        || this.requireStore().activeAuthorization({
          hostId: init.hostId,
          hostDeviceId: init.hostDeviceId,
          clientDeviceId: init.clientDeviceId,
          authorizationId: init.authorizationId,
          authorizationEpoch: init.authorizationEpoch,
        }) === undefined
      ) {
        this.closeProtocolViolation(record)
        return true
      }
      const target = this.online.get(hostIdentityKey(init.hostId, init.hostDeviceId))
      if (target !== undefined && this.isCurrent(target)) {
        if (this.canSend(target, bytes.byteLength)) {
          try {
            await this.sendRaw(target, bytes)
            this.log('route.relayed', { role: 'client', outcome: 'relayed', frameBytes: bytes.byteLength })
          } catch {
            this.log('route.unavailable', { role: 'client', outcome: 'unavailable', frameBytes: bytes.byteLength })
          }
        } else {
          this.log('route.backpressure', { role: 'client', outcome: 'backpressure', frameBytes: bytes.byteLength })
        }
      }
      return true
    } catch {
      return false
    }
  }

  private async routeEnvelope(
    record: ConnectionRecord,
    identity: AuthenticatedIdentity,
    envelope: RoutedEnvelope,
    bytes: Uint8Array,
    forcedRejection?: 'rate-limited',
  ): Promise<void> {
    let authorization: R3RelayActiveAuthorizationRecord | undefined
    let targetKey: string
    if (identity.role === 'client') {
      authorization = this.requireStore().activeAuthorization({
        hostId: identity.hostId,
        hostDeviceId: identity.hostDeviceId,
        clientDeviceId: identity.deviceId,
        authorizationId: identity.authorizationId,
        authorizationEpoch: identity.authorizationEpoch,
      })
      if (
        authorization === undefined
        || envelope.hostId !== identity.hostId
        || envelope.fromDeviceId !== identity.deviceId
        || envelope.toDeviceId !== identity.hostDeviceId
      ) {
        this.closeProtocolViolation(record)
        return
      }
      targetKey = hostIdentityKey(identity.hostId, identity.hostDeviceId)
    } else {
      authorization = this.activeAuthorizationForClient(envelope.toDeviceId)
      if (
        authorization === undefined
        || envelope.hostId !== identity.hostId
        || envelope.fromDeviceId !== identity.hostDeviceId
      ) {
        this.closeProtocolViolation(record)
        return
      }
      targetKey = clientIdentityKey(identity.hostId, authorization.clientDeviceId)
    }
    if (forcedRejection === 'rate-limited') {
      this.sendReceipt(record, envelope, 'rate-limited')
      return
    }
    const target = this.online.get(targetKey)
    if (
      identity.role === 'host'
      && target !== undefined
      && !this.clientRecordMatchesAuthorization(target, authorization)
    ) {
      this.rejectAuthentication(target)
      this.sendReceipt(record, envelope, 'unavailable')
      return
    }
    if (target === undefined || !this.isCurrent(target) || target.socket.readyState !== WebSocket.OPEN) {
      this.log('route.unavailable', { role: identity.role, outcome: 'unavailable', frameBytes: bytes.byteLength })
      this.sendReceipt(record, envelope, 'unavailable')
      return
    }
    if (!this.canSend(target, bytes.byteLength)) {
      this.log('route.backpressure', { role: identity.role, outcome: 'backpressure', frameBytes: bytes.byteLength })
      this.sendReceipt(record, envelope, 'backpressure')
      return
    }
    try {
      await this.sendRaw(target, bytes)
    } catch {
      this.sendReceipt(record, envelope, 'unavailable')
      return
    }
    if (!this.isCurrent(record)) return
    this.log('route.relayed', { role: identity.role, outcome: 'relayed', frameBytes: bytes.byteLength })
    this.sendReceipt(record, envelope, 'relayed')
  }

  private sendReceipt(
    record: ConnectionRecord,
    envelope: RoutedEnvelope,
    outcome: 'relayed' | 'unavailable' | 'backpressure' | 'rate-limited',
  ): void {
    const common = {
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt' as const,
      connectionGeneration: envelope.connectionGeneration,
      requestId: envelope.requestId,
      seq: envelope.seq,
    }
    const receipt: RelayReceipt = outcome === 'relayed'
      ? { ...common, state: 'relayed' }
      : outcome === 'unavailable'
        ? { ...common, state: 'unavailable', code: 'host-unavailable' }
        : { ...common, state: 'rejected', code: outcome }
    const frame = encodeRelayReceipt(receipt)
    if (!this.canSend(record, Buffer.byteLength(frame), MAX_RELAY_R3_CONTROL_BYTES)) {
      record.socket.terminate()
      return
    }
    record.socket.send(frame, { binary: false }, error => {
      if (error != null) record.socket.terminate()
    })
  }

  private matchesHost(
    identity: HostIdentity,
    value: { hostId: string; hostDeviceId: string },
  ): boolean {
    return identity.hostId === value.hostId && identity.hostDeviceId === value.hostDeviceId
  }

  private authorizationMatchesHandshake(
    authorization: R3RelayActiveAuthorizationRecord | undefined,
    value: {
      authorizationId: string
      authorizationEpoch: number
      clientDeviceId: string
    },
  ): boolean {
    return authorization !== undefined
      && authorization.authorizationId === value.authorizationId
      && authorization.authorizationEpoch === value.authorizationEpoch
      && authorization.clientDeviceId === value.clientDeviceId
  }

  private clientRecordMatchesAuthorization(
    record: ConnectionRecord,
    authorization: R3RelayActiveAuthorizationRecord | undefined,
  ): boolean {
    const identity = record.identity
    return identity?.role === 'client'
      && authorization !== undefined
      && identity.deviceId === authorization.clientDeviceId
      && identity.authorizationId === authorization.authorizationId
      && identity.authorizationEpoch === authorization.authorizationEpoch
  }

  private activeAuthorizationForClient(
    clientDeviceId: string,
  ): R3RelayActiveAuthorizationRecord | undefined {
    const snapshot = this.requireStore().snapshot()
    const authorization = snapshot?.authorizations.find(candidate => (
      candidate.clientDeviceId === clientDeviceId && candidate.status === 'active'
    ))
    return authorization?.status === 'active'
      ? { ...authorization, clientSigningKey: { ...authorization.clientSigningKey } }
      : undefined
  }

  private invalidateClientAfterAuthorization(update: RelayAuthorizationPut): void {
    const client = this.online.get(clientIdentityKey(update.hostId, update.clientDeviceId))
    const identity = client?.identity
    if (
      client !== undefined
      && identity?.role === 'client'
      && (
        update.status === 'revoked'
        || identity.authorizationId !== update.authorizationId
        || identity.authorizationEpoch !== update.authorizationEpoch
      )
    ) {
      const key = clientIdentityKey(update.hostId, update.clientDeviceId)
      if (this.online.get(key) === client) this.online.delete(key)
      this.rejectAuthentication(client)
    }
  }

  private consumeRate(
    record: ConnectionRecord,
    frameBytes: number,
  ): { allowed: boolean; closeAfterSend: boolean } {
    const now = this.safeNow()
    if (now < record.rate.startedAt || now - record.rate.startedAt >= this.rateLimitWindowMs) {
      record.rate = { startedAt: now, frames: 0, bytes: 0, violations: 0 }
    }
    if (
      record.rate.frames + 1 > this.maxFramesPerWindow
      || record.rate.bytes + frameBytes > this.maxBytesPerWindow
    ) {
      record.rate.violations += 1
      this.log('route.rate_limited', {
        role: record.identity?.role,
        outcome: 'rate-limited',
        frameBytes,
      })
      return {
        allowed: false,
        closeAfterSend: record.rate.violations >= this.maxRateLimitViolations,
      }
    }
    record.rate.frames += 1
    record.rate.bytes += frameBytes
    return { allowed: true, closeAfterSend: false }
  }

  private canSend(record: ConnectionRecord, frameBytes: number, floor = 0): boolean {
    return !record.closing
      && record.socket.readyState === WebSocket.OPEN
      && record.socket.bufferedAmount + frameBytes <= Math.max(this.maxOutboundBufferedBytes, floor)
  }

  private async sendRaw(record: ConnectionRecord, value: string | Uint8Array): Promise<void> {
    const frameBytes = typeof value === 'string' ? Buffer.byteLength(value) : value.byteLength
    if (!this.canSend(record, frameBytes)) throw new Error('R3 Relay send unavailable.')
    await new Promise<void>((resolve, reject) => {
      record.socket.send(value, { binary: false }, error => {
        if (error == null) resolve()
        else reject(new Error('R3 Relay send unavailable.'))
      })
    })
  }

  private async sendControl(record: ConnectionRecord, value: string): Promise<void> {
    const frameBytes = Buffer.byteLength(value)
    if (!this.canSend(record, frameBytes, MAX_RELAY_R3_CONTROL_BYTES)) {
      throw new Error('R3 Relay control send unavailable.')
    }
    await new Promise<void>((resolve, reject) => {
      record.socket.send(value, { binary: false }, error => {
        if (error == null) resolve()
        else reject(new Error('R3 Relay control send unavailable.'))
      })
    })
  }

  private rejectAuthentication(record: ConnectionRecord): void {
    if (record.closing) return
    record.pendingChallenge = undefined
    this.discardInboundQueue(record)
    record.closing = true
    this.armTermination(record)
    if (record.socket.readyState !== WebSocket.OPEN) {
      record.socket.terminate()
      return
    }
    const frame = encodeRelayNotAuthenticated()
    record.socket.send(frame, { binary: false }, () => {
      if (record.socket.readyState === WebSocket.OPEN) {
        record.socket.close(R3_RELAY_CLOSE.notAuthenticated, CLOSE_REASON.notAuthenticated)
      }
    })
  }

  private closeProtocolViolation(record: ConnectionRecord): void {
    if (!record.closing) {
      this.beginClose(record, R3_RELAY_CLOSE.protocolViolation, CLOSE_REASON.protocolViolation)
    }
  }

  private destroyPairSession(session: PairSession, notifyAttempts: boolean): void {
    if (this.pairSessions.get(session.pairSessionId) !== session) return
    this.pairSessions.delete(session.pairSessionId)
    this.pairingCodes?.revoke(session.pairSessionId)
    clearTimeout(session.expiryTimer)
    for (const attempt of session.attempts.values()) {
      if (!notifyAttempts || attempt.connection.socket.readyState === WebSocket.CLOSED) continue
      if (attempt === session.claimed && session.resultSent) {
        this.beginClose(attempt.connection, 1000, CLOSE_REASON.pairComplete)
      } else {
        this.rejectAuthentication(attempt.connection)
      }
    }
    session.attempts.clear()
    session.claimed = undefined
  }

  private connectionClosed(record: ConnectionRecord, code: number): void {
    clearTimeout(record.authTimer)
    if (record.terminationTimer !== undefined) clearTimeout(record.terminationTimer)
    this.discardInboundQueue(record)
    this.connections.delete(record)
    if (record.identity !== undefined) {
      const key = identityKey(record.identity)
      if (this.online.get(key) === record) this.online.delete(key)
      if (record.identity.role === 'host') {
        for (const session of [...this.pairSessions.values()]) {
          if (session.host === record) this.destroyPairSession(session, true)
        }
      }
    }
    if (record.pairAttempt !== undefined) {
      const session = this.pairSessions.get(record.pairAttempt.pairSessionId)
      const attempt = session?.attempts.get(record.pairAttempt.joinId)
      if (attempt?.connection === record) {
        session?.attempts.delete(record.pairAttempt.joinId)
        if (session?.claimed === attempt) this.destroyPairSession(session, true)
      }
    }
    this.log('connection.closed', {
      role: record.identity?.role,
      outcome: 'closed',
      closeCode: code,
    })
  }

  private isCurrent(record: ConnectionRecord): boolean {
    return record.identity !== undefined && this.online.get(identityKey(record.identity)) === record
  }

  private beginClose(record: ConnectionRecord, code: number, reason: string): void {
    if (record.closing) return
    this.discardInboundQueue(record)
    record.closing = true
    this.armTermination(record)
    if (record.socket.readyState === WebSocket.OPEN) record.socket.close(code, reason)
    else if (record.socket.readyState !== WebSocket.CLOSED) record.socket.terminate()
  }

  private armTermination(record: ConnectionRecord): void {
    if (record.terminationTimer !== undefined) return
    record.terminationTimer = setTimeout(() => {
      if (record.socket.readyState !== WebSocket.CLOSED) record.socket.terminate()
    }, 1_000)
    record.terminationTimer.unref()
  }

  private requireStore(): R3RelayStateStore {
    if (this.stateStore === undefined || this.shuttingDown) {
      throw new Error('R3 Relay state is unavailable.')
    }
    return this.stateStore
  }

  private isTrustedProductionProxyRequest(request: IncomingMessage): boolean {
    if (
      this.mode !== 'production'
      || this.publicHost === undefined
      || this.trustedProxyIps === undefined
    ) return false
    const remoteAddress = request.socket.remoteAddress
    const remoteIp = remoteAddress === undefined ? undefined : normalizeIpLiteral(remoteAddress)
    return remoteIp !== undefined
      && this.trustedProxyIps.has(remoteIp)
      && request.headers.host === this.publicHost
      && request.headers['x-forwarded-proto'] === 'https'
      && request.headers['x-forwarded-host'] === this.publicHost
  }

  private safeNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('R3 Relay clock is invalid.')
    }
    return value
  }

  private log(event: RelayLogEventName, fields: LogFields = {}): void {
    if (this.logger === undefined) return
    const entry: RelayLogEntry = {
      timestamp: this.safeNow(),
      event,
      connectionCount: this.online.size,
      ...(fields.role === undefined ? {} : { role: fields.role }),
      ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
      ...(fields.frameBytes === undefined ? {} : { frameBytes: fields.frameBytes }),
      ...(fields.closeCode === undefined ? {} : { closeCode: fields.closeCode }),
    }
    try {
      this.logger(entry)
    } catch {
      // Logging cannot affect routing or expose the thrown object.
    }
  }
}

export function createR3LocalTestRelayServer(
  options: R3RelayServerOptions,
): R3LocalTestRelayServer {
  if ((options as { mode?: unknown }).mode !== 'r3-local-test') {
    throw new Error('R3 Relay requires explicit r3-local-test mode.')
  }
  return new R3RelayServer(options)
}

export function createR3ProductionRelayServer(
  options: R3ProductionRelayServerOptions,
): R3ProductionRelayServer {
  if ((options as { mode?: unknown }).mode !== 'production') {
    throw new Error('Production R3 Relay requires explicit production mode.')
  }
  return new R3RelayServer(options)
}
