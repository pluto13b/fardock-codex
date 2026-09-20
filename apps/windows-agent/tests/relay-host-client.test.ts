import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeRelayDeviceChallenge,
  decodeRelayDeviceWelcome,
  decodeRelayReceipt,
  encodeEnvelope,
  encodeRelayDeviceHello,
  encodeRelayDeviceProof,
  encodeRelayDeviceProofSignatureInput,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type P256PublicJwk,
  type RelayDeviceChallenge,
  type RelayReceipt,
} from '../../../packages/protocol/src/index.ts'
import {
  createR3LocalTestRelayServer,
  type R3LocalTestRelayServer,
} from '../../../services/relay/src/index.ts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { type RawData } from 'ws'

import {
  R3LoopbackRelayHostClient,
  R3ProductionRelayHostClient,
  type R3RelayHostAuthentication,
} from '../src/relay-host-client.ts'

const testRoot = fileURLToPath(new URL('../../../.tmp/windows-agent-relay-tests/', import.meta.url))
const now = 1_900_000_000_000
const relayOrigin = 'http://127.0.0.1:41741'
const hostId = 'host-windows-relay'
const hostDeviceId = 'device-windows-relay'
const clientDeviceId = 'device-client-relay'
const authorizationId = 'authorization-windows-relay'
const bootstrapCredential = Buffer.alloc(32, 71).toString('base64url')

interface SigningIdentity {
  readonly privateKey: KeyObject
  readonly publicKey: P256PublicJwk
  readonly fingerprint: string
}

interface ReceivedFrame {
  readonly bytes: Buffer
  readonly isBinary: boolean
}

const servers = new Set<R3LocalTestRelayServer>()
const hosts = new Set<R3LoopbackRelayHostClient>()
const peers = new Set<TestPeer>()

function signingIdentity(): SigningIdentity {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) {
    throw new Error('Unexpected test key.')
  }
  const publicKey: P256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x,
    y: exported.y,
  }
  const thumbprint = JSON.stringify({
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  })
  return {
    privateKey: pair.privateKey,
    publicKey,
    fingerprint: createHash('sha256').update(thumbprint).digest('base64url'),
  }
}

function secret(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url')
}

function signChallenge(identity: SigningIdentity, input: Uint8Array): Uint8Array {
  return new Uint8Array(sign(
    'sha256',
    input,
    { key: identity.privateKey, dsaEncoding: 'ieee-p1363' },
  ))
}

function copyRawData(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

class TestPeer {
  private readonly queued: ReceivedFrame[] = []
  private readonly waiters: Array<{
    readonly resolve: (frame: ReceivedFrame) => void
    readonly reject: (error: Error) => void
    readonly timer: NodeJS.Timeout
  }> = []

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      const frame = { bytes: copyRawData(data), isBinary: isBinary === true }
      const waiter = this.waiters.shift()
      if (waiter === undefined) this.queued.push(frame)
      else {
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
      }
    })
    socket.on('error', () => {
      // Tests assert stable protocol-visible failures instead of platform socket errors.
    })
  }

  send(frame: string | Uint8Array): void {
    this.socket.send(frame, { binary: false })
  }

  async nextText(timeoutMs = 2_000): Promise<string> {
    const queued = this.queued.shift()
    const frame = queued ?? await new Promise<ReceivedFrame>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(new Error('Timed out waiting for a Relay test frame.'))
        }, timeoutMs),
      }
      this.waiters.push(waiter)
    })
    expect(frame.isBinary).toBe(false)
    return frame.bytes.toString('utf8')
  }

  terminate(): void {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate()
  }
}

async function startRelay(stateFile = join(testRoot, randomUUID(), 'state.json')): Promise<{
  readonly server: R3LocalTestRelayServer
  readonly stateFile: string
  readonly webSocketUrl: string
}> {
  const server = createR3LocalTestRelayServer({
    mode: 'r3-local-test',
    stateFile,
    relayOrigin,
    bootstrapCredential,
    now: () => now,
  })
  servers.add(server)
  const address = await server.listen({ host: '127.0.0.1' })
  return { server, stateFile, webSocketUrl: address.webSocketUrl }
}

function createHost(
  webSocketUrl: string,
  identity: SigningIdentity,
  authentication: R3RelayHostAuthentication,
  onEnvelope: (frame: Uint8Array) => void | Promise<void>,
  connectTimeoutMs = 2_000,
): R3LoopbackRelayHostClient {
  const host = new R3LoopbackRelayHostClient({
    mode: 'r3-local-test',
    webSocketUrl,
    relayOrigin,
    hostId,
    hostDeviceId,
    authentication,
    signChallenge: input => signChallenge(identity, input),
    onEnvelope,
    now: () => now,
    connectTimeoutMs,
    operationTimeoutMs: 2_000,
  })
  hosts.add(host)
  return host
}

async function connectClient(webSocketUrl: string): Promise<TestPeer> {
  const socket = new WebSocket(webSocketUrl, {
    origin: relayOrigin,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
  })
  const peer = new TestPeer(socket)
  peers.add(peer)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('Client test socket failed.')))
  })
  return peer
}

async function authenticateClient(peer: TestPeer, identity: SigningIdentity): Promise<void> {
  peer.send(encodeRelayDeviceHello({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.hello',
    relayOrigin,
    role: 'client',
    authMode: 'challenge',
    hostId,
    hostDeviceId,
    deviceId: clientDeviceId,
    authorizationId,
    authorizationEpoch: 1,
  }))
  const challenge = decodeRelayDeviceChallenge(await peer.nextText(), relayOrigin, now)
  if (challenge.role !== 'client') throw new Error('Unexpected Host challenge.')
  peer.send(proofForClient(challenge, identity))
  expect(decodeRelayDeviceWelcome(await peer.nextText(), relayOrigin)).toMatchObject({
    role: 'client',
    hostId,
    hostDeviceId,
    deviceId: clientDeviceId,
    authorizationId,
    authorizationEpoch: 1,
  })
}

function proofForClient(challenge: RelayDeviceChallenge, identity: SigningIdentity): string {
  if (challenge.role !== 'client') throw new Error('Expected a Client challenge.')
  return encodeRelayDeviceProof({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.proof',
    relayOrigin,
    role: 'client',
    authMode: 'challenge',
    hostId,
    hostDeviceId,
    deviceId: clientDeviceId,
    authorizationId,
    authorizationEpoch: 1,
    challengeId: challenge.challengeId,
    signature: Buffer.from(signChallenge(
      identity,
      encodeRelayDeviceProofSignatureInput(challenge),
    )).toString('base64url'),
  })
}

function bootstrapAuthentication(identity: SigningIdentity): R3RelayHostAuthentication {
  return {
    kind: 'bootstrap',
    bootstrapCredential,
    hostSigningKey: identity.publicKey,
    hostSigningFingerprint: identity.fingerprint,
  }
}

async function authorizeClient(
  host: R3LoopbackRelayHostClient,
  clientIdentity: SigningIdentity,
): Promise<void> {
  expect(await host.putAuthorization({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'authorization.put',
    hostId,
    hostDeviceId,
    clientDeviceId,
    authorizationId,
    authorizationEpoch: 1,
    hostAuthorizationRevision: 1,
    status: 'active',
    clientSigningKey: clientIdentity.publicKey,
    clientSigningFingerprint: clientIdentity.fingerprint,
  })).toMatchObject({
    relayType: 'authorization.applied',
    status: 'active',
    hostAuthorizationRevision: 1,
  })
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all([...hosts].map(host => host.close().catch(() => undefined)))
  hosts.clear()
  for (const peer of peers) peer.terminate()
  peers.clear()
  await Promise.all([...servers].map(server => server.close().catch(() => undefined)))
  servers.clear()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('R3 loopback Relay Host client', () => {
  it('keeps local and production URL profiles runtime-isolated', async () => {
    const identity = signingIdentity()
    const common = {
      hostId,
      hostDeviceId,
      authentication: {
        kind: 'bootstrap' as const,
        bootstrapCredential,
        hostSigningKey: identity.publicKey,
        hostSigningFingerprint: identity.fingerprint,
      },
      signChallenge: (input: Uint8Array) => signChallenge(identity, input),
      onEnvelope: () => undefined,
    }
    expect(() => new R3ProductionRelayHostClient({
      ...common,
      mode: 'production',
      webSocketUrl: 'ws://127.0.0.1:443/api/ws',
      relayOrigin: 'https://127.0.0.1',
    })).toThrow('invalid-options')
    expect(() => new R3ProductionRelayHostClient({
      ...common,
      mode: 'production',
      webSocketUrl: 'wss://other.example.test/api/ws',
      relayOrigin: 'https://relay.example.test',
    })).toThrow('invalid-options')
    expect(() => new R3LoopbackRelayHostClient({
      ...common,
      mode: 'production',
      webSocketUrl: 'wss://relay.example.test/api/ws',
      relayOrigin: 'https://relay.example.test',
    } as never)).toThrow('invalid-options')

    const valid = new R3ProductionRelayHostClient({
      ...common,
      mode: 'production',
      webSocketUrl: 'wss://relay.example.test/api/ws',
      relayOrigin: 'https://relay.example.test',
    })
    await valid.close()
  })

  it('subscribes only while ready and signals an unexpected Relay close exactly once', async () => {
    const identity = signingIdentity()
    const relay = await startRelay()
    const host = createHost(
      relay.webSocketUrl,
      identity,
      bootstrapAuthentication(identity),
      () => undefined,
    )
    expect(() => host.onUnexpectedDisconnect(() => undefined)).toThrow(
      expect.objectContaining({ code: 'invalid-state' }),
    )
    await host.connect()

    const disconnects: string[] = []
    const disconnected = new Promise<void>(resolve => {
      host.onUnexpectedDisconnect(error => {
        disconnects.push(error.code)
        resolve()
      })
    })
    await relay.server.close()
    servers.delete(relay.server)
    await disconnected

    expect(disconnects).toEqual(['connection-closed'])
    expect(() => host.onUnexpectedDisconnect(() => undefined)).toThrow(
      expect.objectContaining({ code: 'invalid-state' }),
    )
    await host.close()
    expect(disconnects).toEqual(['connection-closed'])
  })

  it('isolates disconnect listener exceptions and notifies once on a ready-state failure', async () => {
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    const relay = await startRelay()
    const host = createHost(
      relay.webSocketUrl,
      hostIdentity,
      bootstrapAuthentication(hostIdentity),
      () => {
        throw new Error('handler failure')
      },
    )
    await host.connect()
    await authorizeClient(host, clientIdentity)
    const client = await connectClient(relay.webSocketUrl)
    await authenticateClient(client, clientIdentity)

    const disconnects: string[] = []
    host.onUnexpectedDisconnect(error => {
      disconnects.push(error.code)
      throw new Error('observer failure')
    })
    const disconnected = new Promise<void>(resolve => {
      host.onUnexpectedDisconnect(error => {
        disconnects.push(error.code)
        resolve()
      })
    })
    client.send(encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      requestId: 'handler-failure',
      seq: 2,
      ack: 1,
      sentAt: now,
      expiresAt: now + 60_000,
      messageType: 'request',
      ciphertext: secret(85),
    }))
    await disconnected

    expect(disconnects).toEqual(['handler-failed', 'handler-failed'])
    await expect(host.sendEnvelope(encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: hostDeviceId,
      toDeviceId: clientDeviceId,
      hostId,
      keyId: 'key-host-client',
      requestId: 'after-handler-failure',
      seq: 2,
      ack: 1,
      sentAt: now,
      expiresAt: now + 60_000,
      messageType: 'response',
      ciphertext: secret(86),
    }))).rejects.toMatchObject({ code: 'invalid-state' })
    await host.close()
    expect(disconnects).toEqual(['handler-failed', 'handler-failed'])
  })

  it('clears disconnect listeners without notification on an intentional close', async () => {
    const identity = signingIdentity()
    const relay = await startRelay()
    const host = createHost(
      relay.webSocketUrl,
      identity,
      bootstrapAuthentication(identity),
      () => undefined,
    )
    await host.connect()
    const disconnects: string[] = []
    host.onUnexpectedDisconnect(error => disconnects.push(error.code))

    await host.close()
    await relay.server.close()
    servers.delete(relay.server)

    expect(disconnects).toEqual([])
  })

  it('bootstraps, resumes, authorizes a Client, and preserves both routed frame directions', async () => {
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    const firstRelay = await startRelay()
    const bootstrapHost = createHost(
      firstRelay.webSocketUrl,
      hostIdentity,
      bootstrapAuthentication(hostIdentity),
      () => undefined,
    )
    await bootstrapHost.connect()
    await authorizeClient(bootstrapHost, clientIdentity)
    await bootstrapHost.close()
    await firstRelay.server.close()

    const secondRelay = await startRelay(firstRelay.stateFile)
    const receivedByHandler: Buffer[] = []
    let handlerReceipt: RelayReceipt | undefined
    let resolveHandled!: () => void
    const handled = new Promise<void>(resolve => {
      resolveHandled = resolve
    })
    const response = encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: hostDeviceId,
      toDeviceId: clientDeviceId,
      hostId,
      keyId: 'key-host-client',
      requestId: 'response-from-host',
      seq: 2,
      ack: 2,
      sentAt: now,
      expiresAt: now + 60_000,
      messageType: 'response',
      ciphertext: secret(82),
    })
    let resumedHost!: R3LoopbackRelayHostClient
    resumedHost = createHost(
      secondRelay.webSocketUrl,
      hostIdentity,
      { kind: 'resume' },
      async rawFrame => {
        receivedByHandler.push(Buffer.from(rawFrame))
        handlerReceipt = await resumedHost.sendEnvelope(response)
        resolveHandled()
      },
    )
    await resumedHost.connect()

    const client = await connectClient(secondRelay.webSocketUrl)
    await authenticateClient(client, clientIdentity)
    const request = encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: clientDeviceId,
      toDeviceId: hostDeviceId,
      hostId,
      keyId: 'key-client-host',
      requestId: 'request-from-client',
      seq: 2,
      ack: 1,
      sentAt: now,
      expiresAt: now + 60_000,
      messageType: 'request',
      ciphertext: secret(81),
    })
    client.send(request)

    const clientFrames = [await client.nextText(), await client.nextText()]
    expect(clientFrames).toContain(response)
    const requestReceiptFrame = clientFrames.find(frame => frame !== response)
    expect(requestReceiptFrame).toBeDefined()
    expect(decodeRelayReceipt(requestReceiptFrame!)).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'request-from-client',
      seq: 2,
      state: 'relayed',
    })
    await handled
    expect(receivedByHandler).toHaveLength(1)
    expect(receivedByHandler[0]?.equals(Buffer.from(request))).toBe(true)
    expect(handlerReceipt).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'response-from-host',
      seq: 2,
      state: 'relayed',
    })

    await resumedHost.close()
    await expect(resumedHost.sendEnvelope(response)).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('fails closed when the bounded inbound handler queue overflows', async () => {
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    const relay = await startRelay()
    let releaseHandler!: () => void
    const handlerGate = new Promise<void>(resolve => {
      releaseHandler = resolve
    })
    let handlerCalls = 0
    const host = createHost(
      relay.webSocketUrl,
      hostIdentity,
      bootstrapAuthentication(hostIdentity),
      async () => {
        handlerCalls += 1
        await handlerGate
      },
    )
    await host.connect()
    await authorizeClient(host, clientIdentity)
    const client = await connectClient(relay.webSocketUrl)
    await authenticateClient(client, clientIdentity)

    for (let index = 0; index < 17; index += 1) {
      const frame = encodeEnvelope({
        protocolVersion: PROTOCOL_VERSION,
        connectionGeneration: 1,
        fromDeviceId: clientDeviceId,
        toDeviceId: hostDeviceId,
        hostId,
        keyId: 'key-client-host',
        requestId: `queued-request-${index + 1}`,
        seq: index + 2,
        ack: 1,
        sentAt: now,
        expiresAt: now + 60_000,
        messageType: 'request',
        ciphertext: secret(83),
      })
      client.send(frame)
      expect(decodeRelayReceipt(await client.nextText())).toMatchObject({
        requestId: `queued-request-${index + 1}`,
        state: 'relayed',
      })
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    releaseHandler()
    expect(handlerCalls).toBe(1)
    const outbound = encodeEnvelope({
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: 1,
      fromDeviceId: hostDeviceId,
      toDeviceId: clientDeviceId,
      hostId,
      keyId: 'key-host-client',
      requestId: 'after-overflow',
      seq: 2,
      ack: 1,
      sentAt: now,
      expiresAt: now + 60_000,
      messageType: 'response',
      ciphertext: secret(84),
    })
    await expect(host.sendEnvelope(outbound)).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('rejects non-loopback configuration and bounds a stalled authentication attempt', async () => {
    const identity = signingIdentity()
    expect(() => new R3LoopbackRelayHostClient({
      mode: 'r3-local-test',
      webSocketUrl: 'ws://localhost:1234/api/ws',
      relayOrigin,
      hostId,
      hostDeviceId,
      authentication: bootstrapAuthentication(identity),
      signChallenge: input => signChallenge(identity, input),
      onEnvelope: () => undefined,
    })).toThrow(expect.objectContaining({ code: 'invalid-options' }))

    const relay = await startRelay()
    const stalled = new R3LoopbackRelayHostClient({
      mode: 'r3-local-test',
      webSocketUrl: relay.webSocketUrl,
      relayOrigin,
      hostId,
      hostDeviceId,
      authentication: bootstrapAuthentication(identity),
      signChallenge: () => new Promise<never>(() => undefined),
      onEnvelope: () => undefined,
      now: () => now,
      connectTimeoutMs: 50,
      operationTimeoutMs: 100,
    })
    hosts.add(stalled)
    await expect(stalled.connect()).rejects.toMatchObject({ code: 'connect-timeout' })
    await stalled.close()
  })
})
