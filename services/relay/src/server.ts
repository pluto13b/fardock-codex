import { createServer, type Server as HttpServer } from 'node:http'
import { isAbsolute } from 'node:path'
import type { AddressInfo, Socket } from 'node:net'

import {
  decodeEnvelope,
  decodeRelayHello,
  encodeRelayNotAuthenticated,
  encodeRelayReceipt,
  encodeRelayWelcome,
  MAX_FRAME_BYTES,
  MAX_RELAY_CONTROL_BYTES,
  OpaqueIdentifierSchema,
  PROTOCOL_VERSION,
  RelayCredentialSchema,
  type RelayHello,
  type RelayReceipt,
  type RelayRole,
} from '@codex-plus/protocol'
import WebSocket, { WebSocketServer, type RawData } from 'ws'

import type { RelayLogEntry, RelayLogEventName, RelayLogger } from './logging.ts'
import {
  createRelayState,
  credentialMatches,
  digestCredential,
  loadRelayState,
  type RegisteredHostState,
} from './state.ts'

export const RELAY_CLOSE = {
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
} as const

const MAX_SEEDED_CLIENTS = 128
const MAX_ALLOWED_ORIGINS = 16
const MAX_RATE_FRAMES = 10_000
const MAX_RATE_BYTES = 64 * MAX_FRAME_BYTES
const MAX_RATE_VIOLATIONS = 16
const MAX_BUFFERED_BYTES = 16 * MAX_FRAME_BYTES

export interface SeededRelayClient {
  hostId: string
  deviceId: string
  credential: string
}

export interface RelayServerOptions {
  mode: 'r2-local-test'
  stateFile: string
  bootstrapCredential: string
  seededClients?: readonly SeededRelayClient[]
  allowedOrigins?: readonly string[]
  heartbeatIntervalMs?: number
  helloTimeoutMs?: number
  rateLimitWindowMs?: number
  maxFramesPerWindow?: number
  maxBytesPerWindow?: number
  maxRateLimitViolations?: number
  maxOutboundBufferedBytes?: number
  maxConnections?: number
  now?: () => number
  logger?: RelayLogger
}

export interface RelayListenOptions {
  host: '127.0.0.1' | '::1'
  port?: number
}

export interface RelayAddress {
  host: '127.0.0.1' | '::1'
  port: number
  httpOrigin: string
  webSocketUrl: string
}

interface Identity {
  role: RelayRole
  hostId: string
  deviceId: string
}

interface ConnectionRecord {
  socket: WebSocket
  origin?: string
  authenticated: boolean
  authInProgress: boolean
  closing: boolean
  isAlive: boolean
  identity?: Identity
  helloTimer: NodeJS.Timeout
  terminationTimer?: NodeJS.Timeout
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

function requirePositiveInteger(name: string, value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid Relay numeric option: ${name}.`)
  }
  return value
}

function identityKey(hostId: string, deviceId: string): string {
  return `${hostId}\u0000${deviceId}`
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return data
}

function originIsLoopback(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.origin === value
      && (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      && url.username === ''
      && url.password === ''
    )
  } catch {
    return false
  }
}

function rejectUpgrade(socket: import('node:stream').Duplex, status: '404 Not Found' | '403 Forbidden' | '503 Service Unavailable'): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

export class LocalTestRelayServer {
  private readonly stateFile: string
  private readonly bootstrapDigest: string
  private readonly seededClients = new Map<string, string>()
  private readonly seededClientIdentities = new Map<string, Identity>()
  private readonly allowedOrigins: ReadonlySet<string>
  private readonly heartbeatIntervalMs: number
  private readonly helloTimeoutMs: number
  private readonly rateLimitWindowMs: number
  private readonly maxFramesPerWindow: number
  private readonly maxBytesPerWindow: number
  private readonly maxRateLimitViolations: number
  private readonly maxOutboundBufferedBytes: number
  private readonly maxConnections: number
  private readonly now: () => number
  private readonly logger?: RelayLogger
  private readonly webSocketServer: WebSocketServer
  private readonly connections = new Set<ConnectionRecord>()
  private readonly online = new Map<string, ConnectionRecord>()
  private readonly rateWindows = new Map<string, RateWindow>()
  private readonly tcpSockets = new Set<Socket>()
  private readonly activeOperations = new Set<Promise<void>>()
  private httpServer?: HttpServer
  private registeredHost?: RegisteredHostState
  private heartbeatTimer?: NodeJS.Timeout
  private address?: RelayAddress
  private shuttingDown = false
  private lifecycle: 'idle' | 'starting' | 'listening' | 'closing' | 'closed' = 'idle'
  private listenPromise?: Promise<RelayAddress>
  private closePromise?: Promise<void>

  constructor(options: RelayServerOptions) {
    if (options.mode !== 'r2-local-test') throw new Error('Relay requires explicit r2-local-test mode.')
    if (!isAbsolute(options.stateFile)) throw new Error('Relay stateFile must be absolute.')
    if (!RelayCredentialSchema.safeParse(options.bootstrapCredential).success) {
      throw new Error('Relay bootstrap credential is invalid.')
    }
    this.stateFile = options.stateFile
    this.bootstrapDigest = digestCredential(options.bootstrapCredential)
    this.heartbeatIntervalMs = requirePositiveInteger('heartbeatIntervalMs', options.heartbeatIntervalMs ?? 30_000, 60_000)
    this.helloTimeoutMs = requirePositiveInteger('helloTimeoutMs', options.helloTimeoutMs ?? 5_000, 60_000)
    this.rateLimitWindowMs = requirePositiveInteger('rateLimitWindowMs', options.rateLimitWindowMs ?? 10_000, 3_600_000)
    this.maxFramesPerWindow = requirePositiveInteger('maxFramesPerWindow', options.maxFramesPerWindow ?? 120, MAX_RATE_FRAMES)
    this.maxBytesPerWindow = requirePositiveInteger('maxBytesPerWindow', options.maxBytesPerWindow ?? 8 * MAX_FRAME_BYTES, MAX_RATE_BYTES)
    this.maxRateLimitViolations = requirePositiveInteger('maxRateLimitViolations', options.maxRateLimitViolations ?? 2, MAX_RATE_VIOLATIONS)
    this.maxOutboundBufferedBytes = requirePositiveInteger('maxOutboundBufferedBytes', options.maxOutboundBufferedBytes ?? 1024 * 1024, MAX_BUFFERED_BYTES)
    this.maxConnections = requirePositiveInteger('maxConnections', options.maxConnections ?? 16, 128)
    this.now = options.now ?? Date.now
    this.logger = options.logger

    const origins = options.allowedOrigins ?? []
    if (
      origins.length > MAX_ALLOWED_ORIGINS
      || origins.some(origin => !originIsLoopback(origin))
      || new Set(origins).size !== origins.length
    ) {
      throw new Error('Relay allowedOrigins must contain unique numeric loopback origins.')
    }
    this.allowedOrigins = new Set(origins)

    const seededClients = options.seededClients ?? []
    if (seededClients.length > MAX_SEEDED_CLIENTS) throw new Error('Relay seeded client limit exceeded.')
    for (const client of seededClients) {
      if (
        !OpaqueIdentifierSchema.safeParse(client.hostId).success
        || !OpaqueIdentifierSchema.safeParse(client.deviceId).success
        || !RelayCredentialSchema.safeParse(client.credential).success
      ) {
        throw new Error('Relay seeded client is invalid.')
      }
      const key = identityKey(client.hostId, client.deviceId)
      if (this.seededClients.has(key)) throw new Error('Relay seeded client identity is duplicated.')
      const digest = digestCredential(client.credential)
      if (digest === this.bootstrapDigest || [...this.seededClients.values()].includes(digest)) {
        throw new Error('Relay credentials must be unique per authority.')
      }
      this.seededClients.set(key, digest)
      this.seededClientIdentities.set(key, { role: 'client', hostId: client.hostId, deviceId: client.deviceId })
    }
    if (this.seededClients.size > 0 && this.allowedOrigins.size === 0) {
      throw new Error('Relay test clients require an explicit loopback Origin allowlist.')
    }

    this.webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    })
  }

  listen(options: RelayListenOptions): Promise<RelayAddress> {
    if (this.lifecycle !== 'idle') return Promise.reject(new Error('Relay listen may only be called once.'))
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

  private async startListening(options: RelayListenOptions): Promise<RelayAddress> {
    if (options.host !== '127.0.0.1' && options.host !== '::1') throw new Error('Relay must bind a numeric loopback address.')
    const port = options.port ?? 0
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('Relay port is invalid.')

    const registeredHost = await loadRelayState(this.stateFile)
    if (this.shuttingDown) throw new Error('Relay start was cancelled.')
    if (
      registeredHost !== undefined
      && (
        this.seededClients.has(identityKey(registeredHost.hostId, registeredHost.deviceId))
        || [...this.seededClients.values()].includes(registeredHost.sessionCredentialDigest)
        || registeredHost.sessionCredentialDigest === this.bootstrapDigest
      )
    ) {
      throw new Error('Relay persisted authority conflicts with configured test authority.')
    }
    this.registeredHost = registeredHost

    const server = createServer({ maxHeaderSize: 8 * 1024 }, (request, response) => {
      if (this.shuttingDown) {
        response.writeHead(503, { connection: 'close', 'content-length': '0' })
        response.end()
        return
      }
      if (request.method === 'GET' && request.url === '/healthz') {
        const body = '{"status":"ok","mode":"r2-local-test","insecure":true}'
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
        })
        response.end(body)
        return
      }
      response.writeHead(404, { 'content-length': '0', 'x-content-type-options': 'nosniff' })
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
      if (request.url !== '/api/ws') {
        rejectUpgrade(socket, '404 Not Found')
        return
      }
      const origin = request.headers.origin
      if (origin !== undefined && !this.allowedOrigins.has(origin)) {
        rejectUpgrade(socket, '403 Forbidden')
        return
      }
      if (this.connections.size >= this.maxConnections) {
        rejectUpgrade(socket, '503 Service Unavailable')
        return
      }
      this.webSocketServer.handleUpgrade(request, socket, head, webSocket => {
        this.acceptConnection(webSocket, origin)
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
      if (actual === null || typeof actual === 'string') throw new Error('Relay listener did not expose a numeric address.')
      const address = actual as AddressInfo
      if (address.address !== options.host) throw new Error('Relay listener escaped the requested loopback address.')
      if (this.shuttingDown) {
        for (const socket of this.tcpSockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => resolve()))
        throw new Error('Relay start was cancelled.')
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
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
      throw error
    }
  }

  getAddress(): RelayAddress | undefined {
    return this.address
  }

  sweepHeartbeats(): void {
    for (const record of this.connections) {
      if (!record.authenticated) continue
      if (record.closing) continue
      if (!this.isCurrent(record)) {
        this.beginClose(record, RELAY_CLOSE.replaced, CLOSE_REASON.replaced)
        continue
      }
      if (!record.isAlive) {
        this.log('heartbeat.terminated', {
          role: record.identity?.role,
          outcome: 'terminated',
          closeCode: RELAY_CLOSE.heartbeatTimeout,
        })
        this.beginClose(record, RELAY_CLOSE.heartbeatTimeout, CLOSE_REASON.heartbeatTimeout)
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
    if (this.listenPromise !== undefined) {
      await this.listenPromise.catch(() => undefined)
    }
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    const server = this.httpServer
    this.httpServer = undefined
    this.address = undefined
    for (const record of this.connections) {
      clearTimeout(record.helloTimer)
      if (record.terminationTimer !== undefined) clearTimeout(record.terminationTimer)
      if (record.socket.readyState === WebSocket.OPEN || record.socket.readyState === WebSocket.CONNECTING) {
        record.socket.close(RELAY_CLOSE.serviceRestart, CLOSE_REASON.serviceRestart)
      }
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const record of this.connections) {
      if (record.socket.readyState !== WebSocket.CLOSED) record.socket.terminate()
    }
    for (const socket of this.tcpSockets) socket.destroy()
    await Promise.allSettled([...this.activeOperations])
    if (server !== undefined) {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    this.online.clear()
    this.connections.clear()
    this.tcpSockets.clear()
    this.lifecycle = 'closed'
    this.log('relay.stopped')
  }

  private acceptConnection(socket: WebSocket, origin: string | undefined): void {
    const record: ConnectionRecord = {
      socket,
      ...(origin === undefined ? {} : { origin }),
      authenticated: false,
      authInProgress: false,
      closing: false,
      isAlive: true,
      helloTimer: setTimeout(() => this.rejectAuthentication(record), this.helloTimeoutMs),
    }
    record.helloTimer.unref()
    this.connections.add(record)

    socket.on('pong', () => {
      record.isAlive = true
    })
    socket.on('message', (data, isBinary) => {
      const operation = this.handleMessage(record, data, isBinary).catch(() => {
        if (record.authenticated) this.closeProtocolViolation(record)
        else this.rejectAuthentication(record)
      })
      this.activeOperations.add(operation)
      void operation.then(() => this.activeOperations.delete(operation))
    })
    socket.on('close', code => this.connectionClosed(record, code))
    socket.on('error', () => {
      // The close handler performs bounded cleanup; error details are deliberately not logged.
    })
  }

  private async handleMessage(record: ConnectionRecord, data: RawData, isBinary: boolean): Promise<void> {
    if (this.shuttingDown) {
      record.socket.terminate()
      return
    }
    if (record.closing) return
    if (record.socket.readyState !== WebSocket.OPEN) return
    const bytes = rawDataBytes(data)
    if (!record.authenticated) {
      if (record.authInProgress || isBinary || bytes.byteLength > MAX_RELAY_CONTROL_BYTES) {
        this.rejectAuthentication(record)
        return
      }
      record.authInProgress = true
      await this.authenticate(record, bytes)
      return
    }
    if (isBinary || !this.isCurrent(record)) {
      this.closeProtocolViolation(record)
      return
    }
    this.routeEnvelope(record, bytes)
  }

  private async authenticate(record: ConnectionRecord, bytes: Uint8Array): Promise<void> {
    let hello: RelayHello
    try {
      hello = decodeRelayHello(bytes)
    } catch {
      this.rejectAuthentication(record)
      return
    }
    if (hello.role === 'client' && record.origin === undefined) {
      this.rejectAuthentication(record)
      return
    }

    if (hello.authMode === 'bootstrap') {
      const bootstrapMatches = credentialMatches(hello.credential, this.bootstrapDigest)
      const sessionDigest = digestCredential(hello.sessionCredential)
      if (
        this.registeredHost !== undefined
        || !bootstrapMatches
        || sessionDigest === this.bootstrapDigest
        || [...this.seededClients.values()].includes(sessionDigest)
        || this.seededClients.has(identityKey(hello.hostId, hello.deviceId))
      ) {
        this.rejectAuthentication(record)
        return
      }
      const state: RegisteredHostState = {
        stateVersion: 1,
        registrationClosed: true,
        hostId: hello.hostId,
        deviceId: hello.deviceId,
        sessionCredentialDigest: sessionDigest,
      }
      try {
        await createRelayState(this.stateFile, state)
      } catch {
        this.rejectAuthentication(record)
        return
      }
      this.registeredHost = state
      this.finishAuthentication(record, hello)
      return
    }

    if (hello.role === 'host') {
      const state = this.registeredHost
      const credentialMatchesState = credentialMatches(hello.credential, state?.sessionCredentialDigest ?? '')
      if (
        state === undefined
        || state.hostId !== hello.hostId
        || state.deviceId !== hello.deviceId
        || !credentialMatchesState
      ) {
        this.rejectAuthentication(record)
        return
      }
      this.finishAuthentication(record, hello)
      return
    }

    const key = identityKey(hello.hostId, hello.deviceId)
    const digest = this.seededClients.get(key)
    const credentialMatchesState = credentialMatches(hello.credential, digest ?? '')
    if (
      this.registeredHost === undefined
      || this.registeredHost.hostId !== hello.hostId
      || digest === undefined
      || !credentialMatchesState
    ) {
      this.rejectAuthentication(record)
      return
    }
    this.finishAuthentication(record, hello)
  }

  private finishAuthentication(record: ConnectionRecord, hello: RelayHello): void {
    if (this.shuttingDown || record.closing || record.socket.readyState !== WebSocket.OPEN) return
    const identity: Identity = { role: hello.role, hostId: hello.hostId, deviceId: hello.deviceId }
    const welcome = encodeRelayWelcome({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'welcome',
      role: hello.role,
      hostId: hello.hostId,
      deviceId: hello.deviceId,
      authMode: hello.authMode,
      registrationState: 'closed',
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      maxFrameBytes: MAX_FRAME_BYTES,
    })
    record.socket.send(welcome, { binary: false }, error => {
      if (
        this.shuttingDown
        || record.closing
        || !record.authInProgress
        || error != null
        || record.socket.readyState !== WebSocket.OPEN
      ) {
        record.socket.terminate()
        return
      }
      clearTimeout(record.helloTimer)
      record.identity = identity
      record.authenticated = true
      record.authInProgress = false
      record.isAlive = true
      const key = identityKey(identity.hostId, identity.deviceId)
      const previous = this.online.get(key)
      this.online.set(key, record)
      if (previous !== undefined && previous !== record) {
        this.beginClose(previous, RELAY_CLOSE.replaced, CLOSE_REASON.replaced)
      }
      this.log('connection.authenticated', { role: identity.role, outcome: 'authenticated' })
    })
  }

  private routeEnvelope(record: ConnectionRecord, bytes: Uint8Array): void {
    const identity = record.identity
    if (identity === undefined || !this.isCurrent(record)) {
      this.closeProtocolViolation(record)
      return
    }
    const rate = this.consumeRate(identity, bytes.byteLength)
    let envelope
    try {
      envelope = decodeEnvelope(bytes, { now: this.now() })
    } catch {
      this.closeProtocolViolation(record)
      return
    }
    if (envelope.hostId !== identity.hostId || envelope.fromDeviceId !== identity.deviceId) {
      this.closeProtocolViolation(record)
      return
    }

    const targetIdentity = this.authorizedIdentity(envelope.hostId, envelope.toDeviceId)
    if (targetIdentity === undefined || targetIdentity.role === identity.role) {
      this.closeProtocolViolation(record)
      return
    }

    if (!rate.allowed) {
      const receipt: RelayReceipt = {
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'receipt',
        connectionGeneration: envelope.connectionGeneration,
        requestId: envelope.requestId,
        seq: envelope.seq,
        state: 'rejected',
        code: 'rate-limited',
      }
      this.log('route.rate_limited', { role: identity.role, outcome: 'rate-limited', frameBytes: bytes.byteLength })
      this.sendReceipt(record, receipt, rate.closeAfterSend ? () => {
        this.beginClose(record, RELAY_CLOSE.rateLimited, CLOSE_REASON.rateLimited)
      } : undefined)
      return
    }

    const target = this.online.get(identityKey(targetIdentity.hostId, targetIdentity.deviceId))
    if (target === undefined || !this.isCurrent(target) || target.socket.readyState !== WebSocket.OPEN) {
      const receipt: RelayReceipt = {
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'receipt',
        connectionGeneration: envelope.connectionGeneration,
        requestId: envelope.requestId,
        seq: envelope.seq,
        state: 'unavailable',
        code: 'host-unavailable',
      }
      this.log('route.unavailable', { role: identity.role, outcome: 'unavailable', frameBytes: bytes.byteLength })
      this.sendReceipt(record, receipt)
      return
    }

    if (target.socket.bufferedAmount + bytes.byteLength > this.maxOutboundBufferedBytes) {
      const receipt: RelayReceipt = {
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'receipt',
        connectionGeneration: envelope.connectionGeneration,
        requestId: envelope.requestId,
        seq: envelope.seq,
        state: 'rejected',
        code: 'backpressure',
      }
      this.log('route.backpressure', { role: identity.role, outcome: 'backpressure', frameBytes: bytes.byteLength })
      this.sendReceipt(record, receipt)
      return
    }

    target.socket.send(bytes, { binary: false }, error => {
      if (error != null || !this.isCurrent(record)) {
        if (this.isCurrent(record)) {
          this.sendReceipt(record, {
            protocolVersion: PROTOCOL_VERSION,
            relayType: 'receipt',
            connectionGeneration: envelope.connectionGeneration,
            requestId: envelope.requestId,
            seq: envelope.seq,
            state: 'unavailable',
            code: 'host-unavailable',
          })
        }
        return
      }
      this.log('route.relayed', { role: identity.role, outcome: 'relayed', frameBytes: bytes.byteLength })
      this.sendReceipt(record, {
        protocolVersion: PROTOCOL_VERSION,
        relayType: 'receipt',
        connectionGeneration: envelope.connectionGeneration,
        requestId: envelope.requestId,
        seq: envelope.seq,
        state: 'relayed',
      })
    })
  }

  private consumeRate(identity: Identity, frameBytes: number): { allowed: boolean; closeAfterSend: boolean } {
    const key = identityKey(identity.hostId, identity.deviceId)
    const now = this.now()
    let window = this.rateWindows.get(key)
    if (window === undefined || now - window.startedAt >= this.rateLimitWindowMs || now < window.startedAt) {
      window = { startedAt: now, frames: 0, bytes: 0, violations: 0 }
      this.rateWindows.set(key, window)
    }
    if (window.frames + 1 > this.maxFramesPerWindow || window.bytes + frameBytes > this.maxBytesPerWindow) {
      window.violations += 1
      return { allowed: false, closeAfterSend: window.violations >= this.maxRateLimitViolations }
    }
    window.frames += 1
    window.bytes += frameBytes
    return { allowed: true, closeAfterSend: false }
  }

  private authorizedIdentity(hostId: string, deviceId: string): Identity | undefined {
    const state = this.registeredHost
    if (state !== undefined && state.hostId === hostId && state.deviceId === deviceId) {
      return { role: 'host', hostId, deviceId }
    }
    return this.seededClientIdentities.get(identityKey(hostId, deviceId))
  }

  private sendReceipt(record: ConnectionRecord, receipt: RelayReceipt, afterSend?: () => void): void {
    if (!this.isCurrent(record) || record.socket.readyState !== WebSocket.OPEN) return
    const frame = encodeRelayReceipt(receipt)
    const receiptBufferLimit = Math.max(this.maxOutboundBufferedBytes, MAX_RELAY_CONTROL_BYTES)
    if (record.socket.bufferedAmount + Buffer.byteLength(frame) > receiptBufferLimit) {
      record.socket.terminate()
      return
    }
    record.socket.send(frame, { binary: false }, error => {
      if (error != null) record.socket.terminate()
      else afterSend?.()
    })
  }

  private rejectAuthentication(record: ConnectionRecord): void {
    if (record.closing) return
    record.closing = true
    this.armTermination(record)
    if (record.socket.readyState !== WebSocket.OPEN) {
      record.socket.terminate()
      return
    }
    record.authInProgress = true
    const frame = encodeRelayNotAuthenticated()
    record.socket.send(frame, { binary: false }, () => {
      if (record.socket.readyState === WebSocket.OPEN) {
        record.socket.close(RELAY_CLOSE.notAuthenticated, CLOSE_REASON.notAuthenticated)
      }
    })
  }

  private closeProtocolViolation(record: ConnectionRecord): void {
    if (record.closing) return
    this.beginClose(record, RELAY_CLOSE.protocolViolation, CLOSE_REASON.protocolViolation)
  }

  private connectionClosed(record: ConnectionRecord, code: number): void {
    clearTimeout(record.helloTimer)
    if (record.terminationTimer !== undefined) clearTimeout(record.terminationTimer)
    this.connections.delete(record)
    const identity = record.identity
    if (identity !== undefined) {
      const key = identityKey(identity.hostId, identity.deviceId)
      if (this.online.get(key) === record) this.online.delete(key)
    }
    this.log('connection.closed', {
      role: identity?.role,
      outcome: 'closed',
      closeCode: code,
    })
  }

  private isCurrent(record: ConnectionRecord): boolean {
    const identity = record.identity
    return identity !== undefined && this.online.get(identityKey(identity.hostId, identity.deviceId)) === record
  }

  private beginClose(record: ConnectionRecord, code: number, reason: string): void {
    record.closing = true
    this.armTermination(record)
    if (record.socket.readyState === WebSocket.OPEN) {
      record.socket.close(code, reason)
    } else if (record.socket.readyState !== WebSocket.CLOSED) {
      record.socket.terminate()
    }
  }

  private armTermination(record: ConnectionRecord): void {
    if (record.terminationTimer !== undefined) return
    record.terminationTimer = setTimeout(() => {
      if (record.socket.readyState !== WebSocket.CLOSED) record.socket.terminate()
    }, 1_000)
    record.terminationTimer.unref()
  }

  private log(event: RelayLogEventName, fields: LogFields = {}): void {
    if (this.logger === undefined) return
    const entry: RelayLogEntry = {
      timestamp: this.now(),
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

export function createLocalTestRelayServer(options: RelayServerOptions): LocalTestRelayServer {
  return new LocalTestRelayServer(options)
}
