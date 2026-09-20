import {
  createHash,
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { win32 as windowsPath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  acceptClientSessionConfirm,
  acceptHostSessionReady,
  approveHostPairing,
  createClientPairJoin,
  createClientSessionConfirm,
  createClientSessionInit,
  createHostPairingInvitation,
  createHostSessionAccept,
  createHostSessionReady,
  deriveClientSessionAfterGenerationCommit,
  exportPublicJwk,
  fingerprintP256PublicKey,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  getEstablishedSessionChannelInfo,
  openEstablishedApplication,
  openClientPairResult,
  openHostPairJoin,
  sealEstablishedApplication,
  validateSessionAcceptForClient,
  validateSessionInitForHost,
  type EstablishedSessionChannel,
} from '../../../packages/e2ee/src/index.ts'
import {
  decodeRelayDeviceChallenge,
  decodeRelayDeviceWelcome,
  decodeRelayAuthorizationApplied,
  decodeRelayReceipt,
  encodeRelayAuthorizationPut,
  encodeRelayDeviceHello,
  encodeRelayDeviceProof,
  encodeRelayDeviceProofSignatureInput,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type EnvelopeHeader,
  type P256PublicJwk,
  type RelayDeviceChallenge,
  type RelayReceipt,
} from '../../../packages/protocol/src/index.ts'
import {
  createOwnerPasswordVerifier,
  createProductionGateway,
  createR3LocalTestRelayServer,
  type ProductionGateway,
  type R3LocalTestRelayServer,
} from '../../../services/relay/src/index.ts'
import {
  startTestTlsReverseProxy,
  type TestTlsReverseProxy,
} from '../../../services/relay/tests/helpers/tls-reverse-proxy.ts'
import { createTransportCodexServeClient } from '../../../packages/codex-serve-client/src/index.ts'
import WebSocket, { type RawData } from 'ws'
import {
  APP_SERVER_METHODS,
  AppServerReadProjection,
  AppServerSupervisor,
  createWindowsCompanionReadySessionHandler,
  type Notification,
} from '../src/index.ts'
import {
  establishEphemeralClientSession,
  pairEphemeralClientForTest,
  signEphemeralClientRelayChallenge,
} from '../../codex-web/src/pairing-session-runtime.ts'
import {
  createR3LoopbackRelayClientCarrierForTest,
  createR3ProductionRelayClientCarrierForTest,
  type R3RelayClientCarrier,
  type R3RelayWebSocketFactoryForTest,
} from '../../codex-web/src/relay-carrier.ts'
import { createRelayCodexServeTransport } from '../../codex-web/src/relay-transport.ts'
import { dispatchEncryptedTextAction } from '../src/e2ee-action-bridge.ts'
import { sealEncryptedActionReceipt } from '../src/e2ee-action-response.ts'
import { dispatchEncryptedReadRequest } from '../src/e2ee-read-bridge.ts'
import { dispatchEncryptedHostRequest } from '../src/host-dispatcher.ts'
import { createEphemeralHostPairingRuntime } from '../src/pairing-session-runtime.ts'
import { createLiveRequestAuthority } from '../src/live-request-authority.ts'
import { startBoundTextTurn } from '../src/turn-runtime.ts'
import {
  createActionState,
  type ActionStateStore,
} from '../src/action-state.ts'
import { establishRuntimeCompatibilityForTest } from '../src/runtime-binding.ts'
import { WindowsAnchoredActionState } from '../src/windows-action-state-store.ts'
import { latencyStatistics } from './helpers/latency-statistics.ts'
import {
  createR3ProductionRelayHostClientForTest,
  R3LoopbackRelayHostClient,
  R3ProductionRelayHostClient,
  type R3RelayHostClient,
  type R3RelayHostWebSocketFactoryForTest,
  type R3RelayHostAuthentication,
} from '../src/relay-host-client.ts'

const NOW = 1_800_000_000_000
const WORKSPACE_ROOT = windowsPath.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = windowsPath.join(WORKSPACE_ROOT, '.tmp', 'windows-agent-tests')
const fakeChild = fileURLToPath(new URL('./fixtures/fake-turn-app-server.mjs', import.meta.url))
const fakeReadChild = fileURLToPath(new URL('./fixtures/fake-read-app-server.mjs', import.meta.url))

let caseDirectory = ''
let stores: ActionStateStore[] = []
let anchoredStores: WindowsAnchoredActionState[] = []
let supervisors: AppServerSupervisor[] = []
let relayServers: Array<R3LocalTestRelayServer | ProductionGateway> = []
let relayHosts: R3RelayHostClient[] = []
let relayPeers: TestPeer[] = []
let relayCarriers: R3RelayClientCarrier[] = []
let relayCarrierSockets: WebSocket[] = []
let tlsProxies: TestTlsReverseProxy[] = []

const RELAY_ORIGIN = 'http://127.0.0.1:41743'
const PRODUCTION_RELAY_ORIGIN = 'https://relay.example.test'
const BOOTSTRAP_CREDENTIAL = Buffer.alloc(32, 0x72).toString('base64url')

interface SigningIdentity {
  readonly privateKey: KeyObject
  readonly publicKey: P256PublicJwk
  readonly fingerprint: string
}

interface ReceivedFrame {
  readonly bytes: Buffer
  readonly isBinary: boolean
}

function signingIdentity(): SigningIdentity {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) {
    throw new Error('Unexpected Relay test key.')
  }
  const publicKey: P256PublicJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x,
    y: exported.y,
  }
  return {
    privateKey: pair.privateKey,
    publicKey,
    fingerprint: createHash('sha256').update(JSON.stringify({
      crv: publicKey.crv,
      kty: publicKey.kty,
      x: publicKey.x,
      y: publicKey.y,
    })).digest('base64url'),
  }
}

function signChallenge(identity: SigningIdentity, input: Uint8Array): Uint8Array {
  return new Uint8Array(sign(
    'sha256',
    input,
    { key: identity.privateKey, dsaEncoding: 'ieee-p1363' },
  ))
}

async function signCryptoChallenge(key: CryptoKey, input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new Uint8Array(input),
  ))
}

function copyRawData(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

function nodeRelaySocketFactory(): R3RelayWebSocketFactoryForTest {
  return input => {
    const socket = new WebSocket(input.url, {
      origin: input.relayOrigin,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: input.connectTimeoutMs,
    })
    relayCarrierSockets.push(socket)
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
          listener(isBinary ? data : copyRawData(data).toString('utf8'), isBinary)
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
    socket.on('error', () => undefined)
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

async function startRelay(): Promise<{
  readonly server: R3LocalTestRelayServer
  readonly webSocketUrl: string
}> {
  const server = createR3LocalTestRelayServer({
    mode: 'r3-local-test',
    stateFile: windowsPath.join(caseDirectory, 'relay-state.json'),
    relayOrigin: RELAY_ORIGIN,
    bootstrapCredential: BOOTSTRAP_CREDENTIAL,
    now: () => NOW + 501,
  })
  relayServers.push(server)
  const address = await server.listen({ host: '127.0.0.1' })
  return { server, webSocketUrl: address.webSocketUrl }
}

function deferred<T>(): Readonly<{
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function nodeProductionRelaySocketFactory(
  certificate: string,
  ownerCookie: string,
): R3RelayWebSocketFactoryForTest {
  return input => {
    const socket = new WebSocket(input.url, {
      origin: input.relayOrigin,
      ca: certificate,
      rejectUnauthorized: true,
      followRedirects: false,
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: input.connectTimeoutMs,
      headers: { cookie: ownerCookie },
    })
    relayCarrierSockets.push(socket)
    return {
      get readyState() { return socket.readyState },
      send(frame) { socket.send(frame, { binary: false, compress: false }) },
      close(code, reason) { socket.close(code, reason) },
      onOpen(listener) { socket.on('open', listener) },
      onMessage(listener) {
        socket.on('message', (data, isBinary) => {
          listener(isBinary ? data : copyRawData(data).toString('utf8'), isBinary)
        })
      },
      onError(listener) { socket.on('error', listener) },
      onClose(listener) { socket.on('close', listener) },
    }
  }
}

function nodeProductionHostSocketFactory(
  certificate: string,
): R3RelayHostWebSocketFactoryForTest {
  return input => new WebSocket(input.url, {
    origin: input.relayOrigin,
    ca: certificate,
    rejectUnauthorized: true,
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    handshakeTimeout: input.connectTimeoutMs,
  })
}

async function trustedHttpsGet(
  url: string,
  certificate: string,
): Promise<Readonly<{ status: number; body: string }>> {
  return await new Promise((resolve, reject) => {
    const request = httpsGet(url, {
      ca: certificate,
      rejectUnauthorized: true,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({
        status: response.statusCode ?? 500,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
  })
}

async function redeemTestPairingCode(tls: { publicOrigin: string; proxy: TestTlsReverseProxy; ownerCookie: string }, code: string, cookie = tls.ownerCookie) {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify({ code })
    const request = httpsRequest(`${tls.publicOrigin}/api/pairing-code/redeem`, {
      method: 'POST', ca: tls.proxy.certificate, rejectUnauthorized: true,
      headers: { origin: tls.publicOrigin, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 500, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function startProductionGateway(
  publicOrigin = PRODUCTION_RELAY_ORIGIN,
  bootstrapCredential = BOOTSTRAP_CREDENTIAL,
  now = () => NOW + 501,
): Promise<{
  readonly server: ProductionGateway
  readonly httpOrigin: string
  readonly webSocketUrl: string
  readonly ownerCookie: string
}> {
  const webRoot = windowsPath.join(caseDirectory, 'production-web')
  const bootstrapFile = windowsPath.join(caseDirectory, 'production-relay-bootstrap')
  const ownerVerifierFile = windowsPath.join(caseDirectory, 'production-owner-verifier.json')
  mkdirSync(windowsPath.join(webRoot, 'assets'), { recursive: true })
  writeFileSync(
    windowsPath.join(webRoot, 'index.html'),
    '<!doctype html><title>Codex Plus</title><div id="root"></div><script type="module" src="/assets/app.js"></script>',
    'utf8',
  )
  writeFileSync(
    windowsPath.join(webRoot, 'assets', 'app.js'),
    'globalThis.__PRODUCTION_GATEWAY_TEST__=true',
    'utf8',
  )
  writeFileSync(bootstrapFile, bootstrapCredential, 'utf8')
  const ownerVerifier = await createOwnerPasswordVerifier({
    username: 'owner',
    password: 'test owner password',
  }, () => Buffer.alloc(16, 6))
  writeFileSync(ownerVerifierFile, JSON.stringify(ownerVerifier), 'utf8')
  const server = await createProductionGateway({
    mode: 'production',
    bind: '127.0.0.1',
    port: 0,
    publicOrigin,
    trustedProxyIps: ['127.0.0.1'],
    stateFile: windowsPath.join(caseDirectory, 'production-relay-state.json'),
    webRoot,
    bootstrapCredential,
    bootstrapCredentialFile: bootstrapFile,
    ownerVerifier,
    ownerVerifierFile,
    logLevel: 'info',
  }, {
    now,
  })
  relayServers.push(server)
  const address = await server.listen()
  const ownerCookie = await new Promise<string>((resolveCookie, reject) => {
    const body = JSON.stringify({ username: 'owner', password: 'test owner password' })
    const origin = new URL(publicOrigin)
    const request = httpRequest({
      host: new URL(address.httpOrigin).hostname,
      port: new URL(address.httpOrigin).port,
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        host: origin.host,
        origin: publicOrigin,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': origin.host,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, response => {
      response.resume()
      response.once('end', () => {
        const cookie = response.headers['set-cookie']?.[0]?.split(';', 1)[0]
        if (response.statusCode !== 200 || cookie === undefined) reject(new Error('owner-login-failed'))
        else resolveCookie(cookie)
      })
    })
    request.once('error', reject)
    request.end(body)
  })
  return { server, httpOrigin: address.httpOrigin, webSocketUrl: address.webSocketUrl, ownerCookie }
}

async function startProductionTlsGateway(
  bootstrapCredential = BOOTSTRAP_CREDENTIAL,
  now = () => NOW + 501,
): Promise<Readonly<{
  proxy: TestTlsReverseProxy
  publicOrigin: string
  webSocketUrl: string
  ownerCookie: string
}>> {
  const proxy = await startTestTlsReverseProxy()
  tlsProxies.push(proxy)
  const gateway = await startProductionGateway(proxy.httpsOrigin, bootstrapCredential, now)
  proxy.setTargetPort(Number(new URL(gateway.httpOrigin).port))
  return {
    proxy,
    publicOrigin: proxy.httpsOrigin,
    webSocketUrl: proxy.webSocketUrl,
    ownerCookie: gateway.ownerCookie,
  }
}

async function connectRelayClient(
  webSocketUrl: string,
  relayOrigin = RELAY_ORIGIN,
  ownerCookie?: string,
): Promise<TestPeer> {
  const productionHost = relayOrigin.startsWith('https:')
    ? new URL(relayOrigin).host
    : undefined
  const socket = new WebSocket(webSocketUrl, {
    origin: relayOrigin,
    ...(productionHost === undefined ? {} : {
      headers: {
        host: productionHost,
        'x-forwarded-proto': 'https',
        'x-forwarded-host': productionHost,
        ...(ownerCookie === undefined ? {} : { cookie: ownerCookie }),
      },
    }),
    followRedirects: false,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
  })
  const peer = new TestPeer(socket)
  relayPeers.push(peer)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('Relay Client socket failed.')))
  })
  return peer
}

function clientProof(
  challenge: RelayDeviceChallenge,
  identity: SigningIdentity,
): string {
  if (challenge.role !== 'client') throw new Error('Expected a Client challenge.')
  return encodeRelayDeviceProof({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.proof',
    relayOrigin: challenge.relayOrigin,
    role: 'client',
    authMode: 'challenge',
    hostId: challenge.hostId,
    hostDeviceId: challenge.hostDeviceId,
    deviceId: challenge.deviceId,
    authorizationId: challenge.authorizationId,
    authorizationEpoch: challenge.authorizationEpoch,
    challengeId: challenge.challengeId,
    signature: Buffer.from(signChallenge(
      identity,
      encodeRelayDeviceProofSignatureInput(challenge),
    )).toString('base64url'),
  })
}

function bootstrapHostProof(
  challenge: RelayDeviceChallenge,
  identity: SigningIdentity,
): string {
  if (challenge.role !== 'host' || challenge.authMode !== 'bootstrap') {
    throw new Error('Expected a Host bootstrap challenge.')
  }
  return encodeRelayDeviceProof({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.proof',
    relayOrigin: challenge.relayOrigin,
    role: 'host',
    authMode: 'bootstrap',
    hostId: challenge.hostId,
    hostDeviceId: challenge.hostDeviceId,
    deviceId: challenge.deviceId,
    hostSigningFingerprint: challenge.hostSigningFingerprint,
    challengeId: challenge.challengeId,
    signature: Buffer.from(signChallenge(
      identity,
      encodeRelayDeviceProofSignatureInput(challenge),
    )).toString('base64url'),
  })
}

async function authenticateProductionHost(
  peer: TestPeer,
  identity: SigningIdentity,
  authority: Readonly<{ hostId: string; hostDeviceId: string }>,
): Promise<void> {
  peer.send(encodeRelayDeviceHello({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.hello',
    relayOrigin: PRODUCTION_RELAY_ORIGIN,
    role: 'host',
    authMode: 'bootstrap',
    hostId: authority.hostId,
    hostDeviceId: authority.hostDeviceId,
    deviceId: authority.hostDeviceId,
    bootstrapCredential: BOOTSTRAP_CREDENTIAL,
    hostSigningKey: identity.publicKey,
    hostSigningFingerprint: identity.fingerprint,
  }))
  const challenge = decodeRelayDeviceChallenge(
    await peer.nextText(), PRODUCTION_RELAY_ORIGIN, NOW + 501,
  )
  peer.send(bootstrapHostProof(challenge, identity))
  expect(decodeRelayDeviceWelcome(
    await peer.nextText(), PRODUCTION_RELAY_ORIGIN,
  )).toMatchObject({
    role: 'host',
    authMode: 'bootstrap',
    hostId: authority.hostId,
    hostDeviceId: authority.hostDeviceId,
    deviceId: authority.hostDeviceId,
  })
}

async function authenticateRelayClient(
  peer: TestPeer,
  identity: SigningIdentity,
  authority: Readonly<{
    hostId: string
    hostDeviceId: string
    clientDeviceId: string
    authorizationId: string
    authorizationEpoch: number
  }>,
  relayOrigin = RELAY_ORIGIN,
): Promise<void> {
  peer.send(encodeRelayDeviceHello({
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'device.hello',
    relayOrigin,
    role: 'client',
    authMode: 'challenge',
    hostId: authority.hostId,
    hostDeviceId: authority.hostDeviceId,
    deviceId: authority.clientDeviceId,
    authorizationId: authority.authorizationId,
    authorizationEpoch: authority.authorizationEpoch,
  }))
  const challenge = decodeRelayDeviceChallenge(
    await peer.nextText(), relayOrigin, NOW + 501,
  )
  peer.send(clientProof(challenge, identity))
  expect(decodeRelayDeviceWelcome(await peer.nextText(), relayOrigin)).toMatchObject({
    role: 'client',
    hostId: authority.hostId,
    hostDeviceId: authority.hostDeviceId,
    deviceId: authority.clientDeviceId,
    authorizationId: authority.authorizationId,
    authorizationEpoch: authority.authorizationEpoch,
  })
}

function bootstrapAuthentication(identity: SigningIdentity): R3RelayHostAuthentication {
  return {
    kind: 'bootstrap',
    bootstrapCredential: BOOTSTRAP_CREDENTIAL,
    hostSigningKey: identity.publicKey,
    hostSigningFingerprint: identity.fingerprint,
  }
}

async function establishChannels(): Promise<{
  client: EstablishedSessionChannel
  host: EstablishedSessionChannel
}> {
  const [hostAgreement, hostSigning] = await Promise.all([
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const invitation = await createHostPairingInvitation({
    relayOrigin: 'https://relay.example.test',
    hostId: 'host.bridge',
    hostDeviceId: 'device.windows',
    hostAgreementPublicKey: hostAgreement.publicKey,
    hostSigningPrivateKey: hostSigning.privateKey,
    hostSigningPublicKey: hostSigning.publicKey,
    now: NOW,
    clock: () => NOW + 200,
  })
  const join = await createClientPairJoin({
    invitationFragment: invitation.invitationFragment,
    expectedRelayOrigin: 'https://relay.example.test',
    deviceDisplayName: 'Bridge Phone',
    now: NOW + 100,
  })
  const openedJoin = await openHostPairJoin({
    invitation: invitation.handle,
    attemptId: 'attempt.bridge',
    wireFrame: join.wireText,
    now: NOW + 200,
  })
  if (openedJoin.outcome !== 'pending-confirmation') throw new Error('Pairing failed.')
  const approval = await approveHostPairing({
    confirmation: openedJoin.confirmation,
    persistenceAdapter: {
      async commitAuthorizationAndUpsertRelay() {
        return { relayRevision: 1, nextGeneration: 1 }
      },
    },
    now: NOW + 300,
  })
  const clientGrant = await openClientPairResult(join.handle, approval.wireText, NOW + 301)
  if (clientGrant.outcome !== 'approved') throw new Error('Grant failed.')
  const init = await createClientSessionInit({
    authorization: { status: 'active', ...clientGrant.authorization },
    now: NOW + 400,
    expiresAt: NOW + 20_000,
  })
  const hostValidated = await validateSessionInitForHost({
    authorization: {
      status: 'active',
      grantClaims: approval.authorization.grantClaims,
      grantClaimsHash: approval.authorization.grantClaimsHash,
      hostGrantSignature: approval.authorization.hostGrantSignature,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPublicKey: hostSigning.publicKey,
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostSigningPrivateKey: hostSigning.privateKey,
    },
    frame: init.frame,
    now: NOW + 401,
    reserveGeneration: async () => 1,
  })
  const hostAwaiting = await createHostSessionAccept({
    state: hostValidated,
    now: NOW + 402,
    expiresAt: NOW + 15_000,
  })
  const clientValidated = await validateSessionAcceptForClient({
    state: init,
    frame: hostAwaiting.frame,
    now: NOW + 403,
    installGeneration: async () => 0,
  })
  const clientAwaiting = await deriveClientSessionAfterGenerationCommit({ state: clientValidated })
  const confirm = await createClientSessionConfirm({
    state: clientAwaiting,
    now: NOW + 404,
    expiresAt: NOW + 10_000,
  })
  const hostConfirmed = await acceptClientSessionConfirm({
    state: hostAwaiting,
    frame: confirm.wireText,
    now: NOW + 405,
  })
  const ready = await createHostSessionReady({
    state: hostConfirmed,
    now: NOW + 406,
    expiresAt: NOW + 10_000,
  })
  return {
    host: ready.channel,
    client: await acceptHostSessionReady({
      state: clientAwaiting,
      frame: ready.ready.wireText,
      now: NOW + 407,
    }),
  }
}

async function ready(mode = 'normal') {
  const supervisor = new AppServerSupervisor({
    command: { executable: process.execPath, args: [fakeChild, mode] },
    clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
    allowedMethods: APP_SERVER_METHODS,
    limits: {
      maxLineBytes: 64 * 1024,
      maxStderrBytes: 16 * 1024,
      maxPendingRequests: 8,
      maxPendingServerRequests: 4,
      maxNotificationSubscribers: 4,
      maxBufferedNotifications: 8,
      maxWriteQueueBytes: 128 * 1024,
      maxWriteQueueFrames: 8,
      initializationTimeoutMs: 2_000,
      requestTimeoutMs: 100,
      serverRequestTimeoutMs: 100,
      shutdownGraceMs: 100,
    },
  })
  supervisors.push(supervisor)
  await supervisor.start()
  return {
    supervisor,
    compatibility: await establishRuntimeCompatibilityForTest(supervisor),
  }
}

async function readyReadProjection(
  onNotification?: (notification: Notification) => void,
  paginateTurns = false,
  allowAllLocalThreads = false,
): Promise<AppServerReadProjection> {
  const supervisor = new AppServerSupervisor({
    command: { executable: process.execPath, args: [fakeReadChild] },
    clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
    allowedMethods: ['thread/list', 'thread/read', 'thread/turns/list'],
    limits: {
      initializationTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      shutdownGraceMs: 100,
    },
  })
  supervisors.push(supervisor)
  if (onNotification !== undefined) supervisor.onNotification(onNotification)
  const projection = new AppServerReadProjection({
    supervisor,
    paginateTurns,
    allowAllLocalThreads,
    workspaces: [{
      id: 'workspace-alpha',
      name: 'Alpha',
      path: 'D:\\Workspace\\Alpha',
      pathLabel: 'Workspace / Alpha',
    }],
  })
  await supervisor.start()
  return projection
}

async function setup(mode = 'normal', seedWriteTask = true, anchored = false) {
  const channels = await establishChannels()
  const hostInfo = getEstablishedSessionChannelInfo(channels.host)
  const stateConfig = {
    workspaceRoot: WORKSPACE_ROOT,
    databasePath: windowsPath.join(caseDirectory, 'e2ee-action.sqlite'),
  }
  const anchor = anchored ? await WindowsAnchoredActionState.create(stateConfig) : undefined
  const store = anchor?.store ?? createActionState(stateConfig)
  if (anchor) anchoredStores.push(anchor)
  else stores.push(store)
  store.applyAuthorization({
    hostId: hostInfo.authority.hostId,
    authorizationId: hostInfo.authority.authorizationId,
    clientDeviceId: hostInfo.authority.clientDeviceId,
    authorizationEpoch: hostInfo.authority.authorizationEpoch,
    connectionGeneration: hostInfo.authority.connectionGeneration,
    status: 'active',
    revision: 1,
  })
  store.activateChannel({
    hostId: hostInfo.authority.hostId,
    authorizationId: hostInfo.authority.authorizationId,
    authorizationEpoch: hostInfo.authority.authorizationEpoch,
    connectionGeneration: hostInfo.authority.connectionGeneration,
    inboundKeyId: hostInfo.inboundKeyId,
    outboundKeyId: hostInfo.outboundKeyId,
    lastInboundSequence: hostInfo.sequenceState.lastAcceptedInboundSequence,
    lastPeerAck: hostInfo.sequenceState.lastPeerAck,
    maxSentSequence: hostInfo.sequenceState.maxSentSequence,
  })
  if (seedWriteTask) {
    store.upsertTask({
      hostId: hostInfo.authority.hostId,
      taskId: 'task.bridge',
      workspaceId: 'workspace.bridge',
      revision: 4,
      writeState: 'writable',
      canSend: true,
      canInterrupt: false,
    })
  }
  return { ...channels, hostInfo, store, anchor, ...await ready(mode) }
}

async function sealRequest(
  client: EstablishedSessionChannel,
  message: unknown,
  requestId: string,
  taskId?: string,
): Promise<string> {
  const info = getEstablishedSessionChannelInfo(client)
  const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
    protocolVersion: PROTOCOL_VERSION,
    connectionGeneration: info.authority.connectionGeneration,
    fromDeviceId: info.authority.clientDeviceId,
    toDeviceId: info.authority.hostDeviceId,
    hostId: info.authority.hostId,
    keyId: info.outboundKeyId,
    requestId,
    ...(taskId === undefined ? {} : { taskId }),
    sentAt: NOW + 500,
    expiresAt: NOW + 10_000,
    messageType: 'request',
  }
  const sealed = await sealEstablishedApplication({
    state: client,
    header,
    message,
    now: NOW + 500,
    assertAuthorizationActive: async () => {},
    persistence: {
      reserveSequence: async request => request.expectedSequence,
      commitFrame: async () => {},
    },
  })
  return sealed.wireText
}

const EXPECTED_SETTINGS = Object.freeze({
  model: 'gpt-5.6-sol',
  effort: 'high' as const,
  permission: 'ask' as const,
})

function turnSend(
  textInputs: readonly { readonly type: 'text'; readonly text: string }[],
  settings: Readonly<{ model: string; effort: 'high'; permission: 'ask' | 'read-only' | 'full-access' }> = EXPECTED_SETTINGS,
) {
  return {
    kind: 'request' as const,
    operation: 'turn.send' as const,
    params: {
      taskId: 'task.bridge',
      input: {
        actionId: 'action.bridge.1',
        input: textInputs,
        settings,
        expected: { hostId: 'host.bridge', connectionGeneration: 1, revision: 4 },
      },
    },
  }
}

function turnSteer() {
  return {
    kind: 'request' as const,
    operation: 'turn.steer' as const,
    params: {
      taskId: 'task.bridge',
      input: {
        actionId: 'action.bridge.steer',
        input: [{ type: 'text' as const, text: '调整方向原文' }],
        expected: { hostId: 'host.bridge', connectionGeneration: 1, revision: 5 },
      },
    },
  }
}

function turnSendWithImage(bytes: Buffer) {
  return {
    kind: 'request' as const,
    operation: 'turn.send' as const,
    params: {
      taskId: 'task.bridge',
      input: {
        actionId: 'action.bridge.1',
        input: [
          { type: 'text' as const, text: '检查图片' },
          { type: 'localImage' as const, attachmentId: 'image-1', name: 'shot.png' },
        ],
        attachments: [{
          attachmentId: 'image-1', name: 'shot.png', mediaType: 'image/png',
          byteLength: bytes.byteLength, contentBase64Url: bytes.toString('base64url'),
        }],
        settings: EXPECTED_SETTINGS,
        expected: { hostId: 'host.bridge', connectionGeneration: 1, revision: 4 },
      },
    },
  }
}

const fingerprintCanonicalRequest = async (bytes: Uint8Array): Promise<string> => (
  createHmac('sha256', Buffer.alloc(32, 0x63)).update(bytes).digest('base64url')
)

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
  caseDirectory = windowsPath.join(TEST_ROOT, `e2ee-bridge-${randomUUID()}`)
  mkdirSync(caseDirectory, { recursive: true })
  stores = []
  anchoredStores = []
  supervisors = []
  relayServers = []
  relayHosts = []
  relayPeers = []
  relayCarriers = []
  relayCarrierSockets = []
  tlsProxies = []
})

afterEach(async () => {
  await Promise.all(relayCarriers.map(carrier => carrier.close().catch(() => undefined)))
  await Promise.all(relayHosts.map(host => host.close().catch(() => undefined)))
  for (const peer of relayPeers) peer.terminate()
  for (const socket of relayCarrierSockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
  await Promise.all(tlsProxies.map(proxy => proxy.close().catch(() => undefined)))
  await Promise.all(relayServers.map(server => server.close().catch(() => undefined)))
  await Promise.all(supervisors.map((supervisor) => supervisor.close()))
  for (const anchor of anchoredStores.reverse()) await anchor.close()
  for (const store of stores.reverse()) store.close()
  rmSync(caseDirectory, { recursive: true, force: true })
})

describe('controlled link latency benchmark', () => {
  it.skipIf(process.env.CODEX_PLUS_LINK_BENCHMARK !== '1' || process.platform !== 'win32').each([false, true])(
    'records warm TLS/E2EE requests with DPAPI anchor = %s', async anchored => {
      const count = Number(process.env.CODEX_PLUS_LINK_SAMPLES ?? '30')
      if (!Number.isSafeInteger(count) || count < 10 || count > 100) throw new Error('benchmark-sample-count')
      const warmup = 3
      const clockStart = performance.now()
      const clock = () => NOW + 600 + Math.floor(performance.now() - clockStart)
      const value = await setup('normal', true, anchored)
      const projection = await readyReadProjection()
      const tls = await startProductionTlsGateway(BOOTSTRAP_CREDENTIAL, clock)
      const hostIdentity = signingIdentity(), clientIdentity = signingIdentity()
      const expected = value.hostInfo.authority
      const assertCurrent = async (authority: typeof expected) => {
        for (const key of ['hostId', 'hostDeviceId', 'clientDeviceId', 'authorizationId', 'authorizationEpoch', 'connectionGeneration'] as const) {
          if (authority[key] !== expected[key]) throw new Error('benchmark-authorization-mismatch')
        }
      }
      let current: Record<string, number> | undefined
      let lastBoundary = Promise.resolve()
      let readyHandler!: ReturnType<typeof createWindowsCompanionReadySessionHandler>
      const host = createR3ProductionRelayHostClientForTest({
        mode: 'production', webSocketUrl: tls.webSocketUrl, relayOrigin: tls.publicOrigin,
        hostId: expected.hostId, hostDeviceId: expected.hostDeviceId,
        authentication: bootstrapAuthentication(hostIdentity),
        signChallenge: input => signChallenge(hostIdentity, input),
        onEnvelope: frame => {
          const sample = current!
          lastBoundary = (async () => {
            const start = performance.now()
            sample.requestBytes = frame.byteLength
            await value.anchor?.syncAfterRequestBoundary()
            const openedAt = performance.now()
            sample.anchorBeforeMs = openedAt - start
            await readyHandler(frame)
            const responseAt = performance.now()
            sample.dispatchAndReceiptMs = responseAt - openedAt
            await value.anchor?.syncAfterRequestBoundary()
            sample.anchorAfterMs = performance.now() - responseAt
            sample.hostBoundaryMs = performance.now() - start
          })()
          return lastBoundary
        },
        now: clock, operationTimeoutMs: 15_000,
      }, nodeProductionHostSocketFactory(tls.proxy.certificate))
      relayHosts.push(host)
      readyHandler = createWindowsCompanionReadySessionHandler({
        state: value.host, store: value.store, projection, supervisor: value.supervisor,
        compatibility: value.compatibility, expectedSettings: EXPECTED_SETTINGS,
        assertAuthorizationActive: assertCurrent, fingerprintCanonicalRequest,
        sendEnvelope: frame => {
          current!.responseBytes = Buffer.byteLength(frame)
          return host.sendEnvelope(frame)
        }, now: clock,
      })
      await host.connect()
      await host.putAuthorization({
        protocolVersion: PROTOCOL_VERSION, relayType: 'authorization.put',
        hostId: expected.hostId, hostDeviceId: expected.hostDeviceId,
        clientDeviceId: expected.clientDeviceId, authorizationId: expected.authorizationId,
        authorizationEpoch: expected.authorizationEpoch, hostAuthorizationRevision: 1,
        status: 'active', clientSigningKey: clientIdentity.publicKey,
        clientSigningFingerprint: clientIdentity.fingerprint,
      })
      const carrier = createR3ProductionRelayClientCarrierForTest({
        mode: 'production', webSocketUrl: tls.webSocketUrl, relayOrigin: tls.publicOrigin,
        hostId: expected.hostId, hostDeviceId: expected.hostDeviceId,
        clientDeviceId: expected.clientDeviceId, authorizationId: expected.authorizationId,
        authorizationEpoch: expected.authorizationEpoch,
        signChallenge: input => signChallenge(clientIdentity, input),
        now: clock, receiptTimeoutMs: 15_000,
      }, nodeProductionRelaySocketFactory(tls.proxy.certificate, tls.ownerCookie))
      relayCarriers.push(carrier)
      await carrier.connect()
      let serial = 0, requestStart = 0, sentTurns = 0
      value.supervisor.onNotification(notification => {
        if (notification.method === 'fake/write-seen' && (notification.params as { method?: string })?.method === 'turn/start') sentTurns++
      })
      const transport = createRelayCodexServeTransport({
        channel: value.client, carrier, assertAuthorizationActive: assertCurrent,
        outboundPersistence: { reserveSequence: async request => request.expectedSequence, commitFrame: async () => {} },
        commitInbound: async () => {}, now: clock,
        createRequestId: () => `benchmark.${++serial}`, requestTimeoutMs: 15_000,
        onRelayReceipt: () => { if (current) current.relayReceiptMs = performance.now() - requestStart },
      })
      const client = createTransportCodexServeClient(transport)
      const scenarios = []
      let failures = 0
      for (const operation of ['workspace.list', 'task.list', 'task.read', 'turn.send'] as const) {
        const samples: Record<string, number>[] = []
        let scenarioFailures = 0
        let attempted = 0
        let failureCode: string | undefined
        for (let index = 0; index < warmup + count; index++) {
          if (requestStart > 0) await new Promise(resolve => setTimeout(resolve, Math.max(0, 500 - (performance.now() - requestStart))))
          const state = value.store.getTaskState({ hostId: expected.hostId, taskId: 'task.bridge' })!
          if (operation === 'turn.send') value.store.upsertTask({
            hostId: expected.hostId, taskId: 'task.bridge', workspaceId: 'workspace.bridge',
            revision: state.revision, writeState: 'writable', canSend: true, canInterrupt: false,
          })
          await value.anchor?.syncAfterRequestBoundary()
          current = {}
          requestStart = performance.now()
          attempted++
          try {
            if (operation === 'workspace.list') await client.listWorkspaces()
            else if (operation === 'task.list') await client.listTasks()
            else if (operation === 'task.read') await client.readTask('thread-idle-full')
            else {
              const receipt = await client.sendTurn('task.bridge', {
                actionId: `benchmark.send.${index}`, input: [{ type: 'text', text: 'b'.repeat(1024) }],
                settings: EXPECTED_SETTINGS,
                expected: { hostId: expected.hostId, connectionGeneration: expected.connectionGeneration, revision: state.revision },
              })
              if (receipt.state !== 'accepted') throw new Error('benchmark-action-not-accepted')
            }
            current.roundTripMs = performance.now() - requestStart
            await lastBoundary
            current.settledCycleMs = performance.now() - requestStart
            if (index >= warmup) samples.push(current)
          } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined
            failureCode = typeof code === 'string' && /^[a-z-]{1,48}$/.test(code) ? code : 'benchmark-failed'
            scenarioFailures++; failures++; break
          } finally { current = undefined }
        }
        const metrics = ['roundTripMs', 'settledCycleMs', 'relayReceiptMs', 'anchorBeforeMs', 'dispatchAndReceiptMs', 'anchorAfterMs', 'hostBoundaryMs']
        scenarios.push({ operation, attempted, warmup,
          measured: samples.length, failures: scenarioFailures, ...(failureCode ? { failureCode } : {}),
          statistics: Object.fromEntries(metrics.map(key => [key, latencyStatistics(samples.map(sample => sample[key]))])),
          requestBytes: samples[0]?.requestBytes, responseBytes: samples[0]?.responseBytes, samples,
        })
        if (scenarioFailures) break
      }
      transport.close()
      const directory = windowsPath.join(WORKSPACE_ROOT, '.tmp', 'link-benchmark')
      mkdirSync(directory, { recursive: true })
      writeFileSync(windowsPath.join(directory, `lab-${anchored ? 'anchored' : 'sqlite'}.json`), JSON.stringify({
        timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch, node: process.versions.node,
        topology: 'one Node protocol client + loopback TLS proxy + production Gateway + fake app-server',
        anchored, clientPersistence: 'memory; IndexedDB and DOM are not measured',
        session: 'preauthorized, synthetic keys; protocol and elapsed clocks advance together',
        maximumRequestRate: 2,
        failures, sentTurns, scenarios,
      }, null, 2))
      console.log(JSON.stringify({ benchmark: anchored ? 'anchored' : 'sqlite', samplesPerOperation: count, failures, sentTurns }))
      expect(failures).toBe(0)
      expect(sentTurns).toBe(count + warmup)
    }, 720_000,
  )
})

describe('genuine E2EE action bridge', () => {
  it('runs one text action through the real loopback Relay and returns its encrypted receipt', async () => {
    const value = await setup()
    const { webSocketUrl } = await startRelay()
    const relayHostIdentity = signingIdentity()
    const relayClientIdentity = signingIdentity()
    const writes: unknown[] = []
    value.supervisor.onNotification((notification: Notification) => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params)
    })

    const hostFrames: Buffer[] = []
    const hostRelayReceipts: RelayReceipt[] = []
    let handlerFailure: Error | undefined
    let resolveHandled!: () => void
    const handled = new Promise<void>(resolve => {
      resolveHandled = resolve
    })
    let relayHost!: R3LoopbackRelayHostClient
    relayHost = new R3LoopbackRelayHostClient({
      mode: 'r3-local-test',
      webSocketUrl,
      relayOrigin: RELAY_ORIGIN,
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      authentication: bootstrapAuthentication(relayHostIdentity),
      signChallenge: input => signChallenge(relayHostIdentity, input),
      onEnvelope: async rawFrame => {
        hostFrames.push(Buffer.from(rawFrame))
        try {
          const action = await dispatchEncryptedTextAction({
            state: value.host,
            frame: rawFrame,
            now: NOW + 501,
            store: value.store,
            supervisor: value.supervisor,
            compatibility: value.compatibility,
            expectedSettings: EXPECTED_SETTINGS,
            assertAuthorizationActive: async () => {},
            fingerprintCanonicalRequest,
          })
          if (action.state !== 'action-receipt') {
            throw new Error(`Unexpected action state: ${action.state}.`)
          }
          const encrypted = await sealEncryptedActionReceipt({
            state: value.host,
            context: action,
            now: NOW + 502,
            store: value.store,
            assertAuthorizationActive: async () => {},
          })
          hostRelayReceipts.push(await relayHost.sendEnvelope(encrypted.wireText))
        } catch (error) {
          handlerFailure = error instanceof Error ? error : new Error('Relay Host handler failed.')
        } finally {
          resolveHandled()
        }
      },
      now: () => NOW + 501,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    })
    relayHosts.push(relayHost)
    await relayHost.connect()
    expect(await relayHost.putAuthorization({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'authorization.put',
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      hostAuthorizationRevision: 1,
      status: 'active',
      clientSigningKey: relayClientIdentity.publicKey,
      clientSigningFingerprint: relayClientIdentity.fingerprint,
    })).toMatchObject({
      relayType: 'authorization.applied',
      status: 'active',
      hostAuthorizationRevision: 1,
    })

    const relayClient = await connectRelayClient(webSocketUrl)
    await authenticateRelayClient(
      relayClient,
      relayClientIdentity,
      value.hostInfo.authority,
    )
    const originalText = '  Relay → E2EE 原文\n```ts\nconst emoji = "😀"\n```\n  '
    const sealedRequest = await sealRequest(
      value.client,
      turnSend([{ type: 'text', text: originalText }]),
      'action.bridge.1',
      'task.bridge',
    )
    relayClient.send(sealedRequest)
    await handled
    if (handlerFailure !== undefined) throw handlerFailure

    const clientFrames = [await relayClient.nextText(), await relayClient.nextText()]
    const clientRelayReceipts: RelayReceipt[] = []
    const openedResponses: Awaited<ReturnType<typeof openEstablishedApplication>>[] = []
    let clientE2eeHandlerCalls = 0
    for (const frame of clientFrames) {
      try {
        clientRelayReceipts.push(decodeRelayReceipt(frame))
        continue
      } catch {
        clientE2eeHandlerCalls += 1
      }
      openedResponses.push(await openEstablishedApplication({
        state: value.client,
        frame,
        now: NOW + 503,
        assertAuthorizationActive: async () => {},
        commitInbound: async () => {},
      }))
    }

    expect(hostFrames).toHaveLength(1)
    expect(hostFrames[0]?.equals(Buffer.from(sealedRequest))).toBe(true)
    expect(clientE2eeHandlerCalls).toBe(1)
    expect(clientRelayReceipts).toEqual([{
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'action.bridge.1',
      seq: 2,
      state: 'relayed',
    }])
    expect(hostRelayReceipts).toEqual([{
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'receipt',
      connectionGeneration: 1,
      requestId: 'action.bridge.1',
      seq: 2,
      state: 'relayed',
    }])
    expect(openedResponses).toHaveLength(1)
    expect(openedResponses[0]?.message).toEqual({
      kind: 'response',
      operation: 'turn.send',
      taskId: 'task.bridge',
      ok: true,
      result: { actionId: 'action.bridge.1', state: 'accepted', revision: 5 },
    })
    expect(writes).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'task.bridge',
        clientUserMessageId: 'action.bridge.1',
        input: [{ type: 'text', text: originalText, text_elements: [] }],
        model: 'gpt-5.6-sol',
        effort: 'high',
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite', writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
      },
    })
    expect(value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    })).toMatchObject({
      lastInboundSequence: 2,
      maxSentSequence: 2,
      outboundFrameCount: 1,
    })
  })

  it('opens a genuine frame, persists accepted, and replays without a second dispatch', async () => {
    const value = await setup()
    const writes: unknown[] = []
    value.supervisor.onNotification((notification: Notification) => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params)
    })
    const message = turnSend([{ type: 'text', text: '  E2EE 原文\n第二行 😀  ' }])
    const bridge = (frame: string) => dispatchEncryptedTextAction({
      state: value.host,
      frame,
      now: NOW + 501,
      store: value.store,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })

    const accepted = await bridge(await sealRequest(
      value.client, message, 'action.bridge.1', 'task.bridge',
    ))
    expect(accepted).toEqual({
      state: 'action-receipt',
      requestId: 'action.bridge.1',
      taskId: 'task.bridge',
      operation: 'turn.send',
      receipt: { actionId: 'action.bridge.1', state: 'accepted', revision: 5 },
    })
    if (accepted.state !== 'action-receipt') throw new Error('Expected action receipt.')
    const encrypted = await sealEncryptedActionReceipt({
      state: value.host,
      context: accepted,
      now: NOW + 502,
      store: value.store,
      assertAuthorizationActive: async () => {},
    })
    expect(encrypted).toMatchObject({
      state: 'encrypted-response',
      requestId: 'action.bridge.1',
      taskId: 'task.bridge',
      operation: 'turn.send',
    })
    const storedChannel = value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    })
    expect(storedChannel).toMatchObject({
      lastInboundSequence: 2,
      maxSentSequence: 2,
      outboundFrameCount: 1,
    })
    expect(storedChannel.outboundFrameBytes).toBeGreaterThan(0)
    const opened = await openEstablishedApplication({
      state: value.client,
      frame: encrypted.wireText,
      now: NOW + 503,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })
    expect(opened.envelope.seq).toBe(2)
    expect(opened.message).toEqual({
      kind: 'response',
      operation: 'turn.send',
      taskId: 'task.bridge',
      ok: true,
      result: { actionId: 'action.bridge.1', state: 'accepted', revision: 5 },
    })
    await expect(bridge(await sealRequest(
      value.client, message, 'action.bridge.1', 'task.bridge',
    ))).resolves.toEqual({
      state: 'action-receipt',
      requestId: 'action.bridge.1',
      taskId: 'task.bridge',
      operation: 'turn.send' as const,
      receipt: { actionId: 'action.bridge.1', state: 'accepted', revision: 5 },
    })
    expect(writes.filter(write => (
      typeof write === 'object' && write !== null
      && (write as { method?: unknown }).method === 'turn/start'
    ))).toHaveLength(1)
  })

  it('accepts an authenticated same-turn steer after the initial text turn', async () => {
    const value = await setup()
    const acceptedTurns: unknown[] = []
    const bridge = (frame: string) => dispatchEncryptedTextAction({
      state: value.host,
      frame,
      now: NOW + 501,
      store: value.store,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      onAcceptedTextTurn: proof => { acceptedTurns.push(proof) },
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })

    await expect(bridge(await sealRequest(
      value.client, turnSend([{ type: 'text', text: '开始任务' }]), 'action.bridge.1', 'task.bridge',
    ))).resolves.toMatchObject({ operation: 'turn.send', receipt: { state: 'accepted', revision: 5 } })
    await expect(bridge(await sealRequest(
      value.client, turnSteer(), 'action.bridge.steer', 'task.bridge',
    ))).resolves.toMatchObject({
      operation: 'turn.steer',
      receipt: { actionId: 'action.bridge.steer', state: 'accepted', revision: 6 },
    })
    expect(acceptedTurns).toEqual([
      { taskId: 'task.bridge', turnId: 'turn-1' },
      { taskId: 'task.bridge', turnId: 'turn-1' },
    ])
  })

  it('materializes an authenticated inline image before the official turn', async () => {
    const value = await setup('empty-turn-items')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const attachmentDirectory = windowsPath.join(caseDirectory, 'attachments')
    const result = await dispatchEncryptedTextAction({
      state: value.host,
      frame: await sealRequest(value.client, turnSendWithImage(png), 'action.bridge.1', 'task.bridge'),
      now: NOW + 501,
      store: value.store,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      attachmentDirectory,
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })
    expect(result).toMatchObject({ operation: 'turn.send', receipt: { state: 'accepted', revision: 5 } })
    const files = readdirSync(attachmentDirectory)
    expect(files).toHaveLength(1)
    expect(readFileSync(windowsPath.join(attachmentDirectory, files[0]!))).toEqual(png)
  })

  it('returns durable queued on ambiguous runtime failure and on its replay', async () => {
    const value = await setup('turn-timeout')
    const message = turnSend([{ type: 'text', text: 'ambiguous' }])
    const bridge = (frame: string) => dispatchEncryptedTextAction({
      state: value.host,
      frame,
      now: NOW + 501,
      store: value.store,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })

    const queued = {
      state: 'action-receipt' as const,
      requestId: 'action.bridge.1',
      taskId: 'task.bridge',
      operation: 'turn.send' as const,
      receipt: { actionId: 'action.bridge.1', state: 'queued' as const, recoveryRequired: true as const },
    }
    const first = await bridge(await sealRequest(
      value.client, message, 'action.bridge.1', 'task.bridge',
    ))
    expect(first).toEqual(queued)
    if (first.state !== 'action-receipt') throw new Error('Expected action receipt.')
    const encrypted = await sealEncryptedActionReceipt({
      state: value.host,
      context: first,
      now: NOW + 502,
      store: value.store,
      assertAuthorizationActive: async () => {},
    })
    const opened = await openEstablishedApplication({
      state: value.client,
      frame: encrypted.wireText,
      now: NOW + 503,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })
    expect(opened.message).toEqual({
      kind: 'response',
      operation: 'turn.send',
      taskId: 'task.bridge',
      ok: true,
      result: { actionId: 'action.bridge.1', state: 'queued' },
    })
    await expect(bridge(await sealRequest(
      value.client, message, 'action.bridge.1', 'task.bridge',
    ))).resolves.toEqual(queued)
  })

  it.each([
    ['a non-turn request', { kind: 'request' as const, operation: 'workspace.list' as const, params: {} }, 'request.bridge.read-only', undefined, 'unsupported-request'],
    ['multi-part text', turnSend([{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]), 'action.bridge.1', 'task.bridge', 'unsupported-request'],
    ['unauthorized full access', turnSend([{ type: 'text', text: 'one' }], { ...EXPECTED_SETTINGS, permission: 'full-access' }), 'action.bridge.1', 'task.bridge', 'settings-mismatch'],
  ] as const)('closes the session for %s without consuming durable inbound state', async (_name, message, requestId, taskId, reason) => {
    const value = await setup()
    const writes: unknown[] = []
    value.supervisor.onNotification((notification: Notification) => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params)
    })
    const frame = await sealRequest(value.client, message, requestId, taskId)

    await expect(dispatchEncryptedTextAction({
      state: value.host,
      frame,
      now: NOW + 501,
      store: value.store,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })).resolves.toEqual({ state: 'session-closed', reason })
    expect(value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    }).lastInboundSequence).toBe(1)
    expect(writes).toEqual([])
  })
})

describe('genuine E2EE read bridge', () => {
  it('delivers partial assistant text through E2EE before completion without a full history read', async () => {
    const value = await setup()
    const projection = await readyReadProjection(undefined, true)
    const taskId = 'thread-owned-summary-pages'
    const result = await dispatchEncryptedHostRequest({
      state: value.host,
      frame: await sealRequest(value.client, { kind: 'request', operation: 'task.read', params: { taskId } }, 'read.owned.bounded', taskId),
      now: NOW + 501, store: value.store, projection,
      supervisor: value.supervisor, compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS, isTaskDemoOwned: () => true,
      readLiveText: () => ({ version: 2, messages: [{ id: 'item.live-text', turnId: 'turn-summary-2', createdAt: null, kind: 'assistant', markdown: '正在生成，尚未完成' }] }),
      assertAuthorizationActive: async () => {}, fingerprintCanonicalRequest,
    })
    if (result.state !== 'encrypted-response') throw new Error('Expected bounded response')
    const opened = await openEstablishedApplication({
      state: value.client, frame: result.wireText, now: NOW + 502,
      assertAuthorizationActive: async () => {}, commitInbound: async () => {},
    })
    expect(opened.message).toMatchObject({ operation: 'task.read', ok: true, result: { sequence: 2, task: { id: taskId, status: 'running' } } })
    if (opened.message.kind !== 'response' || opened.message.operation !== 'task.read' || !opened.message.ok) throw new Error('Expected a live snapshot')
    expect(opened.message.result.messages.at(-1)).toMatchObject({ kind: 'assistant', markdown: '正在生成，尚未完成' })
  })

  it('reads and continues another project through E2EE without changing its cwd', async () => {
    const value = await setup('normal', false)
    let projection = await readyReadProjection(undefined, false, true)
    const writes: Array<{ method: string; params: Record<string, unknown> }> = []
    value.supervisor.onNotification(notification => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params as typeof writes[number])
    })
    const read = async (taskId: string) => {
      const response = await dispatchEncryptedReadRequest({
        state: value.host,
        frame: await sealRequest(value.client, { kind: 'request', operation: 'task.read', params: { taskId } }, `read.${taskId}`, taskId),
        now: NOW + 501, store: value.store, projection, supervisor: value.supervisor,
        compatibility: value.compatibility, expectedSettings: EXPECTED_SETTINGS,
        assertAuthorizationActive: async () => {},
      })
      if (response.state !== 'encrypted-response') throw new Error('missing-encrypted-read')
      return (await openEstablishedApplication({ state: value.client, frame: response.wireText, now: NOW + 502,
        assertAuthorizationActive: async () => {}, commitInbound: async () => {},
      })).message
    }
    const otherProject = await read('thread-other')
    expect(otherProject).toMatchObject({ kind: 'response', ok: true, operation: 'task.read', result: {
      task: { id: 'thread-other', status: 'completed' },
      workspace: { name: 'OtherProject' }, capabilities: { sendTurn: true },
    } })
    expect(JSON.stringify(otherProject)).not.toContain('E:')
    projection = await readyReadProjection(undefined, false, true)
    await projection.readTask('thread-same-project-name')
    expect(await read('thread-other')).toMatchObject({ kind: 'response', ok: true, result: { capabilities: { sendTurn: true } } })
    const actionId = 'action.all-projects'
    const result = await dispatchEncryptedTextAction({
      state: value.host,
      frame: await sealRequest(value.client, { kind: 'request', operation: 'turn.send', params: {
        taskId: 'thread-other', input: { actionId, input: [{ type: 'text', text: 'Continue this project' }], settings: EXPECTED_SETTINGS,
          expected: { hostId: value.hostInfo.authority.hostId, connectionGeneration: 1, revision: 0 },
        },
      } }, actionId, 'thread-other'),
      now: NOW + 503, store: value.store, supervisor: value.supervisor, compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS, assertAuthorizationActive: async () => {}, fingerprintCanonicalRequest,
    })
    expect(result).toMatchObject({ state: 'action-receipt', taskId: 'thread-other', receipt: { state: 'accepted' } })
    expect(writes).toContainEqual({ method: 'thread/resume', params: { threadId: 'thread-other', excludeTurns: true } })
    expect(writes).toContainEqual(expect.objectContaining({ method: 'turn/start', params: expect.objectContaining({ threadId: 'thread-other' }) }))
    expect(writes.every(write => !('cwd' in write.params))).toBe(true)
    expect(await read('thread-active')).toMatchObject({ kind: 'response', ok: true, result: {
      capabilities: { sendTurn: false, steerTurn: false, interruptTurn: false, resolveApproval: false },
    } })
    expect(writes.filter(write => write.method === 'turn/start')).toHaveLength(1)
  })

  it('returns durable encrypted workspace/list/read responses after the inbound commit', async () => {
    const value = await setup()
    value.store.upsertTask({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-not-loaded',
      workspaceId: 'workspace-alpha',
      revision: 2,
      writeState: 'read-only',
      canSend: false,
      canInterrupt: false,
    })
    value.store.upsertTask({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-active',
      workspaceId: 'workspace-alpha',
      revision: 4,
      writeState: 'writable',
      canSend: true,
      canInterrupt: false,
    })
    const observedInbound: Array<{ method: string; sequence: number }> = []
    const projection = await readyReadProjection((notification) => {
      if (notification.method !== 'fake/request-observed') return
      observedInbound.push({
        method: String((notification.params as { threadId?: unknown })?.threadId === undefined
          ? 'thread/list'
          : 'thread/read'),
        sequence: value.store.getChannelState({
          hostId: value.hostInfo.authority.hostId,
          authorizationId: value.hostInfo.authority.authorizationId,
          authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
          connectionGeneration: value.hostInfo.authority.connectionGeneration,
          inboundKeyId: value.hostInfo.inboundKeyId,
        }).lastInboundSequence,
      })
    })
    const bridge = (frame: string, now: number) => dispatchEncryptedReadRequest({
      state: value.host,
      frame,
      now,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
    })
    const openResponse = async (wireText: string, now: number) => (
      await openEstablishedApplication({
        state: value.client,
        frame: wireText,
        now,
        assertAuthorizationActive: async () => {},
        commitInbound: async () => {},
      })
    ).message

    const workspace = await bridge(await sealRequest(value.client, {
      kind: 'request', operation: 'workspace.list', params: {},
    }, 'read.workspaces'), NOW + 501)
    expect(workspace).toMatchObject({
      state: 'encrypted-response',
      operation: 'workspace.list',
      requestId: 'read.workspaces',
    })
    if (workspace.state !== 'encrypted-response') throw new Error('Expected workspace response.')
    await expect(openResponse(workspace.wireText, NOW + 502)).resolves.toEqual({
      kind: 'response',
      operation: 'workspace.list',
      ok: true,
      result: [{
        id: 'workspace-alpha',
        name: 'Alpha',
        pathLabel: 'Workspace / Alpha',
        hostId: value.hostInfo.authority.hostId,
        connectionGeneration: 1,
        connection: 'online',
        capabilities: { startTask: false },
      }],
    })

    const list = await bridge(await sealRequest(value.client, {
      kind: 'request', operation: 'task.list', params: {},
    }, 'read.tasks'), NOW + 503)
    if (list.state !== 'encrypted-response') throw new Error('Expected task list response.')
    const openedList = await openResponse(list.wireText, NOW + 504)
    expect(openedList).toMatchObject({
      kind: 'response',
      operation: 'task.list',
      ok: true,
      result: {
        tasks: [
          { id: 'thread-not-loaded', status: 'syncing', revision: 2 },
          { id: 'thread-active', status: 'running', revision: 4 },
          { id: 'thread-idle-full', status: 'unknown', revision: 0 },
        ],
        nextCursor: 'next-page',
      },
    })

    const read = await bridge(await sealRequest(value.client, {
      kind: 'request', operation: 'task.read', params: { taskId: 'thread-idle-full' },
    }, 'read.task.idle', 'thread-idle-full'), NOW + 505)
    if (read.state !== 'encrypted-response') throw new Error('Expected task read response.')
    const openedRead = await openResponse(read.wireText, NOW + 506)
    expect(openedRead).toMatchObject({
      kind: 'response',
      operation: 'task.read',
      taskId: 'thread-idle-full',
      ok: true,
      result: {
        authoritative: true,
        host: { hostId: value.hostInfo.authority.hostId, generation: 1, state: 'online' },
        revision: 0,
        sequence: 0,
        cursor: 'r5-revision-0',
        capabilities: {
          sendTurn: true,
          steerTurn: false,
          interruptTurn: false,
          resolveApproval: false,
          answerQuestion: false,
        },
        task: {
          id: 'thread-idle-full',
          workspaceId: 'workspace-alpha',
          status: 'completed',
          revision: 0,
          completionReason: 'completed',
        },
        workspace: { id: 'workspace-alpha', hostId: value.hostInfo.authority.hostId },
        branch: 'main',
        model: EXPECTED_SETTINGS.model,
        effort: EXPECTED_SETTINGS.effort,
        permission: EXPECTED_SETTINGS.permission,
        sources: [],
      },
    })
    if (openedRead.kind !== 'response' || !openedRead.ok || openedRead.operation !== 'task.read') {
      throw new Error('Expected successful task read.')
    }
    expect(openedRead.result.messages.map((message) => message.kind)).toEqual([
      'user', 'assistant', 'reasoning', 'tool', 'diff', 'reasoning',
    ])
    expect(openedRead.result.messages.at(-1)).toMatchObject({
      kind: 'reasoning',
      title: 'Plan',
      summary: '先读取，再执行。',
      state: 'completed',
    })
    expect(openedRead.result.messages.every((message) => message.createdAt === null)).toBe(true)
    expect(observedInbound).toEqual([
      { method: 'thread/list', sequence: 3 },
      { method: 'thread/read', sequence: 4 },
    ])
    expect(value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    })).toMatchObject({
      lastInboundSequence: 4,
      lastPeerAck: 3,
      maxSentSequence: 4,
      outboundFrameCount: 1,
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-idle-full',
    })).toMatchObject({
      revision: 0,
      writeState: 'writable',
      canSend: true,
    })
  })

  it('durably seeds missing task authority from an authenticated list', async () => {
    const value = await setup()
    const projection = await readyReadProjection()
    const frame = await sealRequest(value.client, {
      kind: 'request', operation: 'task.list', params: {},
    }, 'read.tasks.seed')
    const response = await dispatchEncryptedReadRequest({
      state: value.host,
      frame,
      now: NOW + 501,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
    })
    if (response.state !== 'encrypted-response') throw new Error('Expected encrypted response.')
    const opened = await openEstablishedApplication({
      state: value.client,
      frame: response.wireText,
      now: NOW + 502,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })
    expect(opened.message).toMatchObject({
      kind: 'response',
      operation: 'task.list',
      ok: true,
      result: { tasks: [
        { id: 'thread-not-loaded', revision: 0 },
        { id: 'thread-active', revision: 0 },
        { id: 'thread-idle-full', revision: 0 },
      ] },
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-idle-full',
    })).toEqual({
      taskId: 'thread-idle-full',
      workspaceId: 'workspace-alpha',
      revision: 0,
      writeState: 'read-only',
      canSend: false,
      canInterrupt: false,
    })
    expect(value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    })).toMatchObject({
      lastInboundSequence: 2,
      maxSentSequence: 2,
      outboundFrameCount: 1,
    })
  })
})

describe('single-open genuine E2EE Host dispatcher', () => {
  it('executes the fixed D5 management action whitelist without task authority', async () => {
    const value = await setup('normal', false)
    const projection = await readyReadProjection()
    const operations: string[] = []
    let offset = 501
    const dispatch = async (message: unknown, requestId: string) => {
      const result = await dispatchEncryptedHostRequest({
        state: value.host,
        frame: await sealRequest(value.client, message, requestId),
        now: NOW + offset++,
        store: value.store,
        projection,
        supervisor: value.supervisor,
        compatibility: value.compatibility,
        expectedSettings: EXPECTED_SETTINGS,
        managementActions: {
          createPairing: async (input, context) => {
            operations.push(`pair:${context.requestFingerprint.length}`)
            return {
              actionId: input.actionId,
              state: 'accepted',
              invitationFragment: 'cGFpcmluZy1pbnZpdGF0aW9u',
              expiresAt: NOW + 120_000,
            }
          },
          renameDevice: async input => {
            operations.push(`rename:${input.displayName}`)
            return { actionId: input.actionId, state: 'accepted' }
          },
          revokeDevice: async input => {
            operations.push(`revoke:${input.deviceId}`)
            return { actionId: input.actionId, state: 'accepted', revision: 2 }
          },
        },
        assertAuthorizationActive: async () => {},
        fingerprintCanonicalRequest,
      })
      if (result.state !== 'encrypted-response') throw new Error('Expected encrypted response.')
      const opened = await openEstablishedApplication({
        state: value.client,
        frame: result.wireText,
        now: NOW + offset++,
        assertAuthorizationActive: async () => {},
        commitInbound: async () => {},
      })
      return opened.message
    }
    const expected = {
      hostId: value.hostInfo.authority.hostId,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
    }
    expect(await dispatch({
      kind: 'request', operation: 'pairing.create',
      params: { actionId: 'manage.pair', expected },
    }, 'manage.pair')).toMatchObject({
      kind: 'response', operation: 'pairing.create', ok: true,
      result: { actionId: 'manage.pair', state: 'accepted' },
    })
    expect(await dispatch({
      kind: 'request', operation: 'device.rename',
      params: {
        actionId: 'manage.rename', deviceId: 'client.old', authorizationId: 'authorization.old',
        authorizationEpoch: 1, displayName: '旧手机', expected,
      },
    }, 'manage.rename')).toMatchObject({
      kind: 'response', operation: 'device.rename', ok: true,
      result: { actionId: 'manage.rename', state: 'accepted' },
    })
    expect(await dispatch({
      kind: 'request', operation: 'device.revoke',
      params: {
        actionId: 'manage.revoke', deviceId: 'client.old', authorizationId: 'authorization.old',
        authorizationEpoch: 1, expected,
      },
    }, 'manage.revoke')).toMatchObject({
      kind: 'response', operation: 'device.revoke', ok: true,
      result: { actionId: 'manage.revoke', state: 'accepted', revision: 2 },
    })
    expect(await dispatch({
      kind: 'request', operation: 'device.revoke',
      params: {
        actionId: 'manage.self', deviceId: value.hostInfo.authority.clientDeviceId,
        authorizationId: value.hostInfo.authority.authorizationId,
        authorizationEpoch: value.hostInfo.authority.authorizationEpoch, expected,
      },
    }, 'manage.self')).toMatchObject({
      kind: 'response', operation: 'device.revoke', ok: true,
      result: { actionId: 'manage.self', state: 'rejected', rejection: { code: 'capability-denied' } },
    })
    expect(operations).toEqual(['pair:43', 'rename:旧手机', 'revoke:client.old'])
  })

  it('resolves one live approval and durably interrupts only its Companion-owned turn', async () => {
    const value = await setup('turn-active-id', false)
    const projection = await readyReadProjection()
    const writes: unknown[] = []
    value.supervisor.onNotification((notification: Notification) => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params)
    })
    await startBoundTextTurn(value.supervisor, value.compatibility, {
      threadId: 'thread-live-clean', actionId: 'action.live.start', text: '开始受控任务',
    })
    projection.registerOwnedActiveTask({
      taskId: 'thread-live-clean', workspaceId: 'workspace-alpha', actionId: 'action.live.start',
      turnId: 'turn-active', title: '受控任务', text: '开始受控任务', now: NOW,
    })
    value.store.upsertTask({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-live-clean', workspaceId: 'workspace-alpha', revision: 0,
      writeState: 'writable', canSend: false, canInterrupt: true,
    })
    const liveRequests = createLiveRequestAuthority({
      isTaskOwned: (taskId, turnId) => taskId === 'thread-live-clean' && turnId === 'turn-active',
      now: () => NOW + 500,
      ttlMs: 5_000,
    })
    const appServerDecision = liveRequests.handleServerRequest({
      id: 'rpc.live',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-live-clean', turnId: 'turn-active', itemId: 'item.live', startedAtMs: NOW,
        command: 'pnpm test', reason: '运行测试',
      },
    })
    let offset = 501
    const dispatch = async (message: unknown, requestId: string, taskId: string) => {
      const result = await dispatchEncryptedHostRequest({
        state: value.host,
        frame: await sealRequest(value.client, message, requestId, taskId),
        now: NOW + offset++,
        store: value.store,
        projection,
        supervisor: value.supervisor,
        compatibility: value.compatibility,
        expectedSettings: EXPECTED_SETTINGS,
        isTaskDemoOwned: candidate => candidate === 'thread-live-clean',
        liveRequests,
        assertAuthorizationActive: async () => {},
        fingerprintCanonicalRequest,
      })
      if (result.state !== 'encrypted-response') throw new Error('Expected encrypted response.')
      return (await openEstablishedApplication({
        state: value.client,
        frame: result.wireText,
        now: NOW + offset++,
        assertAuthorizationActive: async () => {},
        commitInbound: async () => {},
      })).message
    }
    const read = await dispatch({
      kind: 'request', operation: 'task.read', params: { taskId: 'thread-live-clean' },
    }, 'live.read', 'thread-live-clean')
    if (read.kind !== 'response' || read.operation !== 'task.read' || !read.ok) throw new Error('Expected task read.')
    const approval = read.result.messages.find(message => message.kind === 'approval')
    if (approval?.kind !== 'approval') throw new Error('Expected live approval.')
    expect(read.result).toMatchObject({
      task: { status: 'waiting-approval', activeTurnId: 'turn-active' },
      capabilities: { resolveApproval: true, interruptTurn: true, steerTurn: false },
    })
    expect(await dispatch({
      kind: 'request', operation: 'request.resolve',
      params: {
        type: 'approval', actionId: 'live.resolve', decision: 'approve-once',
        requestId: approval.requestId, requestNonce: approval.requestNonce,
        taskId: approval.taskId, turnId: approval.turnId,
        hostId: approval.hostId, connectionGeneration: approval.connectionGeneration,
        issuedAt: approval.issuedAt, expiresAt: approval.expiresAt,
        expected: {
          hostId: read.result.host.hostId,
          connectionGeneration: read.result.host.generation,
          revision: read.result.revision,
        },
      },
    }, 'live.resolve', 'thread-live-clean')).toMatchObject({
      kind: 'response', operation: 'request.resolve', ok: true,
      result: { actionId: 'live.resolve', state: 'accepted' },
    })
    await expect(appServerDecision).resolves.toEqual({ result: { decision: 'accept' } })

    const interruptRequest = {
      kind: 'request', operation: 'turn.interrupt',
      params: {
        taskId: 'thread-live-clean',
        input: {
          actionId: 'live.interrupt', turnId: 'turn-active',
          expected: {
            hostId: value.hostInfo.authority.hostId,
            connectionGeneration: value.hostInfo.authority.connectionGeneration,
            revision: 0,
          },
        },
      },
    }
    expect(await dispatch(interruptRequest, 'live.interrupt', 'thread-live-clean')).toMatchObject({
      kind: 'response', operation: 'turn.interrupt', ok: true,
      result: { actionId: 'live.interrupt', state: 'accepted', revision: 1 },
    })
    expect(await dispatch(interruptRequest, 'live.interrupt', 'thread-live-clean')).toMatchObject({
      kind: 'response', operation: 'turn.interrupt', ok: true,
      result: { actionId: 'live.interrupt', state: 'accepted', revision: 1 },
    })
    expect(writes.filter(write => (
      typeof write === 'object' && write !== null && (write as any).method === 'turn/interrupt'
    ))).toHaveLength(1)
  })

  it('returns only bounded layered status and Host-owned devices for manage.read', async () => {
    const value = await setup('normal', false)
    const projection = await readyReadProjection()
    const generatedAt = NOW + 501
    const result = await dispatchEncryptedHostRequest({
      state: value.host,
      frame: await sealRequest(value.client, {
        kind: 'request', operation: 'manage.read', params: {},
      }, 'host.manage.read'),
      now: generatedAt,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      listManagedDevices: async input => {
        expect(input).toEqual({
          currentClientDeviceId: value.hostInfo.authority.clientDeviceId,
          generatedAt,
        })
        return [
          {
            deviceId: value.hostInfo.authority.clientDeviceId,
            displayName: 'Current browser',
            shortId: 'current',
            signingFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            authorizationId: value.hostInfo.authority.authorizationId,
            authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
            status: 'active',
            presence: 'online',
            pairedAt: NOW - 1_000,
            lastSeenAt: generatedAt,
            isCurrent: true,
          },
          {
            deviceId: 'client.revoked',
            displayName: 'Revoked device',
            shortId: 'revoked',
            signingFingerprint: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
            authorizationId: 'authorization.revoked',
            authorizationEpoch: 3,
            status: 'revoked',
            presence: 'offline',
            pairedAt: NOW - 2_000,
            lastSeenAt: null,
            isCurrent: false,
          },
        ]
      },
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })
    if (result.state !== 'encrypted-response') throw new Error('Expected encrypted response.')
    const opened = await openEstablishedApplication({
      state: value.client,
      frame: result.wireText,
      now: generatedAt + 1,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })
    expect(result.operation).toBe('manage.read')
    expect(opened.message).toMatchObject({
      kind: 'response',
      operation: 'manage.read',
      ok: true,
      result: {
        generatedAt,
        hostId: value.hostInfo.authority.hostId,
        connectionGeneration: value.hostInfo.authority.connectionGeneration,
        layers: {
          gateway: 'healthy',
          relaySocket: 'authenticated',
          host: 'online',
          e2ee: 'ready',
          companion: 'online',
          appServer: 'compatible',
        },
        devices: [
          { isCurrent: true, status: 'active', presence: 'online' },
          { deviceId: 'client.revoked', status: 'revoked', presence: 'offline' },
        ],
        events: expect.arrayContaining([
          expect.objectContaining({ category: 'relay', state: 'authenticated' }),
          expect.objectContaining({ category: 'device', state: 'authenticated' }),
          expect.objectContaining({ category: 'app-server', state: 'compatible' }),
        ]),
      },
    })
  })

  it('routes read then text write on one channel and closes unsupported input', async () => {
    const value = await setup('normal', false)
    const projection = await readyReadProjection()
    const writes: unknown[] = []
    value.supervisor.onNotification((notification: Notification) => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params)
    })
    let timeOffset = 501
    const dispatch = async (message: unknown, requestId: string, taskId?: string) => {
      const result = await dispatchEncryptedHostRequest({
        state: value.host,
        frame: await sealRequest(value.client, message, requestId, taskId),
        now: NOW + timeOffset++,
        store: value.store,
        projection,
        supervisor: value.supervisor,
        compatibility: value.compatibility,
        expectedSettings: EXPECTED_SETTINGS,
        assertAuthorizationActive: async () => {},
        fingerprintCanonicalRequest,
      })
      if (result.state !== 'encrypted-response') return result
      const opened = await openEstablishedApplication({
        state: value.client,
        frame: result.wireText,
        now: NOW + timeOffset++,
        assertAuthorizationActive: async () => {},
        commitInbound: async () => {},
      })
      return Object.freeze({ ...result, message: opened.message })
    }

    const workspace = await dispatch({
      kind: 'request', operation: 'workspace.list', params: {},
    }, 'host.workspaces')
    expect(workspace).toMatchObject({
      state: 'encrypted-response',
      operation: 'workspace.list',
      message: { kind: 'response', operation: 'workspace.list', ok: true },
    })

    const list = await dispatch({
      kind: 'request', operation: 'task.list', params: {},
    }, 'host.tasks')
    expect(list).toMatchObject({
      state: 'encrypted-response',
      operation: 'task.list',
      message: {
        kind: 'response',
        operation: 'task.list',
        ok: true,
        result: { tasks: [
          { id: 'thread-not-loaded', revision: 0 },
          { id: 'thread-active', revision: 0 },
          { id: 'thread-idle-full', revision: 0 },
        ] },
      },
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-idle-full',
    })).toMatchObject({ revision: 0, writeState: 'read-only', canSend: false })

    const read = await dispatch({
      kind: 'request',
      operation: 'task.read',
      params: { taskId: 'thread-idle-full' },
    }, 'host.read.idle', 'thread-idle-full')
    expect(read).toMatchObject({
      state: 'encrypted-response',
      operation: 'task.read',
      message: {
        kind: 'response',
        operation: 'task.read',
        taskId: 'thread-idle-full',
        ok: true,
        result: {
          revision: 0,
          capabilities: { sendTurn: true },
        },
      },
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-idle-full',
    })).toMatchObject({ revision: 0, writeState: 'writable', canSend: true })

    const originalText = '  单次 open 后发送\n```ts\nconst ok = "😀"\n```  '
    const actionId = 'host.action.1'
    const send = await dispatch({
      kind: 'request',
      operation: 'turn.send',
      params: {
        taskId: 'thread-idle-full',
        input: {
          actionId,
          input: [{ type: 'text', text: originalText }],
          settings: EXPECTED_SETTINGS,
          expected: {
            hostId: value.hostInfo.authority.hostId,
            connectionGeneration: value.hostInfo.authority.connectionGeneration,
            revision: 0,
          },
        },
      },
    }, actionId, 'thread-idle-full')
    expect(send).toMatchObject({
      state: 'encrypted-response',
      operation: 'turn.send',
      message: {
        kind: 'response',
        operation: 'turn.send',
        taskId: 'thread-idle-full',
        ok: true,
        result: { actionId, state: 'accepted', revision: 1 },
      },
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-idle-full',
    })).toMatchObject({ revision: 1, writeState: 'writable', canSend: false })
    expect(writes.filter(write => (
      typeof write === 'object' && write !== null
      && (write as { method?: unknown }).method === 'turn/start'
    ))).toHaveLength(1)
    expect(writes).toContainEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-idle-full',
        clientUserMessageId: actionId,
        input: [{ type: 'text', text: originalText, text_elements: [] }],
        model: 'gpt-5.6-sol',
        effort: 'high',
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'workspaceWrite', writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: false, excludeSlashTmp: false,
        },
      },
    })

    const active = await dispatch({
      kind: 'request',
      operation: 'task.read',
      params: { taskId: 'thread-active' },
    }, 'host.read.active', 'thread-active')
    expect(active).toMatchObject({
      state: 'encrypted-response',
      operation: 'task.read',
      message: {
        kind: 'response',
        operation: 'task.read',
        taskId: 'thread-active',
        ok: true,
        result: {
          capabilities: { sendTurn: false, steerTurn: false, interruptTurn: false },
          task: { status: 'waiting-approval', activeTurnId: 'turn-active' },
          messages: expect.arrayContaining([
            expect.objectContaining({ kind: 'tool', title: 'Unsupported item', summary: 'futureTool' }),
            expect.objectContaining({ kind: 'tool', title: 'MCP · docs', summary: 'search' }),
          ]),
        },
      },
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-active',
    })).toMatchObject({
      revision: 0,
      writeState: 'read-only',
      canSend: false,
      canInterrupt: false,
    })

    const refreshed = await dispatch({
      kind: 'request',
      operation: 'task.read',
      params: { taskId: 'thread-idle-full' },
    }, 'host.read.refreshed', 'thread-idle-full')
    expect(refreshed).toMatchObject({
      state: 'encrypted-response',
      message: {
        kind: 'response',
        operation: 'task.read',
        ok: true,
        result: { revision: 1, capabilities: { sendTurn: true } },
      },
    })
    expect(value.store.getTaskState({
      hostId: value.hostInfo.authority.hostId,
      taskId: 'thread-idle-full',
    })).toMatchObject({ revision: 1, writeState: 'writable', canSend: true })

    const beforeUnsupported = value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    })
    expect(beforeUnsupported).toMatchObject({
      lastInboundSequence: 7,
      lastPeerAck: 6,
      maxSentSequence: 7,
      outboundFrameCount: 1,
    })
    await expect(dispatchEncryptedHostRequest({
      state: value.host,
      frame: await sealRequest(value.client, {
        kind: 'request',
        operation: 'task.subscribe',
        params: { taskId: 'thread-idle-full' },
      }, 'host.unsupported', 'thread-idle-full'),
      now: NOW + timeOffset++,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
    })).resolves.toEqual({ state: 'session-closed', reason: 'unsupported-request' })
    expect(value.store.getChannelState({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      connectionGeneration: value.hostInfo.authority.connectionGeneration,
      inboundKeyId: value.hostInfo.inboundKeyId,
    })).toEqual(beforeUnsupported)
  })
})

describe('ready-session browser to Windows composition', () => {
  it('runs list, read, text send, and refresh through the real loopback Relay', async () => {
    const value = await setup('normal', false)
    const projection = await readyReadProjection()
    const { webSocketUrl } = await startRelay()
    const relayHostIdentity = signingIdentity()
    const relayClientIdentity = signingIdentity()
    let relayHost!: R3LoopbackRelayHostClient
    const acceptedTurns: unknown[] = []
    const readyHandler = createWindowsCompanionReadySessionHandler({
      state: value.host,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      onAcceptedTextTurn: proof => {
        acceptedTurns.push({
          proof,
          durableState: value.store.getActionStatus({
            hostId: value.hostInfo.authority.hostId,
            authorizationId: value.hostInfo.authority.authorizationId,
            clientDeviceId: value.hostInfo.authority.clientDeviceId,
            actionId: 'action.ready.1',
          })?.state,
        })
      },
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
      sendEnvelope: frame => relayHost.sendEnvelope(frame),
      now: () => NOW + 600,
    })
    relayHost = new R3LoopbackRelayHostClient({
      mode: 'r3-local-test',
      webSocketUrl,
      relayOrigin: RELAY_ORIGIN,
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      authentication: bootstrapAuthentication(relayHostIdentity),
      signChallenge: input => signChallenge(relayHostIdentity, input),
      onEnvelope: readyHandler,
      now: () => NOW + 600,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    })
    relayHosts.push(relayHost)
    await relayHost.connect()
    await relayHost.putAuthorization({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'authorization.put',
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      hostAuthorizationRevision: 1,
      status: 'active',
      clientSigningKey: relayClientIdentity.publicKey,
      clientSigningFingerprint: relayClientIdentity.fingerprint,
    })

    const carrier = createR3LoopbackRelayClientCarrierForTest({
      mode: 'r3-local-test',
      webSocketUrl,
      relayOrigin: RELAY_ORIGIN,
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      signChallenge: input => signChallenge(relayClientIdentity, input),
      now: () => NOW + 600,
      connectTimeoutMs: 2_000,
      receiptTimeoutMs: 2_000,
    }, nodeRelaySocketFactory())
    relayCarriers.push(carrier)
    await carrier.connect()

    let nextRequestId = 0
    const transport = createRelayCodexServeTransport({
      channel: value.client,
      carrier,
      assertAuthorizationActive: async () => {},
      outboundPersistence: {
        reserveSequence: async request => request.expectedSequence,
        commitFrame: async () => {},
      },
      commitInbound: async () => {},
      now: () => NOW + 600,
      createRequestId: () => `web.ready.${++nextRequestId}`,
      requestTimeoutMs: 2_000,
    })
    const client = createTransportCodexServeClient(transport)

    const [workspaces, tasks] = await Promise.all([
      client.listWorkspaces(),
      client.listTasks(),
    ])
    expect(workspaces).toEqual([{
      id: 'workspace-alpha',
      name: 'Alpha',
      pathLabel: 'Workspace / Alpha',
      hostId: value.hostInfo.authority.hostId,
      connectionGeneration: 1,
      connection: 'online',
      capabilities: { startTask: false },
    }])
    expect(tasks.tasks.map(task => task.id)).toContain('thread-idle-full')

    const first = await client.readTask('thread-idle-full')
    expect(first).toMatchObject({
      authoritative: true,
      revision: 0,
      task: { id: 'thread-idle-full', status: 'completed', revision: 0 },
      capabilities: { sendTurn: true },
    })
    const originalText = '  Web → Relay → Windows\n```ts\nconst emoji = "😀"\n```\n  '
    const receipt = await client.sendTurn('thread-idle-full', {
      actionId: 'action.ready.1',
      input: [{ type: 'text', text: originalText }],
      settings: EXPECTED_SETTINGS,
      expected: {
        hostId: value.hostInfo.authority.hostId,
        connectionGeneration: 1,
        revision: first.revision,
      },
    })
    expect(receipt).toEqual({
      actionId: 'action.ready.1',
      state: 'accepted',
      revision: 1,
    })
    expect(acceptedTurns).toEqual([{
      proof: { taskId: 'thread-idle-full', turnId: 'turn-1' },
      durableState: 'accepted',
    }])
    const refreshed = await client.readTask('thread-idle-full')
    expect(refreshed).toMatchObject({
      revision: 1,
      task: { revision: 1 },
      capabilities: { sendTurn: true },
    })
    expect(value.store.getActionStatus({
      hostId: value.hostInfo.authority.hostId,
      authorizationId: value.hostInfo.authority.authorizationId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      actionId: 'action.ready.1',
    })).toMatchObject({ state: 'accepted', receipt: { revision: 1 } })
    transport.close()
  })

  it('reads a genuine task through the production Gateway with injected local sockets', async () => {
    const value = await setup('normal', false)
    const projection = await readyReadProjection()
    const { webSocketUrl, ownerCookie } = await startProductionGateway()
    const relayHostIdentity = signingIdentity()
    const relayClientIdentity = signingIdentity()

    const hostPeer = await connectRelayClient(webSocketUrl, PRODUCTION_RELAY_ORIGIN)
    await authenticateProductionHost(hostPeer, relayHostIdentity, value.hostInfo.authority)
    hostPeer.send(encodeRelayAuthorizationPut({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'authorization.put',
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      hostAuthorizationRevision: 1,
      status: 'active',
      clientSigningKey: relayClientIdentity.publicKey,
      clientSigningFingerprint: relayClientIdentity.fingerprint,
    }))
    expect(decodeRelayAuthorizationApplied(await hostPeer.nextText())).toMatchObject({
      status: 'active',
      hostAuthorizationRevision: 1,
    })

    const clientPeer = await connectRelayClient(webSocketUrl, PRODUCTION_RELAY_ORIGIN, ownerCookie)
    await authenticateRelayClient(
      clientPeer,
      relayClientIdentity,
      value.hostInfo.authority,
      PRODUCTION_RELAY_ORIGIN,
    )

    const readyHandler = createWindowsCompanionReadySessionHandler({
      state: value.host,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      listManagedDevices: async ({ currentClientDeviceId, generatedAt }) => [{
        deviceId: currentClientDeviceId,
        displayName: 'Ready browser',
        shortId: currentClientDeviceId.slice(-8),
        signingFingerprint: relayClientIdentity.fingerprint,
        authorizationId: value.hostInfo.authority.authorizationId,
        authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
        status: 'active',
        presence: 'online',
        pairedAt: NOW - 1_000,
        lastSeenAt: generatedAt,
        isCurrent: true,
      }],
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
      sendEnvelope: async frame => {
        hostPeer.send(frame)
        return decodeRelayReceipt(await hostPeer.nextText())
      },
      now: () => NOW + 600,
    })

    const roundTrip = async (
      message: unknown,
      requestId: string,
      taskId?: string,
    ) => {
      clientPeer.send(await sealRequest(value.client, message, requestId, taskId))
      const relayReceipt = decodeRelayReceipt(await clientPeer.nextText())
      expect(relayReceipt).toMatchObject({ requestId, state: 'relayed' })
      expect(relayReceipt).not.toHaveProperty('result')
      await readyHandler(await hostPeer.nextText())
      return await openEstablishedApplication({
        state: value.client,
        frame: await clientPeer.nextText(),
        now: NOW + 600,
        assertAuthorizationActive: async () => {},
        commitInbound: async () => {},
      })
    }

    const managed = await roundTrip({
      kind: 'request',
      operation: 'manage.read',
      params: {},
    }, 'gateway.manage.read')
    expect(managed.message).toMatchObject({
      kind: 'response',
      operation: 'manage.read',
      ok: true,
      result: {
        hostId: value.hostInfo.authority.hostId,
        layers: { gateway: 'healthy', relaySocket: 'authenticated', e2ee: 'ready' },
        devices: [{ status: 'active', presence: 'online', isCurrent: true }],
      },
    })

    const listed = await roundTrip({
      kind: 'request',
      operation: 'task.list',
      params: {},
    }, 'gateway.task.list')
    expect(listed.message).toMatchObject({
      kind: 'response',
      operation: 'task.list',
      ok: true,
      result: { tasks: expect.arrayContaining([expect.objectContaining({ id: 'thread-idle-full' })]) },
    })

    const read = await roundTrip({
      kind: 'request',
      operation: 'task.read',
      params: { taskId: 'thread-idle-full' },
    }, 'gateway.task.read', 'thread-idle-full')
    expect(read.message).toMatchObject({
      kind: 'response',
      operation: 'task.read',
      taskId: 'thread-idle-full',
      ok: true,
      result: {
        authoritative: true,
        revision: 0,
        task: { id: 'thread-idle-full', status: 'completed', revision: 0 },
      },
    })
  })

  it('reads a genuine task through trusted TLS proxy and production Browser/Host WSS carriers', async () => {
    const value = await setup('normal', false)
    const projection = await readyReadProjection()
    const tls = await startProductionTlsGateway()
    const page = await trustedHttpsGet(`${tls.publicOrigin}/`, tls.proxy.certificate)
    expect(page.status).toBe(200)
    expect(page.body).toContain('<title>Codex Plus</title>')
    const relayHostIdentity = signingIdentity()
    const relayClientIdentity = signingIdentity()
    const hostGate = deferred<void>()
    let readyHandler!: ReturnType<typeof createWindowsCompanionReadySessionHandler>

    const relayHost = createR3ProductionRelayHostClientForTest({
      mode: 'production',
      webSocketUrl: tls.webSocketUrl,
      relayOrigin: tls.publicOrigin,
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      authentication: bootstrapAuthentication(relayHostIdentity),
      signChallenge: input => signChallenge(relayHostIdentity, input),
      onEnvelope: async frame => {
        await hostGate.promise
        await readyHandler(frame)
      },
      now: () => NOW + 600,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    }, nodeProductionHostSocketFactory(tls.proxy.certificate))
    relayHosts.push(relayHost)
    readyHandler = createWindowsCompanionReadySessionHandler({
      state: value.host,
      store: value.store,
      projection,
      supervisor: value.supervisor,
      compatibility: value.compatibility,
      expectedSettings: EXPECTED_SETTINGS,
      assertAuthorizationActive: async () => {},
      fingerprintCanonicalRequest,
      sendEnvelope: frame => relayHost.sendEnvelope(frame),
      now: () => NOW + 600,
    })
    await relayHost.connect()
    await relayHost.putAuthorization({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'authorization.put',
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      hostAuthorizationRevision: 1,
      status: 'active',
      clientSigningKey: relayClientIdentity.publicKey,
      clientSigningFingerprint: relayClientIdentity.fingerprint,
    })

    const carrierOptions = {
      mode: 'production',
      webSocketUrl: tls.webSocketUrl,
      relayOrigin: tls.publicOrigin,
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      signChallenge: (input: Uint8Array) => signChallenge(relayClientIdentity, input),
      now: () => NOW + 600,
      connectTimeoutMs: 2_000,
      receiptTimeoutMs: 2_000,
    } as const
    const withoutOwnerLogin = createR3ProductionRelayClientCarrierForTest(
      carrierOptions,
      nodeProductionRelaySocketFactory(tls.proxy.certificate, ''),
    )
    relayCarriers.push(withoutOwnerLogin)
    await expect(withoutOwnerLogin.connect()).rejects.toThrow('authentication-failed')
    await withoutOwnerLogin.close()

    const carrier = createR3ProductionRelayClientCarrierForTest(
      carrierOptions,
      nodeProductionRelaySocketFactory(tls.proxy.certificate, tls.ownerCookie),
    )
    relayCarriers.push(carrier)
    await carrier.connect()

    const firstReceipt = deferred<RelayReceipt>()
    let nextRequestId = 0
    const transport = createRelayCodexServeTransport({
      channel: value.client,
      carrier,
      assertAuthorizationActive: async () => {},
      outboundPersistence: {
        reserveSequence: async request => request.expectedSequence,
        commitFrame: async () => {},
      },
      commitInbound: async () => {},
      now: () => NOW + 600,
      createRequestId: () => `web.wss.${++nextRequestId}`,
      requestTimeoutMs: 2_000,
      onRelayReceipt: receipt => firstReceipt.resolve(receipt),
    })
    const client = createTransportCodexServeClient(transport)
    let listSettled = false
    const listPromise = client.listTasks().finally(() => { listSettled = true })
    expect(await firstReceipt.promise).toMatchObject({ state: 'relayed' })
    await Promise.resolve()
    expect(listSettled).toBe(false)
    hostGate.resolve()

    const tasks = await listPromise
    expect(tasks.tasks.map(task => task.id)).toContain('thread-idle-full')
    expect(await client.readTask('thread-idle-full')).toMatchObject({
      authoritative: true,
      revision: 0,
      task: { id: 'thread-idle-full', status: 'completed', revision: 0 },
    })
    transport.close()
    await carrier.close()
    const reconnected = createR3ProductionRelayClientCarrierForTest({
      mode: 'production',
      webSocketUrl: tls.webSocketUrl,
      relayOrigin: tls.publicOrigin,
      hostId: value.hostInfo.authority.hostId,
      hostDeviceId: value.hostInfo.authority.hostDeviceId,
      clientDeviceId: value.hostInfo.authority.clientDeviceId,
      authorizationId: value.hostInfo.authority.authorizationId,
      authorizationEpoch: value.hostInfo.authority.authorizationEpoch,
      signChallenge: input => signChallenge(relayClientIdentity, input),
      now: () => NOW + 601,
      connectTimeoutMs: 2_000,
      receiptTimeoutMs: 2_000,
    }, nodeProductionRelaySocketFactory(tls.proxy.certificate, tls.ownerCookie))
    relayCarriers.push(reconnected)
    await reconnected.connect()
    await reconnected.close()
  })

  it('rejects an untrusted test CA', async () => {
    const tls = await startProductionTlsGateway()
    const identity = signingIdentity()
    const host = new R3ProductionRelayHostClient({
      mode: 'production',
      webSocketUrl: tls.webSocketUrl,
      relayOrigin: tls.publicOrigin,
      hostId: 'host.untrusted.ca',
      hostDeviceId: 'device.untrusted.ca',
      authentication: bootstrapAuthentication(identity),
      signChallenge: input => signChallenge(identity, input),
      onEnvelope: () => undefined,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    })
    relayHosts.push(host)
    await expect(host.connect()).rejects.toMatchObject({
      name: 'R3RelayHostClientError',
      code: 'connection-failed',
    })
  })

  it('rejects an oversized production WSS frame', async () => {
    const tls = await startProductionTlsGateway()
    const oversized = new WebSocket(tls.webSocketUrl, {
      origin: tls.publicOrigin,
      ca: tls.proxy.certificate,
      rejectUnauthorized: true,
      perMessageDeflate: false,
    })
    relayCarrierSockets.push(oversized)
    await new Promise<void>((resolve, reject) => {
      oversized.once('open', resolve)
      oversized.once('error', reject)
    })
    const closed = new Promise<number>(resolve => oversized.once('close', code => resolve(code)))
    oversized.send('x'.repeat(MAX_FRAME_BYTES + 1))
    expect(await closed).not.toBe(1000)
  }, 10_000)
})

describe('ephemeral pairing and signed session through the real Relay', () => {
  it('requires local approval then runs list, read, send, and refresh on the paired channels', async () => {
    const { webSocketUrl } = await startRelay()
    const hostAgreement = await generateAgreementKeyPair()
    const hostSigning = await generateSigningKeyPair()
    const hostSigningJwk = await exportPublicJwk(hostSigning.publicKey)
    const hostSigningFingerprint = await fingerprintP256PublicKey(hostSigning.publicKey)
    const localRuntime = await ready('normal')
    const projection = await readyReadProjection()
    const store = createActionState({
      workspaceRoot: WORKSPACE_ROOT,
      databasePath: windowsPath.join(caseDirectory, 'pairing-runtime.sqlite'),
    })
    stores.push(store)
    let hostRuntime!: ReturnType<typeof createEphemeralHostPairingRuntime>
    let hostChannel: EstablishedSessionChannel | undefined
    let applicationHandler: ReturnType<typeof createWindowsCompanionReadySessionHandler> | undefined
    const hostClient = new R3LoopbackRelayHostClient({
      mode: 'r3-local-test',
      webSocketUrl,
      relayOrigin: RELAY_ORIGIN,
      hostId: 'host.pairing.runtime',
      hostDeviceId: 'device.windows.runtime',
      authentication: {
        kind: 'bootstrap',
        bootstrapCredential: BOOTSTRAP_CREDENTIAL,
        hostSigningKey: hostSigningJwk,
        hostSigningFingerprint,
      },
      signChallenge: input => signCryptoChallenge(hostSigning.privateKey, input),
      onPairJoin: frame => hostRuntime.handlePairJoin(frame),
      onSessionInit: frame => hostRuntime.handleSessionInit(frame),
      onEnvelope: async frame => {
        if (applicationHandler === undefined) {
          await hostRuntime.handleSessionEnvelope(frame)
          return
        }
        await applicationHandler(frame)
      },
      now: () => NOW + 501,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    })
    relayHosts.push(hostClient)
    hostRuntime = createEphemeralHostPairingRuntime({
      relayClient: hostClient,
      relayOrigin: RELAY_ORIGIN,
      hostId: 'host.pairing.runtime',
      hostDeviceId: 'device.windows.runtime',
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      requestLocalDecision: async () => ({ decision: 'approve' }),
      commitAuthorizationLocally: async () => ({
        hostAuthorizationRevision: 1,
        nextGeneration: 1,
      }),
      onReady: channel => {
        hostChannel = channel
        const info = getEstablishedSessionChannelInfo(channel)
        store.applyAuthorization({
          hostId: info.authority.hostId,
          authorizationId: info.authority.authorizationId,
          clientDeviceId: info.authority.clientDeviceId,
          authorizationEpoch: info.authority.authorizationEpoch,
          connectionGeneration: info.authority.connectionGeneration,
          status: 'active',
          revision: 1,
        })
        store.activateChannel({
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
        applicationHandler = createWindowsCompanionReadySessionHandler({
          state: channel,
          store,
          projection,
          supervisor: localRuntime.supervisor,
          compatibility: localRuntime.compatibility,
          expectedSettings: EXPECTED_SETTINGS,
          listManagedDevices: async ({ currentClientDeviceId, generatedAt }) => [{
            deviceId: currentClientDeviceId,
            displayName: 'Runtime Phone',
            shortId: currentClientDeviceId.slice(-8),
            signingFingerprint: Buffer.alloc(32, 0x31).toString('base64url'),
            authorizationId: info.authority.authorizationId,
            authorizationEpoch: info.authority.authorizationEpoch,
            status: 'active',
            presence: 'online',
            pairedAt: NOW + 501,
            lastSeenAt: generatedAt,
            isCurrent: true,
          }],
          assertAuthorizationActive: async () => {},
          fingerprintCanonicalRequest,
          sendEnvelope: frame => hostClient.sendEnvelope(frame),
          now: () => NOW + 700,
        })
      },
      now: () => NOW + 501,
    })
    await hostClient.connect()
    const invitation = await hostRuntime.createInvitation()
    let fragmentCleared = false
    const paired = await pairEphemeralClientForTest({
      mode: 'r3-local-test',
      invitationFragment: invitation.invitationFragment,
      expectedRelayOrigin: RELAY_ORIGIN,
      webSocketUrl,
      deviceDisplayName: 'Runtime Phone',
      clearInvitationFragment: () => { fragmentCleared = true },
      now: () => NOW + 501,
      timeoutMs: 2_000,
    }, nodeRelaySocketFactory())
    expect(fragmentCleared).toBe(true)

    const claims = paired.authorization.grantClaims
    const carrier = createR3LoopbackRelayClientCarrierForTest({
      mode: 'r3-local-test',
      webSocketUrl,
      relayOrigin: RELAY_ORIGIN,
      hostId: claims.hostId,
      hostDeviceId: claims.hostDeviceId,
      clientDeviceId: claims.clientDeviceId,
      authorizationId: claims.authorizationId,
      authorizationEpoch: claims.authorizationEpoch,
      signChallenge: input => signEphemeralClientRelayChallenge(paired.authorization, input),
      now: () => NOW + 501,
      connectTimeoutMs: 2_000,
      receiptTimeoutMs: 2_000,
    }, nodeRelaySocketFactory())
    relayCarriers.push(carrier)
    await carrier.connect()
    const clientChannel = await establishEphemeralClientSession({
      authorization: paired.authorization,
      carrier,
      now: () => NOW + 501,
    })
    if (hostChannel === undefined) throw new Error('Host channel was not established.')
    const clientInfo = getEstablishedSessionChannelInfo(clientChannel)
    const hostInfo = getEstablishedSessionChannelInfo(hostChannel)
    expect(clientInfo.authority).toEqual(hostInfo.authority)
    expect(clientInfo.outboundKeyId).toBe(hostInfo.inboundKeyId)
    expect(clientInfo.inboundKeyId).toBe(hostInfo.outboundKeyId)
    expect(applicationHandler).toBeDefined()

    let nextRequestId = 0
    const transport = createRelayCodexServeTransport({
      channel: clientChannel,
      carrier,
      assertAuthorizationActive: async () => {},
      outboundPersistence: {
        reserveSequence: async request => request.expectedSequence,
        commitFrame: async () => {},
      },
      commitInbound: async () => {},
      now: () => NOW + 700,
      createRequestId: () => `web.paired.${++nextRequestId}`,
      requestTimeoutMs: 2_000,
    })
    const client = createTransportCodexServeClient(transport)
    const [management, workspaces, tasks] = await Promise.all([
      client.readManagement(),
      client.listWorkspaces(),
      client.listTasks(),
    ])
    expect(management).toMatchObject({
      hostId: clientInfo.authority.hostId,
      connectionGeneration: 1,
      layers: {
        gateway: 'healthy',
        relaySocket: 'authenticated',
        host: 'online',
        e2ee: 'ready',
        companion: 'online',
        appServer: 'compatible',
      },
      devices: [{
        deviceId: clientInfo.authority.clientDeviceId,
        status: 'active',
        presence: 'online',
        isCurrent: true,
      }],
    })
    expect(workspaces.map(workspace => workspace.id)).toEqual(['workspace-alpha'])
    expect(tasks.tasks.map(task => task.id)).toContain('thread-idle-full')
    const first = await client.readTask('thread-idle-full')
    const originalText = '  QR → Relay → Codex\n保留 Emoji 😀 与尾部空格  '
    expect(await client.sendTurn('thread-idle-full', {
      actionId: 'action.paired.1',
      input: [{ type: 'text', text: originalText }],
      settings: EXPECTED_SETTINGS,
      expected: {
        hostId: first.host.hostId,
        connectionGeneration: first.host.generation,
        revision: first.revision,
      },
    })).toEqual({ actionId: 'action.paired.1', state: 'accepted', revision: 1 })
    expect(await client.readTask('thread-idle-full')).toMatchObject({
      revision: 1,
      capabilities: { sendTurn: true },
    })
    expect(store.getActionStatus({
      hostId: clientInfo.authority.hostId,
      authorizationId: clientInfo.authority.authorizationId,
      clientDeviceId: clientInfo.authority.clientDeviceId,
      actionId: 'action.paired.1',
    })).toMatchObject({ state: 'accepted', receipt: { revision: 1 } })
    transport.close()
  })

  it.each([false, true])('pairs, establishes a signed session, and reads a task over production WSS (local code: %s)', async localCode => {
    const tls = await startProductionTlsGateway()
    const hostAgreement = await generateAgreementKeyPair()
    const hostSigning = await generateSigningKeyPair()
    const hostSigningJwk = await exportPublicJwk(hostSigning.publicKey)
    const hostSigningFingerprint = await fingerprintP256PublicKey(hostSigning.publicKey)
    const localRuntime = await ready('normal')
    const projection = await readyReadProjection()
    const store = createActionState({
      workspaceRoot: WORKSPACE_ROOT,
      databasePath: windowsPath.join(caseDirectory, 'pairing-wss-runtime.sqlite'),
    })
    stores.push(store)
    let hostRuntime!: ReturnType<typeof createEphemeralHostPairingRuntime>
    let hostChannel: EstablishedSessionChannel | undefined
    let applicationHandler: ReturnType<typeof createWindowsCompanionReadySessionHandler> | undefined
    let clientConfirmation: Readonly<{ sas: string; clientSigningFingerprint: string }> | undefined
    const hostClient = createR3ProductionRelayHostClientForTest({
      mode: 'production',
      webSocketUrl: tls.webSocketUrl,
      relayOrigin: tls.publicOrigin,
      hostId: 'host.pairing.wss',
      hostDeviceId: 'device.windows.wss',
      authentication: {
        kind: 'bootstrap',
        bootstrapCredential: BOOTSTRAP_CREDENTIAL,
        hostSigningKey: hostSigningJwk,
        hostSigningFingerprint,
      },
      signChallenge: input => signCryptoChallenge(hostSigning.privateKey, input),
      onPairJoin: frame => hostRuntime.handlePairJoin(frame),
      onSessionInit: frame => hostRuntime.handleSessionInit(frame),
      onEnvelope: async frame => {
        if (applicationHandler === undefined) await hostRuntime.handleSessionEnvelope(frame)
        else await applicationHandler(frame)
      },
      now: () => NOW + 501,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    }, nodeProductionHostSocketFactory(tls.proxy.certificate))
    relayHosts.push(hostClient)
    hostRuntime = createEphemeralHostPairingRuntime({
      relayClient: hostClient,
      relayOrigin: tls.publicOrigin,
      hostId: 'host.pairing.wss',
      hostDeviceId: 'device.windows.wss',
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      requestLocalDecision: async confirmation => {
        if (localCode) throw new Error('Local-code invitation must not request terminal approval')
        expect(clientConfirmation).toEqual({
          sas: confirmation.sas,
          clientSigningFingerprint: confirmation.clientSigningFingerprint,
        })
        return { decision: 'approve' }
      },
      commitAuthorizationLocally: async () => ({
        hostAuthorizationRevision: 1,
        nextGeneration: 1,
      }),
      onReady: channel => {
        hostChannel = channel
        const info = getEstablishedSessionChannelInfo(channel)
        store.applyAuthorization({
          hostId: info.authority.hostId,
          authorizationId: info.authority.authorizationId,
          clientDeviceId: info.authority.clientDeviceId,
          authorizationEpoch: info.authority.authorizationEpoch,
          connectionGeneration: info.authority.connectionGeneration,
          status: 'active',
          revision: 1,
        })
        store.activateChannel({
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
        applicationHandler = createWindowsCompanionReadySessionHandler({
          state: channel,
          store,
          projection,
          supervisor: localRuntime.supervisor,
          compatibility: localRuntime.compatibility,
          expectedSettings: EXPECTED_SETTINGS,
          assertAuthorizationActive: async () => {},
          fingerprintCanonicalRequest,
          sendEnvelope: frame => hostClient.sendEnvelope(frame),
          now: () => NOW + 700,
        })
      },
      now: () => NOW + 501,
    })
    await hostClient.connect()
    const invitation = await hostRuntime.createInvitation({ requireLocalDecision: !localCode })
    let fragment = invitation.invitationFragment
    if (localCode) {
      const registered = await hostClient.registerPairingCode({
        protocolVersion: PROTOCOL_VERSION, relayType: 'pair.code.register',
        hostId: 'host.pairing.wss', hostDeviceId: 'device.windows.wss',
        pairSessionId: invitation.handle.pairSessionId, expiresAt: invitation.handle.expiresAt,
        invitationFragment: fragment,
      })
      expect((await redeemTestPairingCode(tls, registered.code, '')).status).toBe(401)
      const redeemed = await redeemTestPairingCode(tls, registered.code)
      expect(redeemed.status).toBe(200)
      fragment = (JSON.parse(redeemed.body) as { invitationFragment: string }).invitationFragment
      expect(fragment).toBe(invitation.invitationFragment)
      expect((await redeemTestPairingCode(tls, registered.code)).status).toBe(404)
    }
    await expect(pairEphemeralClientForTest({
      mode: 'production',
      invitationFragment: fragment,
      expectedRelayOrigin: tls.publicOrigin,
      webSocketUrl: tls.webSocketUrl.replace(/^wss:/, 'ws:'),
      deviceDisplayName: 'Invalid WSS Phone',
      clearInvitationFragment: () => {},
      now: () => NOW + 501,
      timeoutMs: 2_000,
    }, nodeProductionRelaySocketFactory(tls.proxy.certificate, tls.ownerCookie))).rejects.toThrow('invalid-pair-socket')
    let fragmentCleared = false
    const paired = await pairEphemeralClientForTest({
      mode: 'production',
      invitationFragment: fragment,
      expectedRelayOrigin: tls.publicOrigin,
      webSocketUrl: tls.webSocketUrl,
      deviceDisplayName: 'WSS Phone',
      clearInvitationFragment: () => { fragmentCleared = true },
      onConfirmation: confirmation => { clientConfirmation = confirmation },
      now: () => NOW + 501,
      timeoutMs: 2_000,
    }, nodeProductionRelaySocketFactory(tls.proxy.certificate, tls.ownerCookie))
    expect(fragmentCleared).toBe(true)

    const claims = paired.authorization.grantClaims
    const createCarrier = () => createR3ProductionRelayClientCarrierForTest({
      mode: 'production',
      webSocketUrl: tls.webSocketUrl,
      relayOrigin: tls.publicOrigin,
      hostId: claims.hostId,
      hostDeviceId: claims.hostDeviceId,
      clientDeviceId: claims.clientDeviceId,
      authorizationId: claims.authorizationId,
      authorizationEpoch: claims.authorizationEpoch,
      signChallenge: input => signEphemeralClientRelayChallenge(paired.authorization, input),
      now: () => NOW + 501,
      connectTimeoutMs: 2_000,
      receiptTimeoutMs: 2_000,
    }, nodeProductionRelaySocketFactory(tls.proxy.certificate, tls.ownerCookie))
    const carrier = createCarrier()
    relayCarriers.push(carrier)
    await carrier.connect()
    const clientChannel = await establishEphemeralClientSession({
      authorization: paired.authorization,
      carrier,
      now: () => NOW + 501,
    })
    if (hostChannel === undefined) throw new Error('Host WSS channel was not established.')
    expect(getEstablishedSessionChannelInfo(clientChannel).authority).toEqual(
      getEstablishedSessionChannelInfo(hostChannel).authority,
    )

    let nextRequestId = 0
    const transport = createRelayCodexServeTransport({
      channel: clientChannel,
      carrier,
      assertAuthorizationActive: async () => {},
      outboundPersistence: {
        reserveSequence: async request => request.expectedSequence,
        commitFrame: async () => {},
      },
      commitInbound: async () => {},
      now: () => NOW + 700,
      createRequestId: () => `web.paired.wss.${++nextRequestId}`,
      requestTimeoutMs: 2_000,
    })
    const client = createTransportCodexServeClient(transport)
    expect((await client.listTasks()).tasks.map(task => task.id)).toContain('thread-idle-full')
    expect(await client.readTask('thread-idle-full')).toMatchObject({
      authoritative: true,
      task: { id: 'thread-idle-full', status: 'completed' },
    })
    // A phone may lose only its TCP socket. Reauthenticate against the real
    // production TLS/Owner gate and continue the still-live encrypted channel.
    await new Promise(resolve => setImmediate(resolve))
    const beforeResume = getEstablishedSessionChannelInfo(clientChannel)
    expect(transport.canResume()).toBe(true)
    await carrier.close()
    const resumedCarrier = createCarrier()
    relayCarriers.push(resumedCarrier)
    await resumedCarrier.connect()
    expect(await resumedCarrier.ping?.()).toBe(true)
    transport.replaceCarrier(resumedCarrier)
    expect(await client.readTask('thread-idle-full')).toMatchObject({ authoritative: true })
    const afterResume = getEstablishedSessionChannelInfo(clientChannel)
    expect(afterResume.authority).toEqual(beforeResume.authority)
    expect(afterResume.sequenceState.maxSentSequence).toBe(beforeResume.sequenceState.maxSentSequence + 1)
    transport.close()
  })

  it('denies without installing authorization when the local Windows decision rejects', async () => {
    const { webSocketUrl } = await startRelay()
    const hostAgreement = await generateAgreementKeyPair()
    const hostSigning = await generateSigningKeyPair()
    const hostSigningJwk = await exportPublicJwk(hostSigning.publicKey)
    const hostSigningFingerprint = await fingerprintP256PublicKey(hostSigning.publicKey)
    let hostRuntime!: ReturnType<typeof createEphemeralHostPairingRuntime>
    let localCommits = 0
    const hostClient = new R3LoopbackRelayHostClient({
      mode: 'r3-local-test',
      webSocketUrl,
      relayOrigin: RELAY_ORIGIN,
      hostId: 'host.pairing.denied',
      hostDeviceId: 'device.windows.denied',
      authentication: {
        kind: 'bootstrap',
        bootstrapCredential: BOOTSTRAP_CREDENTIAL,
        hostSigningKey: hostSigningJwk,
        hostSigningFingerprint,
      },
      signChallenge: input => signCryptoChallenge(hostSigning.privateKey, input),
      onPairJoin: frame => hostRuntime.handlePairJoin(frame),
      onSessionInit: frame => hostRuntime.handleSessionInit(frame),
      onEnvelope: frame => hostRuntime.handleSessionEnvelope(frame),
      now: () => NOW + 501,
      connectTimeoutMs: 2_000,
      operationTimeoutMs: 2_000,
    })
    relayHosts.push(hostClient)
    hostRuntime = createEphemeralHostPairingRuntime({
      relayClient: hostClient,
      relayOrigin: RELAY_ORIGIN,
      hostId: 'host.pairing.denied',
      hostDeviceId: 'device.windows.denied',
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      requestLocalDecision: async () => ({ decision: 'deny' }),
      commitAuthorizationLocally: async () => {
        localCommits += 1
        return { hostAuthorizationRevision: 1, nextGeneration: 1 }
      },
      now: () => NOW + 501,
    })
    await hostClient.connect()
    const invitation = await hostRuntime.createInvitation()
    let fragmentCleared = false
    await expect(pairEphemeralClientForTest({
      mode: 'r3-local-test',
      invitationFragment: invitation.invitationFragment,
      expectedRelayOrigin: RELAY_ORIGIN,
      webSocketUrl,
      deviceDisplayName: 'Denied Phone',
      clearInvitationFragment: () => { fragmentCleared = true },
      now: () => NOW + 501,
      timeoutMs: 2_000,
    }, nodeRelaySocketFactory())).rejects.toThrow('pair-denied')
    expect(fragmentCleared).toBe(true)
    expect(localCommits).toBe(0)
    expect(hostRuntime.readyChannel()).toBeUndefined()
  })
})
