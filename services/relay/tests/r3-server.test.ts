import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeRelayAuthorizationApplied,
  decodeRelayDeviceChallenge,
  decodeRelayDeviceWelcome,
  decodeRelayNotAuthenticated,
  decodeRelayPairClaimed,
  decodeRelayPairOpened,
  decodeRelayReceipt,
  encodeEnvelope,
  encodePairJoinFrame,
  encodePairResultFrame,
  encodeRelayAuthorizationPut,
  encodeRelayDeviceHello,
  encodeRelayDeviceProof,
  encodeRelayDeviceProofSignatureInput,
  encodeRelayPairClaim,
  encodeRelayPairClose,
  encodeRelayPairOpen,
  encodeSessionAccept,
  encodeSessionInit,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type P256PublicJwk,
  type RelayDeviceChallenge,
  type RelayDeviceHello,
} from '@codex-plus/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { type ClientOptions, type RawData } from 'ws'

import {
  createR3LocalTestRelayServer,
  R3_RELAY_CLOSE,
  type R3LocalTestRelayServer,
  type R3RelayServerOptions,
} from '../src/index.ts'

const sharedTestRoot = fileURLToPath(new URL('../../../.tmp/relay-r3-tests/', import.meta.url))
const testRoot = join(sharedTestRoot, `server-${process.pid}-${randomUUID()}`)
const relayOrigin = 'http://127.0.0.1:41740'
const fixedNow = 1_900_000_000_000
const hostId = 'host-r3'
const hostDeviceId = 'device-host-r3'
const clientDeviceId = 'device-client-r3'
const authorizationId = 'authorization-r3'
const bootstrapCredential = Buffer.alloc(32, 31).toString('base64url')
const servers = new Set<R3LocalTestRelayServer>()
const peers = new Set<TestPeer>()
let stateCounter = 0

interface SigningIdentity {
  privateKey: KeyObject
  publicKey: P256PublicJwk
  fingerprint: string
}

interface ReceivedFrame {
  bytes: Buffer
  isBinary: boolean
}

function publicJwk(key: KeyObject): P256PublicJwk {
  const exported = key.export({ format: 'jwk' })
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) {
    throw new Error('Unexpected test key.')
  }
  return { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y }
}

function signingIdentity(): SigningIdentity {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const key = publicJwk(pair.publicKey)
  const fingerprint = Buffer.from(
    // RFC 7638 member order is fixed by the protocol.
    JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }),
  )
  return {
    privateKey: pair.privateKey,
    publicKey: key,
    fingerprint: createHash('sha256').update(fingerprint).digest('base64url'),
  }
}

function signature(fill: number): string {
  return Buffer.alloc(64, fill).toString('base64url')
}

function secret(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url')
}

function asBuffer(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

class TestPeer {
  readonly socket: WebSocket
  private readonly frames: ReceivedFrame[] = []
  private readonly waiters: Array<{
    resolve: (frame: ReceivedFrame) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []
  private closed?: { code: number; reason: string }
  private readonly closeWaiters: Array<(value: { code: number; reason: string }) => void> = []

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data, isBinary) => {
      const frame = { bytes: asBuffer(data), isBinary }
      const waiter = this.waiters.shift()
      if (waiter === undefined) this.frames.push(frame)
      else {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    })
    socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString('utf8') }
      for (const resolve of this.closeWaiters.splice(0)) resolve(this.closed)
    })
    socket.on('error', () => {
      // Tests assert only stable protocol-visible failure surfaces.
    })
  }

  send(frame: string | Buffer, binary = false): void {
    this.socket.send(frame, { binary })
  }

  async nextText(timeoutMs = 2_000): Promise<string> {
    const queued = this.frames.shift()
    if (queued !== undefined) {
      expect(queued.isBinary).toBe(false)
      return queued.bytes.toString('utf8')
    }
    const frame = await new Promise<ReceivedFrame>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Timed out waiting for R3 Relay frame.'))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
    expect(frame.isBinary).toBe(false)
    return frame.bytes.toString('utf8')
  }

  async waitForClose(timeoutMs = 2_000): Promise<{ code: number; reason: string }> {
    if (this.closed !== undefined) return this.closed
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for close.')), timeoutMs)
      this.closeWaiters.push(value => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }
}

function nextStatePath(): string {
  stateCounter += 1
  return join(testRoot, `${stateCounter}`, 'state.json')
}

async function startRelay(
  stateFile = nextStatePath(),
  overrides: Partial<R3RelayServerOptions> = {},
): Promise<{
  server: R3LocalTestRelayServer
  stateFile: string
  webSocketUrl: string
  httpOrigin: string
}> {
  const server = createR3LocalTestRelayServer({
    mode: 'r3-local-test',
    stateFile,
    relayOrigin,
    bootstrapCredential,
    now: () => fixedNow,
    ...overrides,
  })
  servers.add(server)
  const address = await server.listen({ host: '127.0.0.1' })
  return { server, stateFile, webSocketUrl: address.webSocketUrl, httpOrigin: address.httpOrigin }
}

async function connect(url: string, options: ClientOptions = {}): Promise<TestPeer> {
  const socket = new WebSocket(url, options)
  const peer = new TestPeer(socket)
  peers.add(peer)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('R3 Relay connection failed.')))
  })
  return peer
}

function bootstrapHello(host: SigningIdentity): RelayDeviceHello {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.hello',
    relayOrigin,
    role: 'host',
    authMode: 'bootstrap',
    hostId,
    hostDeviceId,
    deviceId: hostDeviceId,
    bootstrapCredential,
    hostSigningKey: host.publicKey,
    hostSigningFingerprint: host.fingerprint,
  }
}

function hostHello(): RelayDeviceHello {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.hello',
    relayOrigin,
    role: 'host',
    authMode: 'challenge',
    hostId,
    hostDeviceId,
    deviceId: hostDeviceId,
  }
}

function clientHello(epoch = 1): RelayDeviceHello {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.hello',
    relayOrigin,
    role: 'client',
    authMode: 'challenge',
    hostId,
    hostDeviceId,
    deviceId: clientDeviceId,
    authorizationId,
    authorizationEpoch: epoch,
  }
}

function proofFor(challenge: RelayDeviceChallenge, privateKey: KeyObject): string {
  const proofCommon = {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.proof' as const,
    relayOrigin,
    role: challenge.role,
    authMode: challenge.authMode,
    hostId: challenge.hostId,
    hostDeviceId: challenge.hostDeviceId,
    deviceId: challenge.deviceId,
    challengeId: challenge.challengeId,
    signature: sign(
      'sha256',
      encodeRelayDeviceProofSignatureInput(challenge),
      { key: privateKey, dsaEncoding: 'ieee-p1363' },
    ).toString('base64url'),
  }
  return encodeRelayDeviceProof(challenge.authMode === 'bootstrap'
    ? { ...proofCommon, role: 'host', authMode: 'bootstrap', hostSigningFingerprint: challenge.hostSigningFingerprint }
    : challenge.role === 'host'
      ? { ...proofCommon, role: 'host', authMode: 'challenge' }
      : {
          ...proofCommon,
          role: 'client',
          authMode: 'challenge',
          authorizationId: challenge.authorizationId,
          authorizationEpoch: challenge.authorizationEpoch,
        })
}

async function authenticate(
  peer: TestPeer,
  hello: RelayDeviceHello,
  privateKey: KeyObject,
): Promise<void> {
  peer.send(encodeRelayDeviceHello(hello))
  const challenge = decodeRelayDeviceChallenge(await peer.nextText(), relayOrigin, fixedNow)
  peer.send(proofFor(challenge, privateKey))
  const welcome = decodeRelayDeviceWelcome(await peer.nextText(), relayOrigin)
  expect(welcome).toMatchObject({
    role: hello.role,
    authMode: hello.authMode,
    hostId,
    hostDeviceId,
    deviceId: hello.deviceId,
    maxFrameBytes: MAX_FRAME_BYTES,
  })
  expect(welcome.heartbeatIntervalMs).toBeGreaterThan(0)
}

async function bootstrapAndAuthorize(started: Awaited<ReturnType<typeof startRelay>>): Promise<{
  host: TestPeer
  client: TestPeer
  hostSigning: SigningIdentity
  clientSigning: SigningIdentity
}> {
  const hostSigning = signingIdentity()
  const clientSigning = signingIdentity()
  const host = await connect(started.webSocketUrl)
  await authenticate(host, bootstrapHello(hostSigning), hostSigning.privateKey)
  host.send(encodeRelayAuthorizationPut({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'authorization.put',
    hostId,
    hostDeviceId,
    clientDeviceId,
    authorizationId,
    authorizationEpoch: 1,
    hostAuthorizationRevision: 1,
    status: 'active',
    clientSigningKey: clientSigning.publicKey,
    clientSigningFingerprint: clientSigning.fingerprint,
  }))
  expect(decodeRelayAuthorizationApplied(await host.nextText())).toMatchObject({
    status: 'active',
    hostAuthorizationRevision: 1,
  })
  const client = await connect(started.webSocketUrl, { origin: relayOrigin })
  await authenticate(client, clientHello(), clientSigning.privateKey)
  return { host, client, hostSigning, clientSigning }
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  for (const server of [...servers]) await server.close().catch(() => undefined)
  servers.clear()
  for (const peer of peers) peer.terminate()
  peers.clear()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('R3 localhost challenge and authorization chain', () => {
  it('bootstraps only after a valid proof, persists public state, and routes the exact vertical chain', async () => {
    const started = await startRelay()
    const health = await fetch(`${started.httpOrigin}/healthz`)
    expect(await health.text()).toBe('{"status":"ok","mode":"r3-local-test","insecure":true}')

    const { host, client, hostSigning, clientSigning } = await bootstrapAndAuthorize(started)
    const persisted = await readFile(started.stateFile, 'utf8')
    expect(persisted).not.toContain(bootstrapCredential)
    expect(persisted).not.toContain(hostSigning.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    expect(JSON.parse(persisted)).toMatchObject({
      registrationClosed: true,
      hostAuthorizationRevision: 1,
      host: { hostId, hostDeviceId },
      authorizations: [{ authorizationId, status: 'active' }],
    })

    const clientEphemeral = signingIdentity()
    const hostEphemeral = signingIdentity()
    const init = encodeSessionInit({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'session.init',
      relayOrigin,
      hostId,
      hostDeviceId,
      clientDeviceId,
      authorizationId,
      authorizationEpoch: 1,
      handshakeId: 'handshake-r3',
      clientNonce: secret(41),
      clientEphemeralAgreementKey: clientEphemeral.publicKey,
      issuedAt: fixedNow,
      expiresAt: fixedNow + 30_000,
      clientSignature: signature(42),
    })
    client.send(init)
    expect(await host.nextText()).toBe(init)

    const accept = encodeSessionAccept({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'session.accept',
      relayOrigin,
      hostId,
      hostDeviceId,
      clientDeviceId,
      authorizationId,
      authorizationEpoch: 1,
      handshakeId: 'handshake-r3',
      connectionGeneration: 1,
      clientToHostKeyId: 'key-client-host',
      hostToClientKeyId: 'key-host-client',
      sessionInitHash: secret(43),
      hostNonce: secret(44),
      hostEphemeralAgreementKey: hostEphemeral.publicKey,
      issuedAt: fixedNow,
      expiresAt: fixedNow + 30_000,
      hostSignature: signature(45),
    })
    host.send(accept)
    expect(await client.nextText()).toBe(accept)

    const envelope = encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      requestId: 'request-r3',
      seq: 2,
      ack: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 60_000,
      messageType: 'request',
      ciphertext: secret(46),
    })
    client.send(envelope)
    expect(await host.nextText()).toBe(envelope)
    expect(decodeRelayReceipt(await client.nextText())).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'request-r3',
      seq: 2,
      state: 'relayed',
    })
    expect(clientSigning.publicKey).not.toEqual(hostSigning.publicKey)
  })

  it('serializes a valid authenticated frame burst without closing the socket', async () => {
    const started = await startRelay()
    const { host, client } = await bootstrapAndAuthorize(started)
    const common = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      ack: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 60_000,
      messageType: 'request' as const,
      ciphertext: secret(47),
    }
    const first = encodeEnvelope({ ...common, requestId: 'burst-1', seq: 2 })
    const second = encodeEnvelope({ ...common, requestId: 'burst-2', seq: 3 })

    client.send(first)
    client.send(second)

    expect(await host.nextText()).toBe(first)
    expect(await host.nextText()).toBe(second)
    expect(decodeRelayReceipt(await client.nextText())).toMatchObject({
      requestId: 'burst-1',
      state: 'relayed',
    })
    expect(decodeRelayReceipt(await client.nextText())).toMatchObject({
      requestId: 'burst-2',
      state: 'relayed',
    })
    expect(client.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('closes an authenticated sender when its bounded inbound FIFO overflows', async () => {
    const started = await startRelay()
    const { client } = await bootstrapAndAuthorize(started)
    const internal = started.server as unknown as {
      connections: Set<{ identity?: { role?: string }; processing: boolean }>
      enqueueAuthenticatedMessage(record: unknown, bytes: Uint8Array): void
    }
    const clientRecord = [...internal.connections].find(record => record.identity?.role === 'client')
    if (clientRecord === undefined) throw new Error('Missing authenticated client record.')
    // Hold the same flag used by a real in-flight handler so this test exercises
    // the 16-frame FIFO deterministically instead of depending on kernel scheduling.
    clientRecord.processing = true
    const common = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      ack: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 60_000,
      messageType: 'request' as const,
      ciphertext: secret(48),
    }
    const closed = client.waitForClose()
    for (let index = 0; index < 17; index += 1) {
      internal.enqueueAuthenticatedMessage(clientRecord, new TextEncoder().encode(encodeEnvelope({
        ...common,
        requestId: `queue-overflow-${index}`,
        seq: index + 2,
      })))
    }

    expect(await closed).toEqual({
      code: R3_RELAY_CLOSE.rateLimited,
      reason: 'rate-limited',
    })
  })

  it('keeps bootstrap closed across restart and uses one fixed authentication failure', async () => {
    const stateFile = nextStatePath()
    const first = await startRelay(stateFile)
    const hostSigning = signingIdentity()
    const host = await connect(first.webSocketUrl)
    await authenticate(host, bootstrapHello(hostSigning), hostSigning.privateKey)
    await first.server.close()
    servers.delete(first.server)

    const second = await startRelay(stateFile)
    const duplicate = await connect(second.webSocketUrl)
    duplicate.send(encodeRelayDeviceHello(bootstrapHello(signingIdentity())))
    expect(decodeRelayNotAuthenticated(await duplicate.nextText())).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'error',
      code: 'not-authenticated',
    })
    expect(await duplicate.waitForClose()).toEqual({
      code: R3_RELAY_CLOSE.notAuthenticated,
      reason: 'not-authenticated',
    })

    const resumed = await connect(second.webSocketUrl)
    await authenticate(resumed, hostHello(), hostSigning.privateKey)
  })

  it('rejects a tampered proof without revealing whether identity or signature failed', async () => {
    const started = await startRelay()
    const hostSigning = signingIdentity()
    const peer = await connect(started.webSocketUrl)
    peer.send(encodeRelayDeviceHello(bootstrapHello(hostSigning)))
    const challenge = decodeRelayDeviceChallenge(await peer.nextText(), relayOrigin, fixedNow)
    const wrongSigning = signingIdentity()
    peer.send(proofFor(challenge, wrongSigning.privateKey))
    expect(decodeRelayNotAuthenticated(await peer.nextText()).code).toBe('not-authenticated')
    expect(await peer.waitForClose()).toEqual({
      code: R3_RELAY_CLOSE.notAuthenticated,
      reason: 'not-authenticated',
    })
  })

  it('atomically replaces a reconnected client and removes its route after a durable revoke', async () => {
    const started = await startRelay()
    const { host, client: oldClient, clientSigning } = await bootstrapAndAuthorize(started)
    const oldClosed = oldClient.waitForClose()
    const replacement = await connect(started.webSocketUrl, { origin: relayOrigin })
    await authenticate(replacement, clientHello(), clientSigning.privateKey)
    expect(await oldClosed).toEqual({ code: R3_RELAY_CLOSE.replaced, reason: 'replaced' })

    host.send(encodeRelayAuthorizationPut({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'authorization.put',
      hostId,
      hostDeviceId,
      clientDeviceId,
      authorizationId,
      authorizationEpoch: 2,
      hostAuthorizationRevision: 2,
      status: 'revoked',
    }))
    expect(decodeRelayAuthorizationApplied(await host.nextText())).toMatchObject({
      authorizationEpoch: 2,
      hostAuthorizationRevision: 2,
      status: 'revoked',
    })
    expect(decodeRelayNotAuthenticated(await replacement.nextText()).code).toBe('not-authenticated')
    expect(await replacement.waitForClose()).toEqual({
      code: R3_RELAY_CLOSE.notAuthenticated,
      reason: 'not-authenticated',
    })

    const stale = await connect(started.webSocketUrl, { origin: relayOrigin })
    stale.send(encodeRelayDeviceHello(clientHello()))
    expect(decodeRelayNotAuthenticated(await stale.nextText()).code).toBe('not-authenticated')
  })

  it('enforces outbound backpressure while keeping strict control receipts available', async () => {
    const started = await startRelay(nextStatePath(), { maxOutboundBufferedBytes: 1 })
    const { host, client } = await bootstrapAndAuthorize(started)
    const envelope = encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      requestId: 'request-backpressure-r3',
      seq: 2,
      ack: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 60_000,
      messageType: 'request',
      ciphertext: secret(61),
    })
    client.send(envelope)
    expect(decodeRelayReceipt(await client.nextText())).toMatchObject({
      requestId: 'request-backpressure-r3',
      state: 'rejected',
      code: 'backpressure',
    })
    expect(host.socket.readyState).toBe(WebSocket.OPEN)
  })

  it('bounds frame rate and heartbeat liveness with fixed close reasons', async () => {
    const rateStarted = await startRelay(nextStatePath(), {
      maxFramesPerWindow: 1,
      maxRateLimitViolations: 2,
    })
    const { host, client } = await bootstrapAndAuthorize(rateStarted)
    const baseEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      ack: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 60_000,
      messageType: 'request' as const,
      ciphertext: secret(62),
    }
    client.send(encodeEnvelope({ ...baseEnvelope, requestId: 'rate-1', seq: 2 }))
    expect(await host.nextText()).toContain('"requestId":"rate-1"')
    expect(decodeRelayReceipt(await client.nextText()).state).toBe('relayed')
    client.send(encodeEnvelope({ ...baseEnvelope, requestId: 'rate-2', seq: 3 }))
    expect(decodeRelayReceipt(await client.nextText())).toMatchObject({
      requestId: 'rate-2',
      state: 'rejected',
      code: 'rate-limited',
    })
    const rateClosed = client.waitForClose()
    client.send(encodeEnvelope({ ...baseEnvelope, requestId: 'rate-3', seq: 4 }))
    expect(await rateClosed).toEqual({
      code: R3_RELAY_CLOSE.rateLimited,
      reason: 'rate-limited',
    })

    await rateStarted.server.close()
    servers.delete(rateStarted.server)
    const heartbeatStarted = await startRelay(nextStatePath(), { heartbeatIntervalMs: 1_000 })
    const authorized = await bootstrapAndAuthorize(heartbeatStarted)
    const replacementClosed = authorized.client.waitForClose()
    const noPong = await connect(heartbeatStarted.webSocketUrl, {
      origin: relayOrigin,
      autoPong: false,
    })
    await authenticate(noPong, clientHello(), authorized.clientSigning.privateKey)
    expect(await replacementClosed).toEqual({ code: R3_RELAY_CLOSE.replaced, reason: 'replaced' })
    heartbeatStarted.server.sweepHeartbeats()
    await new Promise<void>(resolve => setImmediate(resolve))
    const heartbeatClosed = noPong.waitForClose()
    heartbeatStarted.server.sweepHeartbeats()
    expect(await heartbeatClosed).toEqual({
      code: R3_RELAY_CLOSE.heartbeatTimeout,
      reason: 'heartbeat-timeout',
    })
  })
})

describe('R3 opaque pair rendezvous', () => {
  it('does not claim on join receipt and releases pair.result only after the Host claim', async () => {
    const started = await startRelay()
    const { host } = await bootstrapAndAuthorize(started)
    const pairSessionId = 'pair-session-r3'
    const joinId = 'join-r3'
    host.send(encodeRelayPairOpen({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'pair.open',
      hostId,
      hostDeviceId,
      pairSessionId,
      expiresAt: fixedNow + 120_000,
    }))
    expect(decodeRelayPairOpened(await host.nextText(), fixedNow)).toMatchObject({ pairSessionId })

    const attempt = await connect(started.webSocketUrl, { origin: relayOrigin })
    const ephemeral = signingIdentity()
    const join = encodePairJoinFrame({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'pair.join',
      hostId,
      hostDeviceId,
      pairSessionId,
      joinId,
      clientEphemeralAgreementKey: ephemeral.publicKey,
      seq: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 30_000,
      ciphertext: secret(51),
    })
    attempt.send(join)
    expect(await host.nextText()).toBe(join)

    host.send(encodeRelayPairClaim({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'pair.claim',
      hostId,
      hostDeviceId,
      pairSessionId,
      joinId,
    }))
    expect(decodeRelayPairClaimed(await host.nextText())).toMatchObject({ pairSessionId, joinId })

    const result = encodePairResultFrame({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'pair.result',
      hostId,
      hostDeviceId,
      pairSessionId,
      joinId,
      seq: 1,
      sentAt: fixedNow,
      expiresAt: fixedNow + 30_000,
      ciphertext: secret(52),
    })
    host.send(result)
    expect(await attempt.nextText()).toBe(result)
    host.send(encodeRelayPairClose({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'pair.close',
      hostId,
      hostDeviceId,
      pairSessionId,
      reason: 'approved',
    }))
    expect(await attempt.waitForClose()).toEqual({ code: 1000, reason: 'pair-complete' })
  })
})
