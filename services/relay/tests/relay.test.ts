import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeEnvelope,
  decodeRelayNotAuthenticated,
  decodeRelayReceipt,
  decodeRelayWelcome,
  encodeBase64Url,
  encodeEnvelope,
  encodeRelayHello,
  encodeRelayNotAuthenticated,
  EnvelopeSequenceGuard,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolViolation,
  type RelayHello,
  type RelayReceipt,
  type RoutedEnvelope,
} from '@codex-plus/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { type ClientOptions, type RawData } from 'ws'

import {
  createLocalTestRelayServer,
  RELAY_CLOSE,
  type LocalTestRelayServer,
  type RelayLogEntry,
  type RelayServerOptions,
} from '../src/index.ts'
import { digestCredential } from '../src/state.ts'

const sharedTestRoot = fileURLToPath(new URL('../../../.tmp/relay-tests/', import.meta.url))
const testRoot = join(sharedTestRoot, `server-${process.pid}-${randomUUID()}`)
const browserOrigin = 'http://127.0.0.1:41730'
const fixedNow = 1_800_000_000_000
const bootstrapCredential = credential(1)
const hostSessionCredential = credential(2)
const clientCredential = credential(3)
const wrongCredential = credential(4)

const hostId = 'host-main'
const hostDeviceId = 'device-host'
const clientDeviceId = 'device-web'

const servers = new Set<LocalTestRelayServer>()
const peers = new Set<TestPeer>()
let stateCounter = 0

interface ReceivedFrame {
  bytes: Buffer
  isBinary: boolean
}

interface CloseFrame {
  code: number
  reason: string
}

function credential(fill: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(fill))
}

function asBuffer(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

class TestPeer {
  readonly socket: WebSocket
  private readonly frames: ReceivedFrame[] = []
  private readonly frameWaiters: Array<{
    resolve: (frame: ReceivedFrame) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []
  private closeFrame?: CloseFrame
  private readonly closeWaiters: Array<(frame: CloseFrame) => void> = []

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data, isBinary) => {
      const frame = { bytes: asBuffer(data), isBinary }
      const waiter = this.frameWaiters.shift()
      if (waiter === undefined) {
        this.frames.push(frame)
      } else {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    })
    socket.on('close', (code, reason) => {
      this.closeFrame = { code, reason: reason.toString('utf8') }
      for (const resolve of this.closeWaiters.splice(0)) resolve(this.closeFrame)
    })
    socket.on('error', () => {
      // Tests assert protocol-visible frames and close codes, never raw socket errors.
    })
  }

  async nextFrame(timeoutMs = 2_000): Promise<ReceivedFrame> {
    const queued = this.frames.shift()
    if (queued !== undefined) return queued

    return await new Promise<ReceivedFrame>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.frameWaiters.indexOf(waiter)
          if (index >= 0) this.frameWaiters.splice(index, 1)
          reject(new Error('Timed out waiting for WebSocket frame.'))
        }, timeoutMs),
      }
      this.frameWaiters.push(waiter)
    })
  }

  async nextText(timeoutMs = 2_000): Promise<string> {
    const frame = await this.nextFrame(timeoutMs)
    expect(frame.isBinary).toBe(false)
    return frame.bytes.toString('utf8')
  }

  async waitForClose(timeoutMs = 2_000): Promise<CloseFrame> {
    if (this.closeFrame !== undefined) return this.closeFrame
    return await new Promise<CloseFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close.')), timeoutMs)
      this.closeWaiters.push(frame => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  async expectNoFrame(durationMs = 100): Promise<void> {
    if (this.frames.length > 0) throw new Error('Unexpected queued WebSocket frame.')
    await new Promise<void>((resolve, reject) => {
      const onMessage = () => {
        clearTimeout(timer)
        reject(new Error('Unexpected WebSocket frame.'))
      }
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage)
        resolve()
      }, durationMs)
      this.socket.once('message', onMessage)
    })
  }

  send(frame: string | Buffer, binary = false): void {
    this.socket.send(frame, { binary })
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.socket.terminate()
      return
    }
    const closed = this.waitForClose()
    this.socket.close(1000, 'test-complete')
    await closed
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }
}

function nextStatePath(label: string): string {
  stateCounter += 1
  return join(testRoot, `${stateCounter}-${label}`, 'state.json')
}

async function startRelay(
  overrides: Partial<RelayServerOptions> = {},
): Promise<{ server: LocalTestRelayServer; stateFile: string; httpOrigin: string; webSocketUrl: string }> {
  const stateFile = overrides.stateFile ?? nextStatePath('relay')
  const server = createLocalTestRelayServer({
    mode: 'r2-local-test',
    stateFile,
    bootstrapCredential,
    allowedOrigins: [browserOrigin],
    now: () => fixedNow,
    ...overrides,
  })
  servers.add(server)
  const address = await server.listen({ host: '127.0.0.1' })
  return { server, stateFile, httpOrigin: address.httpOrigin, webSocketUrl: address.webSocketUrl }
}

async function stopRelay(server: LocalTestRelayServer): Promise<void> {
  servers.delete(server)
  await server.close()
}

async function connect(
  url: string,
  options: ClientOptions = {},
): Promise<TestPeer> {
  const socket = new WebSocket(url, options)
  const peer = new TestPeer(socket)
  peers.add(peer)
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off('error', onError)
      resolve()
    }
    const onError = () => {
      socket.off('open', onOpen)
      reject(new Error('WebSocket connection failed.'))
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
  return peer
}

async function rejectedUpgrade(url: string, expectedStatus: number, options: ClientOptions = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.on('error', () => {
      // The HTTP status is the asserted, stable failure surface.
    })
    socket.once('open', () => {
      socket.terminate()
      reject(new Error('WebSocket upgrade unexpectedly succeeded.'))
    })
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      if (status === expectedStatus) resolve()
      else reject(new Error(`Expected HTTP ${expectedStatus}, received ${status ?? 'unknown'}.`))
    })
  })
}

function bootstrapHello(overrides: Partial<RelayHello> = {}): RelayHello {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'hello',
    role: 'host',
    hostId,
    deviceId: hostDeviceId,
    credential: bootstrapCredential,
    authMode: 'bootstrap',
    sessionCredential: hostSessionCredential,
    ...overrides,
  } as RelayHello
}

function hostResumeHello(overrides: Partial<RelayHello> = {}): RelayHello {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'hello',
    role: 'host',
    hostId,
    deviceId: hostDeviceId,
    credential: hostSessionCredential,
    authMode: 'resume',
    ...overrides,
  } as RelayHello
}

function clientResumeHello(overrides: Partial<RelayHello> = {}): RelayHello {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'hello',
    role: 'client',
    hostId,
    deviceId: clientDeviceId,
    credential: clientCredential,
    authMode: 'resume',
    ...overrides,
  } as RelayHello
}

async function authenticate(peer: TestPeer, hello: RelayHello): Promise<ReturnType<typeof decodeRelayWelcome>> {
  const response = peer.nextText()
  peer.send(encodeRelayHello(hello))
  const welcome = decodeRelayWelcome(await response)
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  return welcome
}

async function expectAuthenticationFailure(
  peer: TestPeer,
  frame: string | Buffer,
  binary = false,
): Promise<void> {
  const response = peer.nextText()
  const closed = peer.waitForClose()
  peer.send(frame, binary)
  const errorFrame = await response
  expect(errorFrame).toBe(encodeRelayNotAuthenticated())
  expect(decodeRelayNotAuthenticated(errorFrame)).toEqual({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'error',
    code: 'not-authenticated',
  })
  await expect(closed).resolves.toEqual({
    code: RELAY_CLOSE.notAuthenticated,
    reason: 'not-authenticated',
  })
}

function envelope(overrides: Partial<RoutedEnvelope> = {}): RoutedEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    connectionGeneration: 7,
    fromDeviceId: clientDeviceId,
    toDeviceId: hostDeviceId,
    hostId,
    keyId: 'key-7',
    requestId: 'request-1',
    taskId: 'task-1',
    seq: 1,
    ack: 0,
    sentAt: fixedNow - 1_000,
    expiresAt: fixedNow + 60_000,
    messageType: 'request',
    ciphertext: encodeBase64Url(new TextEncoder().encode('opaque encrypted payload')),
    ...overrides,
  }
}

async function startRegisteredRelay(
  overrides: Partial<RelayServerOptions> = {},
): Promise<{
  server: LocalTestRelayServer
  stateFile: string
  httpOrigin: string
  webSocketUrl: string
  host: TestPeer
  client: TestPeer
}> {
  const started = await startRelay({
    seededClients: [{ hostId, deviceId: clientDeviceId, credential: clientCredential }],
    ...overrides,
  })
  const host = await connect(started.webSocketUrl)
  await authenticate(host, bootstrapHello())
  const client = await connect(started.webSocketUrl, { origin: browserOrigin })
  await authenticate(client, clientResumeHello())
  return { ...started, host, client }
}

async function route(
  source: TestPeer,
  target: TestPeer,
  value: RoutedEnvelope,
): Promise<{ raw: string; targetRaw: string; receipt: RelayReceipt }> {
  const raw = encodeEnvelope(value)
  const targetFrame = target.nextText()
  const receiptFrame = source.nextText()
  source.send(raw)
  return {
    raw,
    targetRaw: await targetFrame,
    receipt: decodeRelayReceipt(await receiptFrame),
  }
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  for (const server of [...servers]) {
    await server.close().catch(() => undefined)
  }
  servers.clear()
  for (const peer of peers) peer.terminate()
  peers.clear()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('localhost-only Relay surface', () => {
  it('fails before binding a non-loopback address and rejects unsafe Origin configuration', async () => {
    const server = createLocalTestRelayServer({
      mode: 'r2-local-test',
      stateFile: nextStatePath('non-loopback'),
      bootstrapCredential,
    })
    await expect(server.listen({ host: '0.0.0.0' as '127.0.0.1' })).rejects.toThrow(
      'Relay must bind a numeric loopback address.',
    )
    await server.close()

    expect(() => createLocalTestRelayServer({
      mode: 'r2-local-test',
      stateFile: nextStatePath('unsafe-origin'),
      bootstrapCredential,
      allowedOrigins: ['https://example.com'],
    })).toThrow('Relay allowedOrigins must contain unique numeric loopback origins.')
  })

  it('exposes only the minimal health and WebSocket paths with an exact Origin allowlist', async () => {
    const { httpOrigin, webSocketUrl } = await startRelay()

    const health = await fetch(`${httpOrigin}/healthz`)
    expect(health.status).toBe(200)
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(await health.text()).toBe('{"status":"ok","mode":"r2-local-test","insecure":true}')

    expect((await fetch(`${httpOrigin}/healthz`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${httpOrigin}/api/tasks`)).status).toBe(404)
    await rejectedUpgrade(webSocketUrl.replace('/api/ws', '/other'), 404)
    await rejectedUpgrade(webSocketUrl, 403, { origin: 'http://127.0.0.1:41731' })

    const allowed = await connect(webSocketUrl, { origin: browserOrigin })
    await allowed.close()
  })

  it('serializes listen and cancels an in-flight start before close returns', async () => {
    const once = createLocalTestRelayServer({
      mode: 'r2-local-test',
      stateFile: nextStatePath('listen-once'),
      bootstrapCredential,
    })
    servers.add(once)
    const firstListen = once.listen({ host: '127.0.0.1' })
    await expect(once.listen({ host: '127.0.0.1' })).rejects.toThrow('Relay listen may only be called once.')
    await expect(firstListen).resolves.toMatchObject({ host: '127.0.0.1' })
    await stopRelay(once)

    const cancelled = createLocalTestRelayServer({
      mode: 'r2-local-test',
      stateFile: nextStatePath('cancel-start'),
      bootstrapCredential,
    })
    servers.add(cancelled)
    const pendingListen = cancelled.listen({ host: '127.0.0.1' })
    const closing = cancelled.close()
    await expect(pendingListen).rejects.toThrow('Relay start was cancelled.')
    await expect(closing).resolves.toBeUndefined()
    expect(cancelled.getAddress()).toBeUndefined()
    servers.delete(cancelled)
  })
})

describe('Relay authentication and persistent registration closure', () => {
  it('persists registration closure before welcome, exposes no secret, and resumes after restart', async () => {
    const stateFile = nextStatePath('restart')
    const first = await startRelay({
      stateFile,
      seededClients: [{ hostId, deviceId: clientDeviceId, credential: clientCredential }],
    })
    const host = await connect(first.webSocketUrl)
    const welcome = await authenticate(host, bootstrapHello())

    expect(welcome).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'welcome',
      hostId,
      deviceId: hostDeviceId,
      registrationState: 'closed',
      heartbeatIntervalMs: 30_000,
      maxFrameBytes: MAX_FRAME_BYTES,
      role: 'host',
      authMode: 'bootstrap',
    })
    const persisted = await readFile(stateFile, 'utf8')
    expect(JSON.parse(persisted)).toEqual({
      stateVersion: 1,
      registrationClosed: true,
      hostId,
      deviceId: hostDeviceId,
      sessionCredentialDigest: digestCredential(hostSessionCredential),
    })
    expect(`${JSON.stringify(welcome)}${persisted}`).not.toContain(bootstrapCredential)
    expect(`${JSON.stringify(welcome)}${persisted}`).not.toContain(hostSessionCredential)

    await stopRelay(first.server)

    const second = await startRelay({
      stateFile,
      seededClients: [{ hostId, deviceId: clientDeviceId, credential: clientCredential }],
    })
    const duplicate = await connect(second.webSocketUrl)
    await expectAuthenticationFailure(duplicate, encodeRelayHello(bootstrapHello()))

    const resumed = await connect(second.webSocketUrl)
    expect(await authenticate(resumed, hostResumeHello())).toMatchObject({
      role: 'host',
      authMode: 'resume',
      registrationState: 'closed',
    })
  })

  it('uses one fixed failure for malformed, wrong-secret, binary, and unknown first frames', async () => {
    const { webSocketUrl } = await startRelay({ helloTimeoutMs: 100 })
    const fixtures: Array<{ frame: string | Buffer; binary?: boolean; origin?: string }> = [
      { frame: ` ${encodeRelayHello(bootstrapHello())}` },
      { frame: encodeRelayHello(bootstrapHello({ credential: wrongCredential })) },
      { frame: Buffer.from(encodeRelayHello(bootstrapHello())), binary: true },
      { frame: encodeEnvelope(envelope()) },
      { frame: encodeRelayHello(clientResumeHello()), origin: browserOrigin },
    ]

    for (const fixture of fixtures) {
      const peer = await connect(webSocketUrl, fixture.origin === undefined ? {} : { origin: fixture.origin })
      await expectAuthenticationFailure(peer, fixture.frame, fixture.binary)
    }

    const timedOut = await connect(webSocketUrl)
    expect(await timedOut.nextText()).toBe(encodeRelayNotAuthenticated())
    await expect(timedOut.waitForClose()).resolves.toEqual({
      code: RELAY_CLOSE.notAuthenticated,
      reason: 'not-authenticated',
    })
  })

  it('admits only a seeded browser client after its host is registered', async () => {
    const { webSocketUrl, host } = await startRegisteredRelay()
    expect(host.socket.readyState).toBe(WebSocket.OPEN)

    const unknown = await connect(webSocketUrl, { origin: browserOrigin })
    await expectAuthenticationFailure(
      unknown,
      encodeRelayHello(clientResumeHello({ deviceId: 'device-unknown' })),
    )
  })
})

describe('opaque bidirectional routing and authorization', () => {
  it('routes the original bytes both ways and emits only strict non-authoritative receipts', async () => {
    const { host, client } = await startRegisteredRelay()

    const clientToHost = envelope()
    const first = await route(client, host, clientToHost)
    expect(first.targetRaw).toBe(first.raw)
    expect(first.receipt).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 7,
      requestId: 'request-1',
      seq: 1,
      state: 'relayed',
    })
    expect(first.receipt).not.toHaveProperty('accepted')

    const hostToClient = envelope({
      fromDeviceId: hostDeviceId,
      toDeviceId: clientDeviceId,
      requestId: 'request-2',
      messageType: 'response',
    })
    const second = await route(host, client, hostToClient)
    expect(second.targetRaw).toBe(second.raw)
    expect(second.receipt).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 7,
      requestId: 'request-2',
      seq: 1,
      state: 'relayed',
    })
  })

  it('returns strict unavailable without storing an envelope when the authorized peer is offline', async () => {
    const { host, client } = await startRegisteredRelay()
    await host.close()

    const receiptFrame = client.nextText()
    client.send(encodeEnvelope(envelope({ requestId: 'request-offline' })))
    expect(decodeRelayReceipt(await receiptFrame)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 7,
      requestId: 'request-offline',
      seq: 1,
      state: 'unavailable',
      code: 'host-unavailable',
    })
  })

  it('closes on a forged from identity', async () => {
    const { client } = await startRegisteredRelay()
    const closed = client.waitForClose()
    client.send(encodeEnvelope(envelope({ fromDeviceId: 'device-attacker' })))
    await expect(closed).resolves.toEqual({
      code: RELAY_CLOSE.protocolViolation,
      reason: 'protocol-violation',
    })
  })

  it('closes rather than enumerating unknown, cross-host, or same-role targets', async () => {
    const invalidRoutes: Partial<RoutedEnvelope>[] = [
      { toDeviceId: 'device-unknown' },
      { hostId: 'host-other' },
      { fromDeviceId: hostDeviceId, toDeviceId: hostDeviceId },
    ]

    for (const [index, invalid] of invalidRoutes.entries()) {
      const registered = await startRegisteredRelay()
      const source = index === 2 ? registered.host : registered.client
      const closed = source.waitForClose()
      source.send(encodeEnvelope(envelope({ requestId: `request-invalid-${index}`, ...invalid })))
      await expect(closed).resolves.toEqual({
        code: RELAY_CLOSE.protocolViolation,
        reason: 'protocol-violation',
      })
      await stopRelay(registered.server)
    }
  })
})

describe('reconnect, endpoint sequencing, and resource bounds', () => {
  it('replaces the old device socket while endpoint guards reject replay and accept the peer ack', async () => {
    const { host, client: oldClient, webSocketUrl } = await startRegisteredRelay()
    const clientGuard = new EnvelopeSequenceGuard({
      hostId,
      localDeviceId: clientDeviceId,
      remoteDeviceId: hostDeviceId,
      connectionGeneration: 7,
      keyId: 'key-7',
    })
    const hostGuard = new EnvelopeSequenceGuard({
      hostId,
      localDeviceId: hostDeviceId,
      remoteDeviceId: clientDeviceId,
      connectionGeneration: 7,
      keyId: 'key-7',
    })

    const original = envelope({
      fromDeviceId: hostDeviceId,
      toDeviceId: clientDeviceId,
      requestId: 'request-retry',
    })
    const first = await route(host, oldClient, original)
    expect(clientGuard.acceptAuthenticatedEnvelope(decodeEnvelope(first.targetRaw, { now: fixedNow }), fixedNow))
      .toMatchObject({ lastAcceptedSeq: 1 })
    hostGuard.recordSentSequence(1)

    const oldClosed = oldClient.waitForClose()
    const newClient = await connect(webSocketUrl, { origin: browserOrigin })
    await authenticate(newClient, clientResumeHello())
    await expect(oldClosed).resolves.toEqual({ code: RELAY_CLOSE.replaced, reason: 'replaced' })

    const retried = await route(host, newClient, original)
    expect(retried.targetRaw).toBe(first.raw)
    expect(() => clientGuard.acceptAuthenticatedEnvelope(
      decodeEnvelope(retried.targetRaw, { now: fixedNow }),
      fixedNow,
    )).toThrowError(expect.objectContaining<Partial<ProtocolViolation>>({ code: 'replay' }))

    clientGuard.recordSentSequence(1)
    const response = envelope({
      requestId: 'request-response',
      messageType: 'response',
      seq: 1,
      ack: 1,
    })
    const returned = await route(newClient, host, response)
    expect(hostGuard.acceptAuthenticatedEnvelope(decodeEnvelope(returned.targetRaw, { now: fixedNow }), fixedNow))
      .toMatchObject({ lastAcceptedSeq: 1, lastPeerAck: 1 })
  })

  it('rate-limits without forwarding and closes only after the configured repeated violation', async () => {
    const { host, client } = await startRegisteredRelay({
      maxFramesPerWindow: 1,
      maxBytesPerWindow: MAX_FRAME_BYTES,
      maxRateLimitViolations: 2,
    })

    expect((await route(client, host, envelope())).receipt.state).toBe('relayed')

    const noSecondTarget = host.expectNoFrame()
    const secondReceipt = client.nextText()
    client.send(encodeEnvelope(envelope({ requestId: 'request-rate-2', seq: 2 })))
    expect(decodeRelayReceipt(await secondReceipt)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 7,
      requestId: 'request-rate-2',
      seq: 2,
      state: 'rejected',
      code: 'rate-limited',
    })
    await noSecondTarget

    const noThirdTarget = host.expectNoFrame()
    const thirdReceipt = client.nextText()
    const closed = client.waitForClose()
    client.send(encodeEnvelope(envelope({ requestId: 'request-rate-3', seq: 3 })))
    expect(decodeRelayReceipt(await thirdReceipt)).toMatchObject({
      state: 'rejected',
      code: 'rate-limited',
    })
    await noThirdTarget
    await expect(closed).resolves.toEqual({ code: RELAY_CLOSE.rateLimited, reason: 'rate-limited' })
  })

  it('rejects deterministic target backpressure without forwarding the frame', async () => {
    const { host, client } = await startRegisteredRelay({ maxOutboundBufferedBytes: 1 })
    const noTarget = host.expectNoFrame()
    const receiptFrame = client.nextText()
    client.send(encodeEnvelope(envelope({ requestId: 'request-backpressure' })))

    expect(decodeRelayReceipt(await receiptFrame)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 7,
      requestId: 'request-backpressure',
      seq: 1,
      state: 'rejected',
      code: 'backpressure',
    })
    await noTarget
  })

  it('uses the fixed heartbeat timeout close for a peer that suppresses pong', async () => {
    const started = await startRelay({ heartbeatIntervalMs: 1_000 })
    const host = await connect(started.webSocketUrl, { autoPong: false })
    await authenticate(host, bootstrapHello())

    started.server.sweepHeartbeats()
    await new Promise<void>(resolve => setImmediate(resolve))
    const closed = host.waitForClose()
    started.server.sweepHeartbeats()
    await expect(closed).resolves.toEqual({
      code: RELAY_CLOSE.heartbeatTimeout,
      reason: 'heartbeat-timeout',
    })
  })
})

describe('logging allowlist', () => {
  it('never logs credentials, identities, ciphertext, prompt/code bait, frame, Origin, or state path', async () => {
    const entries: RelayLogEntry[] = []
    const stateFile = nextStatePath('D-drive-secret-path')
    const logHostId = 'host-log-sentinel'
    const logHostDevice = 'device-host-log-sentinel'
    const logClientDevice = 'device-client-log-sentinel'
    const promptBait = 'PROMPT_SECRET run-dangerous-code D:\\private\\auth.json'
    const ciphertext = encodeBase64Url(new TextEncoder().encode(promptBait))
    const started = await startRelay({
      stateFile,
      logger: entry => entries.push(entry),
      seededClients: [{
        hostId: logHostId,
        deviceId: logClientDevice,
        credential: clientCredential,
      }],
    })
    const host = await connect(started.webSocketUrl)
    await authenticate(host, bootstrapHello({ hostId: logHostId, deviceId: logHostDevice }))
    const client = await connect(started.webSocketUrl, { origin: browserOrigin })
    await authenticate(client, clientResumeHello({ hostId: logHostId, deviceId: logClientDevice }))

    const value = envelope({
      hostId: logHostId,
      fromDeviceId: logClientDevice,
      toDeviceId: logHostDevice,
      requestId: 'request-log-sentinel',
      ciphertext,
    })
    const routed = await route(client, host, value)
    expect(routed.receipt.state).toBe('relayed')
    await stopRelay(started.server)

    const allowedKeys = new Set([
      'timestamp',
      'event',
      'connectionCount',
      'role',
      'outcome',
      'frameBytes',
      'closeCode',
    ])
    for (const entry of entries) {
      expect(Object.keys(entry).every(key => allowedKeys.has(key))).toBe(true)
    }
    expect(entries.map(entry => entry.event)).toEqual(expect.arrayContaining([
      'relay.started',
      'connection.authenticated',
      'route.relayed',
      'relay.stopped',
    ]))

    const serialized = JSON.stringify(entries)
    for (const forbidden of [
      bootstrapCredential,
      hostSessionCredential,
      clientCredential,
      logHostId,
      logHostDevice,
      logClientDevice,
      'request-log-sentinel',
      ciphertext,
      promptBait,
      browserOrigin,
      stateFile,
      routed.raw,
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
