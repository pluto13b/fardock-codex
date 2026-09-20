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
  decodeRelayReceipt,
  encodeRelayPing,
  encodeEnvelope,
  encodeRelayReceipt,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type P256PublicJwk,
  type RelayReceipt,
} from '@codex-plus/protocol'
import {
  createR3LocalTestRelayServer,
  type R3LocalTestRelayServer,
} from '@codex-plus/relay'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { type RawData } from 'ws'

import {
  R3LoopbackRelayHostClient,
} from '../../windows-agent/src/relay-host-client.ts'
import {
  createR3LoopbackRelayClientCarrierForTest,
  createR3ProductionRelayClientCarrierForTest,
  type R3LoopbackRelayClientCarrier,
  type R3RelayWebSocketFactoryForTest,
} from '../src/relay-carrier.ts'

const testRoot = fileURLToPath(new URL('../../../.tmp/web-relay-carrier-tests/', import.meta.url))
const now = 1_900_000_000_000
const relayOrigin = 'http://127.0.0.1:41742'
const hostId = 'host-web-carrier'
const hostDeviceId = 'device-host-web-carrier'
const clientDeviceId = 'device-client-web-carrier'
const authorizationId = 'authorization-web-carrier'
const bootstrapCredential = Buffer.alloc(32, 91).toString('base64url')

interface SigningIdentity {
  readonly privateKey: KeyObject
  readonly publicKey: P256PublicJwk
  readonly fingerprint: string
}

const servers = new Set<R3LocalTestRelayServer>()
const hosts = new Set<R3LoopbackRelayHostClient>()
const carriers = new Set<R3LoopbackRelayClientCarrier>()
const sockets = new Set<WebSocket>()

function signingIdentity(): SigningIdentity {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) {
    throw new Error('Unexpected test signing key.')
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

function signChallenge(identity: SigningIdentity, input: Uint8Array): Uint8Array {
  return new Uint8Array(sign(
    'sha256',
    input,
    { key: identity.privateKey, dsaEncoding: 'ieee-p1363' },
  ))
}

function secret(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64url')
}

function rawText(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
}

function nodeSocketFactory(
  transformInbound?: (frame: string) => string,
): R3RelayWebSocketFactoryForTest {
  return input => {
    const socket = new WebSocket(input.url, {
      origin: input.relayOrigin,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: input.connectTimeoutMs,
    })
    sockets.add(socket)
    return {
      get readyState() {
        return socket.readyState
      },
      send(frame) {
        socket.send(frame, { binary: false, compress: false })
      },
      close(code, reason) {
        socket.close(code, reason)
      },
      onOpen(listener) {
        socket.on('open', listener)
      },
      onMessage(listener) {
        socket.on('message', (data, isBinary) => {
          if (isBinary) listener(data, true)
          else {
            const frame = rawText(data)
            listener(transformInbound?.(frame) ?? frame, false)
          }
        })
      },
      onError(listener) {
        socket.on('error', listener)
      },
      onClose(listener) {
        socket.on('close', listener)
      },
    }
  }
}

async function startRelay(): Promise<{
  readonly server: R3LocalTestRelayServer
  readonly webSocketUrl: string
}> {
  const server = createR3LocalTestRelayServer({
    mode: 'r3-local-test',
    stateFile: join(testRoot, randomUUID(), 'state.json'),
    relayOrigin,
    bootstrapCredential,
    now: () => now,
  })
  servers.add(server)
  const address = await server.listen({ host: '127.0.0.1' })
  return { server, webSocketUrl: address.webSocketUrl }
}

async function bootstrapHost(
  webSocketUrl: string,
  hostIdentity: SigningIdentity,
  clientIdentity: SigningIdentity,
  onEnvelope: (frame: Uint8Array) => void | Promise<void>,
): Promise<R3LoopbackRelayHostClient> {
  const host = new R3LoopbackRelayHostClient({
    mode: 'r3-local-test',
    webSocketUrl,
    relayOrigin,
    hostId,
    hostDeviceId,
    authentication: {
      kind: 'bootstrap',
      bootstrapCredential,
      hostSigningKey: hostIdentity.publicKey,
      hostSigningFingerprint: hostIdentity.fingerprint,
    },
    signChallenge: input => signChallenge(hostIdentity, input),
    onEnvelope,
    now: () => now,
    connectTimeoutMs: 2_000,
    operationTimeoutMs: 2_000,
  })
  hosts.add(host)
  await host.connect()
  await host.putAuthorization({
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
  })
  return host
}

function createCarrier(
  webSocketUrl: string,
  clientIdentity: SigningIdentity,
  factory = nodeSocketFactory(),
): R3LoopbackRelayClientCarrier {
  const carrier = createR3LoopbackRelayClientCarrierForTest({
    mode: 'r3-local-test',
    webSocketUrl,
    relayOrigin,
    hostId,
    hostDeviceId,
    clientDeviceId,
    authorizationId,
    authorizationEpoch: 1,
    signChallenge: input => signChallenge(clientIdentity, input),
    now: () => now,
    connectTimeoutMs: 2_000,
    receiptTimeoutMs: 2_000,
  }, factory)
  carriers.add(carrier)
  return carrier
}

function clientEnvelope(requestId: string, seq = 2): string {
  return encodeEnvelope({
    protocolVersion: PROTOCOL_VERSION,
    connectionGeneration: 1,
    fromDeviceId: clientDeviceId,
    toDeviceId: hostDeviceId,
    hostId,
    keyId: 'key-client-host',
    requestId,
    seq,
    ack: 1,
    sentAt: now,
    expiresAt: now + 60_000,
    messageType: 'request',
    ciphertext: secret(92),
  })
}

function hostEnvelope(requestId: string, seq = 2): string {
  return encodeEnvelope({
    protocolVersion: PROTOCOL_VERSION,
    connectionGeneration: 1,
    fromDeviceId: hostDeviceId,
    toDeviceId: clientDeviceId,
    hostId,
    keyId: 'key-host-client',
    requestId,
    seq,
    ack: 2,
    sentAt: now,
    expiresAt: now + 60_000,
    messageType: 'response',
    ciphertext: secret(93),
  })
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all([...carriers].map(carrier => carrier.close().catch(() => undefined)))
  carriers.clear()
  await Promise.all([...hosts].map(host => host.close().catch(() => undefined)))
  hosts.clear()
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
  sockets.clear()
  await Promise.all([...servers].map(server => server.close().catch(() => undefined)))
  servers.clear()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('R3 loopback Relay browser carrier', () => {
  it('rejects a ping before device authentication', async () => {
    const relay = await startRelay()
    const socket = new WebSocket(relay.webSocketUrl, { origin: relayOrigin })
    sockets.add(socket)
    const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)))
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    socket.send(encodeRelayPing({ protocolVersion: PROTOCOL_VERSION, relayType: 'device.ping', nonce: 'unauthenticated-probe' }))
    expect(await closed).toBe(4001)
  })
  it('keeps local and production URL profiles runtime-isolated', async () => {
    const identity = signingIdentity()
    const common = {
      hostId,
      hostDeviceId,
      clientDeviceId,
      authorizationId,
      authorizationEpoch: 1,
      signChallenge: (input: Uint8Array) => signChallenge(identity, input),
    }
    expect(() => createR3ProductionRelayClientCarrierForTest({
      ...common,
      mode: 'production',
      webSocketUrl: 'ws://127.0.0.1:443/api/ws',
      relayOrigin: 'https://127.0.0.1',
    }, nodeSocketFactory())).toThrow('invalid-options')
    expect(() => createR3ProductionRelayClientCarrierForTest({
      ...common,
      mode: 'production',
      webSocketUrl: 'wss://other.example.test/api/ws',
      relayOrigin: 'https://relay.example.test',
    }, nodeSocketFactory())).toThrow('invalid-options')
    expect(() => createR3LoopbackRelayClientCarrierForTest({
      ...common,
      mode: 'production',
      webSocketUrl: 'wss://relay.example.test/api/ws',
      relayOrigin: 'https://relay.example.test',
    } as never, nodeSocketFactory())).toThrow('invalid-options')

    const valid = createR3ProductionRelayClientCarrierForTest({
      ...common,
      mode: 'production',
      webSocketUrl: 'wss://relay.example.test/api/ws',
      relayOrigin: 'https://relay.example.test',
    }, nodeSocketFactory())
    carriers.add(valid)
    await valid.close()
  })

  it('authenticates an authorized Client and preserves both raw envelope directions and receipts', async () => {
    const relay = await startRelay()
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    let resolveHostRequest!: (frame: string) => void
    const hostRequest = new Promise<string>(resolve => {
      resolveHostRequest = resolve
    })
    const host = await bootstrapHost(
      relay.webSocketUrl,
      hostIdentity,
      clientIdentity,
      frame => resolveHostRequest(Buffer.from(frame).toString('utf8')),
    )
    const carrier = createCarrier(relay.webSocketUrl, clientIdentity)
    let resolveClientResponse!: (frame: string) => void
    const clientResponse = new Promise<string>(resolve => {
      resolveClientResponse = resolve
    })
    carrier.subscribe(frame => {
      resolveClientResponse(typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8'))
    })
    await carrier.connect()
    expect(await carrier.ping?.()).toBe(true)
    expect(carrier.isConnected?.()).toBe(true)

    const request = clientEnvelope('request-from-web')
    const requestReceipt = await carrier.sendEnvelope(request)
    expect(await hostRequest).toBe(request)
    expect(requestReceipt).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'request-from-web',
      seq: 2,
      state: 'relayed',
    })

    const response = hostEnvelope('response-from-host')
    const responseReceipt = await host.sendEnvelope(response)
    expect(await clientResponse).toBe(response)
    expect(responseReceipt).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'response-from-host',
      seq: 2,
      state: 'relayed',
    })
  })

  it('signals an unexpected authenticated disconnect exactly once', async () => {
    const relay = await startRelay()
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    await bootstrapHost(
      relay.webSocketUrl,
      hostIdentity,
      clientIdentity,
      () => undefined,
    )
    const carrier = createCarrier(relay.webSocketUrl, clientIdentity)
    await carrier.connect()

    const disconnects: string[] = []
    const disconnected = new Promise<void>(resolve => {
      carrier.onUnexpectedDisconnect(error => {
        disconnects.push(error.code)
        resolve()
      })
    })
    await relay.server.close()
    servers.delete(relay.server)
    await disconnected

    expect(disconnects).toEqual(['connection-closed'])
    await carrier.close()
    expect(disconnects).toEqual(['connection-closed'])
  })

  it('does not signal an intentional close', async () => {
    const relay = await startRelay()
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    await bootstrapHost(
      relay.webSocketUrl,
      hostIdentity,
      clientIdentity,
      () => undefined,
    )
    const carrier = createCarrier(relay.webSocketUrl, clientIdentity)
    await carrier.connect()
    const disconnects: string[] = []
    carrier.onUnexpectedDisconnect(error => disconnects.push(error.code))

    await carrier.close()

    expect(disconnects).toEqual([])
  })

  it('fails closed when a Relay receipt does not match generation/requestId/seq', async () => {
    const relay = await startRelay()
    const hostIdentity = signingIdentity()
    const clientIdentity = signingIdentity()
    await bootstrapHost(
      relay.webSocketUrl,
      hostIdentity,
      clientIdentity,
      () => undefined,
    )
    const carrier = createCarrier(
      relay.webSocketUrl,
      clientIdentity,
      nodeSocketFactory(frame => {
        let receipt: RelayReceipt
        try {
          receipt = decodeRelayReceipt(frame)
        } catch {
          return frame
        }
        return encodeRelayReceipt({ ...receipt, seq: receipt.seq + 1 })
      }),
    )
    await carrier.connect()

    await expect(carrier.sendEnvelope(clientEnvelope('mismatched-receipt'))).rejects.toMatchObject({
      name: 'R3RelayClientCarrierError',
      code: 'protocol-violation',
    })
    await expect(carrier.sendEnvelope(clientEnvelope('after-failure', 3))).rejects.toMatchObject({
      code: 'invalid-state',
    })
  })
})
