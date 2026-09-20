import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeRelayNotAuthenticated,
  encodePairingInvitationFragment,
  encodeRelayDeviceHello,
  decodeRelayDeviceChallenge, encodeRelayDeviceProof, encodeRelayDeviceProofSignatureInput,
  encodeRelayPairOpen, decodeRelayPairOpened,
  encodeRelayPairCodeRegister, decodeRelayPairCodeRegistered, encodeRelayPairClose,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  type P256PublicJwk,
} from '@codex-plus/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { type ClientOptions, type RawData } from 'ws'

import {
  createProductionGateway,
  createOwnerPasswordVerifier,
  createR3LocalTestRelayServer,
  createR3ProductionRelayServer,
  openR3RelayStateStore,
  ProductionGatewayStartError,
  R3_RELAY_CLOSE,
  type ProductionGateway,
  type ProductionGatewayConfig,
  type OwnerPasswordVerifier,
  type R3ProductionRelayServerOptions,
  type R3RelayServerOptions,
  type RelayLogEntry,
} from '../src/index.ts'

const sharedRoot = fileURLToPath(new URL('../../../.tmp/relay-production-tests/', import.meta.url))
const testRoot = join(sharedRoot, `gateway-${process.pid}-${randomUUID()}`)
const publicOrigin = 'https://gateway.example.test'
const bootstrapCredential = Buffer.alloc(32, 0x31).toString('base64url')
const gateways = new Set<ProductionGateway>()
const sockets = new Set<WebSocket>()
let caseCounter = 0
let ownerVerifier: OwnerPasswordVerifier | undefined

interface SigningIdentity {
  privateKey: KeyObject
  publicKey: P256PublicJwk
  fingerprint: string
}

function identity(): SigningIdentity {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  if (exported.kty !== 'EC' || exported.crv !== 'P-256' || !exported.x || !exported.y) {
    throw new Error('Unexpected test key.')
  }
  const publicKey = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y } as const
  const fingerprint = Buffer.from(JSON.stringify({
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  }))
  return {
    privateKey: pair.privateKey,
    publicKey,
    fingerprint: createHash('sha256').update(fingerprint).digest('base64url'),
  }
}

function pairingFragment(issuedAt: number, expiresAt: number): string {
  const agreement = identity()
  const signing = identity()
  return encodePairingInvitationFragment({
    protocolVersion: PROTOCOL_VERSION,
    relayOrigin: publicOrigin,
    hostId: 'host.pairing-code',
    hostDeviceId: 'device.windows',
    pairSessionId: `pair.${issuedAt}`,
    issuedAt,
    expiresAt,
    rendezvousSecret: Buffer.alloc(32, 21).toString('base64url'),
    hostEphemeralAgreementKey: agreement.publicKey,
    hostSigningKey: signing.publicKey,
    hostKeyFingerprint: signing.fingerprint,
    invitationSignature: Buffer.alloc(64, 23).toString('base64url'),
  })
}

interface GatewayCase {
  directory: string
  stateFile: string
  webRoot: string
  secretFile: string
  ownerVerifierFile: string
  config: ProductionGatewayConfig
}

async function createCase(overrides: Partial<ProductionGatewayConfig> = {}): Promise<GatewayCase> {
  caseCounter += 1
  const directory = join(testRoot, String(caseCounter))
  const webRoot = join(directory, 'web')
  const stateFile = join(directory, 'data', 'relay-state.json')
  const secretFile = join(directory, 'relay-bootstrap')
  const ownerVerifierFile = join(directory, 'owner-verifier.json')
  if (ownerVerifier === undefined) throw new Error('Owner verifier fixture is unavailable.')
  await mkdir(join(webRoot, 'assets'), { recursive: true })
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><title>Codex Plus</title><div id="root"></div><script type="module" src="/assets/app.js"></script>',
    'utf8',
  )
  await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.__CODEX_PLUS_TEST__=true', 'utf8')
  await writeFile(secretFile, bootstrapCredential, 'utf8')
  await writeFile(ownerVerifierFile, JSON.stringify(ownerVerifier), 'utf8')
  const config: ProductionGatewayConfig = {
    mode: 'production',
    bind: '127.0.0.1',
    port: 0,
    publicOrigin,
    trustedProxyIps: ['127.0.0.1'],
    stateFile,
    webRoot,
    bootstrapCredential,
    bootstrapCredentialFile: secretFile,
    ownerVerifier,
    ownerVerifierFile,
    logLevel: 'info',
    ...overrides,
  }
  return { directory, stateFile, webRoot, secretFile, ownerVerifierFile, config }
}

async function startGateway(
  overrides: Partial<ProductionGatewayConfig> = {},
  logs: RelayLogEntry[] = [],
): Promise<Readonly<GatewayCase & { httpOrigin: string; webSocketUrl: string }>> {
  const value = await createCase(overrides)
  const gateway = await createProductionGateway(value.config, {
    logger: entry => logs.push(entry),
  })
  gateways.add(gateway)
  const address = await gateway.listen()
  return { ...value, httpOrigin: address.httpOrigin, webSocketUrl: address.webSocketUrl }
}

function rawBuffer(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}

async function connect(url: string, options: ClientOptions = {}): Promise<WebSocket> {
  const socket = new WebSocket(url, options)
  sockets.add(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('connection-failed')))
  })
  return socket
}

function proxyHeaders(): Readonly<Record<string, string>> {
  const host = new URL(publicOrigin).host
  return {
    host,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': host,
  }
}

function productionSocketOptions(
  origin?: string,
  headerOverrides: Readonly<Record<string, string>> = {},
): ClientOptions {
  return {
    ...(origin === undefined ? {} : { origin }),
    headers: { ...proxyHeaders(), ...headerOverrides },
  }
}

async function productionFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url)
  const headers = Object.fromEntries(new Headers(init.headers).entries())
  const body = typeof init.body === 'string' ? init.body : undefined
  return await new Promise<Response>((resolve, reject) => {
    const request = httpRequest({
      host: target.hostname,
      port: target.port,
      method: init.method ?? 'GET',
      path: `${target.pathname}${target.search}`,
      headers: {
        ...proxyHeaders(),
        ...headers,
        ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => {
        const status = response.statusCode ?? 500
        resolve(new Response(status === 204 ? null : Buffer.concat(chunks), {
          status,
          headers: response.headers as Record<string, string>,
        }))
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}

async function nextText(socket: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame-timeout')), 2_000)
    socket.once('message', (data, isBinary) => {
      clearTimeout(timer)
      if (isBinary) reject(new Error('unexpected-binary-frame'))
      else resolve(rawBuffer(data).toString('utf8'))
    })
  })
}

async function closed(socket: WebSocket): Promise<Readonly<{ code: number; reason: string }>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close-timeout')), 2_000)
    socket.once('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: reason.toString('utf8') })
    })
  })
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
  ownerVerifier = await createOwnerPasswordVerifier({
    username: 'owner',
    password: 'test owner password',
  }, () => Buffer.alloc(16, 9))
})

async function authenticatedCodeHost(started: { webSocketUrl: string }) {
  const signing = identity()
  const socket = await connect(started.webSocketUrl, productionSocketOptions(publicOrigin))
  const challengeReply = nextText(socket)
  socket.send(encodeRelayDeviceHello({
    protocolVersion: PROTOCOL_VERSION, relayType: 'device.hello', relayOrigin: publicOrigin,
    role: 'host', authMode: 'bootstrap', hostId: 'host.pairing-code', hostDeviceId: 'device.windows', deviceId: 'device.windows',
    bootstrapCredential, hostSigningKey: signing.publicKey, hostSigningFingerprint: signing.fingerprint,
  }))
  const challenge = decodeRelayDeviceChallenge(await challengeReply, publicOrigin)
  const welcome = nextText(socket)
  socket.send(encodeRelayDeviceProof({
    protocolVersion: PROTOCOL_VERSION, relayType: 'device.proof', relayOrigin: publicOrigin,
    role: 'host', authMode: 'bootstrap', hostId: 'host.pairing-code', hostDeviceId: 'device.windows', deviceId: 'device.windows',
    hostSigningFingerprint: signing.fingerprint, challengeId: challenge.challengeId,
    signature: sign('sha256', encodeRelayDeviceProofSignatureInput(challenge), { key: signing.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  }))
  await welcome
  return socket
}

async function openCodeInvitation(socket: WebSocket) {
  const now = Date.now(), expiresAt = now + 120_000
  const route = { protocolVersion: PROTOCOL_VERSION, hostId: 'host.pairing-code', hostDeviceId: 'device.windows', pairSessionId: `pair.${now}`, expiresAt }
  const opened = nextText(socket)
  socket.send(encodeRelayPairOpen({ ...route, relayType: 'pair.open' }))
  decodeRelayPairOpened(await opened)
  return { ...route, relayType: 'pair.code.register' as const, invitationFragment: pairingFragment(now, expiresAt) }
}

describe('Windows local pairing code Gateway control', () => {
  it('rejects anonymous registration without exposing a code', async () => {
    const started = await startGateway()
    const socket = await connect(started.webSocketUrl, productionSocketOptions(publicOrigin))
    const response = nextText(socket), close = closed(socket), now = Date.now()
    socket.send(encodeRelayPairCodeRegister({ protocolVersion: 1, relayType: 'pair.code.register', hostId: 'host.pairing-code', hostDeviceId: 'device.windows', pairSessionId: `pair.${now}`, expiresAt: now + 120_000, invitationFragment: pairingFragment(now, now + 120_000) }))
    expect(decodeRelayNotAuthenticated(await response).code).toBe('not-authenticated')
    expect((await close).code).toBe(R3_RELAY_CLOSE.notAuthenticated)
  })

  it.each(['foreign-host', 'wrong-session', 'wrong-expiry', 'duplicate'] as const)('rejects %s registration', async kind => {
    const started = await startGateway()
    const socket = await authenticatedCodeHost(started)
    const request = await openCodeInvitation(socket)
    if (kind === 'duplicate') {
      const first = nextText(socket)
      socket.send(encodeRelayPairCodeRegister(request))
      expect(decodeRelayPairCodeRegistered(await first).code).toHaveLength(8)
    }
    const close = closed(socket)
    socket.send(encodeRelayPairCodeRegister({ ...request,
      ...(kind === 'foreign-host' ? { hostId: 'host.other' } : {}),
      ...(kind === 'wrong-session' ? { pairSessionId: 'pair.other' } : {}),
      ...(kind === 'wrong-expiry' ? { expiresAt: request.expiresAt - 1 } : {}),
    }))
    expect((await close).code).toBe(R3_RELAY_CLOSE.protocolViolation)
  })

  it.each(['close', 'disconnect'] as const)('clears the code on Host %s and keeps code/fragment out of logs', async kind => {
    const logs: RelayLogEntry[] = []
    const started = await startGateway({}, logs)
    const socket = await authenticatedCodeHost(started)
    const request = await openCodeInvitation(socket)
    const response = nextText(socket)
    socket.send(encodeRelayPairCodeRegister(request))
    const registered = decodeRelayPairCodeRegistered(await response)
    const login = await productionFetch(`${started.httpOrigin}/api/auth/login`, {
      method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'test owner password' }),
    })
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!
    if (kind === 'close') {
      socket.send(encodeRelayPairClose({ protocolVersion: 1, relayType: 'pair.close', hostId: request.hostId, hostDeviceId: request.hostDeviceId, pairSessionId: request.pairSessionId, reason: 'cancelled' }))
      await openCodeInvitation(socket) // Ordered acknowledgement after the close.
    } else {
      const close = closed(socket); socket.close(); await close
    }
    const redeemed = await productionFetch(`${started.httpOrigin}/api/pairing-code/redeem`, {
      method: 'POST', headers: { origin: publicOrigin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ code: registered.code }),
    })
    expect(redeemed.status).toBe(404)
    expect(JSON.stringify(logs)).not.toContain(registered.code)
    expect(JSON.stringify(logs)).not.toContain(request.invitationFragment)
  })
})

afterEach(async () => {
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
  sockets.clear()
  await Promise.all([...gateways].map(gateway => gateway.close().catch(() => undefined)))
  gateways.clear()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('Production Gateway HTTP surface', () => {
  it('logs the single owner in with an HttpOnly cookie and invalidates logout', async () => {
    const started = await startGateway()
    const anonymous = await productionFetch(`${started.httpOrigin}/api/auth/session`)
    expect(anonymous.status).toBe(200)
    expect(await anonymous.json()).toEqual({ authenticated: false })

    const wrong = await productionFetch(`${started.httpOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'wrong password' }),
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ authenticated: false })

    const login = await productionFetch(`${started.httpOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'test owner password' }),
    })
    expect(login.status).toBe(200)
    expect(await login.json()).toEqual({ authenticated: true, username: 'owner' })
    const setCookie = login.headers.get('set-cookie')
    expect(setCookie).toContain('__Host-codex_plus_owner=')
    expect(setCookie).toContain('Secure; HttpOnly; SameSite=Strict')
    const cookie = setCookie?.split(';', 1)[0]
    expect(cookie).toBeTruthy()

    const authenticated = await productionFetch(`${started.httpOrigin}/api/auth/session`, {
      headers: { cookie: cookie! },
    })
    expect(await authenticated.json()).toEqual({ authenticated: true, username: 'owner' })
    const logout = await productionFetch(`${started.httpOrigin}/api/auth/logout`, {
      method: 'POST',
      headers: { origin: publicOrigin, cookie: cookie! },
    })
    expect(logout.status).toBe(204)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await (await productionFetch(`${started.httpOrigin}/api/auth/session`, {
      headers: { cookie: cookie! },
    })).json()).toEqual({ authenticated: false })
  })

  it('registers and one-time redeems an owner-gated pairing code without logging secrets', async () => {
    const logs: RelayLogEntry[] = []
    const started = await startGateway({}, logs)
    const now = Date.now()
    const fragment = pairingFragment(now - 1_000, now + 120_000)
    const registerBody = JSON.stringify({ invitationFragment: fragment, expiresAt: now + 120_000 })
    const anonymous = await productionFetch(`${started.httpOrigin}/api/pairing-code/register`, {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: registerBody,
    })
    expect(anonymous.status).toBe(401)

    const login = await productionFetch(`${started.httpOrigin}/api/auth/login`, {
      method: 'POST',
      headers: { origin: publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'test owner password' }),
    })
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    expect(cookie).toBeTruthy()

    expect((await productionFetch(`${started.httpOrigin}/api/pairing-code/register`, {
      method: 'POST',
      headers: { origin: 'https://other.example.test', cookie: cookie!, 'content-type': 'application/json' },
      body: registerBody,
    })).status).toBe(403)

    const registered = await productionFetch(`${started.httpOrigin}/api/pairing-code/register`, {
      method: 'POST',
      headers: { origin: publicOrigin, cookie: cookie!, 'content-type': 'application/json' },
      body: registerBody,
    })
    expect(registered.status).toBe(200)
    const registeredBody = await registered.json() as { code: string; expiresAt: number; ok: boolean }
    expect(registeredBody).toMatchObject({ ok: true, expiresAt: now + 120_000 })
    expect(registeredBody.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/u)

    const humanCode = `${registeredBody.code.slice(0, 4)}-${registeredBody.code.slice(4)}`.toLowerCase()
    const redeemed = await productionFetch(`${started.httpOrigin}/api/pairing-code/redeem`, {
      method: 'POST',
      headers: { origin: publicOrigin, cookie: cookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ code: humanCode }),
    })
    expect(redeemed.status).toBe(200)
    expect(await redeemed.json()).toEqual({ ok: true, invitationFragment: fragment, expiresAt: now + 120_000 })
    expect((await productionFetch(`${started.httpOrigin}/api/pairing-code/redeem`, {
      method: 'POST',
      headers: { origin: publicOrigin, cookie: cookie!, 'content-type': 'application/json' },
      body: JSON.stringify({ code: registeredBody.code }),
    })).status).toBe(404)
    const logText = JSON.stringify(logs)
    expect(logText).not.toContain(fragment)
    expect(logText).not.toContain(registeredBody.code)
  })

  it('pins local-test and production factories at runtime after TypeScript erasure', async () => {
    const value = await createCase()
    expect(() => createR3LocalTestRelayServer({
      mode: 'production',
      stateFile: value.stateFile,
      relayOrigin: publicOrigin,
      requestHandler: () => {},
    } as unknown as R3RelayServerOptions)).toThrow('explicit r3-local-test mode')
    expect(() => createR3ProductionRelayServer({
      mode: 'r3-local-test',
      stateFile: value.stateFile,
      relayOrigin: 'http://127.0.0.1:41740',
      bootstrapCredential,
    } as unknown as R3ProductionRelayServerOptions)).toThrow('explicit production mode')
  })

  it('serves only the formal SPA surface, fixed health, and assets on one port', async () => {
    const started = await startGateway()
    const health = await fetch(`${started.httpOrigin}/healthz`)
    expect(health.status).toBe(200)
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(await health.text()).toBe('{"status":"ok"}')

    for (const route of ['/', '/pair', '/manage']) {
      const response = await productionFetch(`${started.httpOrigin}${route}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('content-security-policy')).toContain('script-src \'self\'')
      expect(response.headers.get('content-security-policy')).toContain('wss://gateway.example.test')
      expect(response.headers.get('permissions-policy')).toBe(
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      )
      expect(await response.text()).toContain('<title>Codex Plus</title>')
    }

    const asset = await productionFetch(`${started.httpOrigin}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8')

    const head = await productionFetch(`${started.httpOrigin}/assets/app.js`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    for (const route of [
      '/api/ws',
      '/api/local-demo-login',
      '/unknown',
      '/assets',
      '/relay-bootstrap',
      '/C:/Windows/win.ini',
    ]) {
      expect((await productionFetch(`${started.httpOrigin}${route}`)).status).toBe(404)
    }
    expect((await productionFetch(`${started.httpOrigin}/`, { method: 'POST' })).status).toBe(405)
    expect(new URL(started.webSocketUrl).port).toBe(new URL(started.httpOrigin).port)
  })

  it('fails before listen when bootstrap, state, or the formal Web root is unavailable', async () => {
    const missingBootstrap = await createCase({
      bootstrapCredential: undefined,
      bootstrapCredentialFile: undefined,
    })
    await expect(createProductionGateway(missingBootstrap.config)).rejects.toEqual(
      new ProductionGatewayStartError('bootstrap-required'),
    )

    const corrupt = await createCase()
    await mkdir(join(corrupt.directory, 'data'), { recursive: true })
    await writeFile(corrupt.stateFile, '{"stateVersion":999}', 'utf8')
    await expect(createProductionGateway(corrupt.config)).rejects.toEqual(
      new ProductionGatewayStartError('state-unavailable'),
    )

    const missingWeb = await createCase({ webRoot: join(testRoot, 'missing-web') })
    await expect(createProductionGateway(missingWeb.config)).rejects.toEqual(
      new ProductionGatewayStartError('invalid-config'),
    )

    const sourceWeb = await createCase()
    await writeFile(
      join(sourceWeb.webRoot, 'index.html'),
      '<!doctype html><title>Codex Plus</title><script type="module" src="/src/main.tsx"></script>',
      'utf8',
    )
    await expect(createProductionGateway(sourceWeb.config)).rejects.toEqual(
      new ProductionGatewayStartError('web-unavailable'),
    )

    const overlap = await createCase()
    await expect(createProductionGateway({
      ...overlap.config,
      stateFile: join(overlap.webRoot, 'assets', 'relay-state.json'),
    })).rejects.toEqual(new ProductionGatewayStartError('invalid-config'))
    await expect(createProductionGateway({
      ...overlap.config,
      bootstrapCredentialFile: join(overlap.webRoot, 'assets', 'relay-bootstrap'),
    })).rejects.toEqual(new ProductionGatewayStartError('invalid-config'))
  })

  it('rechecks a previously closed registration at the actual listen boundary', async () => {
    const value = await createCase()
    const host = identity()
    const store = await openR3RelayStateStore(value.stateFile)
    await store.bootstrapHost({
      hostId: 'host.production',
      hostDeviceId: 'device.production.host',
      hostSigningKey: host.publicKey,
      hostSigningFingerprint: host.fingerprint,
    })
    await store.close()

    const config: ProductionGatewayConfig = { ...value.config }
    delete config.bootstrapCredential
    delete config.bootstrapCredentialFile
    const restart = await createProductionGateway(config)
    gateways.add(restart)
    const address = await restart.listen()
    expect(await (await fetch(`${address.httpOrigin}/healthz`)).text()).toBe('{"status":"ok"}')
    await restart.close()

    const gateway = await createProductionGateway(config)
    gateways.add(gateway)
    await rm(value.stateFile)
    await expect(gateway.listen()).rejects.toThrow('Production R3 Relay state is unavailable')
  })

  it('requires the configured direct proxy peer and exact forwarded Host/proto headers', async () => {
    const started = await startGateway()
    expect((await fetch(`${started.httpOrigin}/`)).status).toBe(403)
    expect((await productionFetch(`${started.httpOrigin}/`, {
      headers: { 'x-forwarded-proto': 'http' },
    })).status).toBe(403)
    expect((await productionFetch(`${started.httpOrigin}/`, {
      headers: { 'x-forwarded-host': 'wrong.example.test' },
    })).status).toBe(403)

    const untrusted = await startGateway({ trustedProxyIps: ['192.0.2.1'] })
    expect((await productionFetch(`${untrusted.httpOrigin}/`)).status).toBe(403)
    expect((await fetch(`${untrusted.httpOrigin}/healthz`)).status).toBe(200)
  })
})

describe('Production Gateway WebSocket boundary', () => {
  it('requires the exact production Origin and fails closed for unauthenticated frames', async () => {
    const logs: RelayLogEntry[] = []
    const started = await startGateway({}, logs)

    await expect(connect(started.webSocketUrl, productionSocketOptions())).rejects.toThrow('connection-failed')
    await expect(connect(started.webSocketUrl, productionSocketOptions('https://wrong.example.test')))
      .rejects.toThrow('connection-failed')
    await expect(connect(
      `${started.webSocketUrl}?query=forbidden`,
      productionSocketOptions(publicOrigin),
    )).rejects.toThrow('connection-failed')
    await expect(connect(
      started.webSocketUrl,
      productionSocketOptions(publicOrigin, { 'x-forwarded-proto': 'http' }),
    )).rejects.toThrow('connection-failed')

    const unauthenticated = await connect(started.webSocketUrl, productionSocketOptions(publicOrigin))
    const closePromise = closed(unauthenticated)
    unauthenticated.send(JSON.stringify({
      prompt: 'D1_LOG_BAIT',
      path: 'D:\\secret',
      token: 'TOKEN_BAIT',
      pairingSecret: 'PAIRING_SECRET_BAIT',
      ciphertext: 'CIPHERTEXT_BAIT',
    }))
    expect(decodeRelayNotAuthenticated(await nextText(unauthenticated))).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'error',
      code: 'not-authenticated',
    })
    expect(await closePromise).toMatchObject({ code: R3_RELAY_CLOSE.notAuthenticated })
    expect(JSON.stringify(logs)).not.toMatch(
      /D1_LOG_BAIT|D:\\\\secret|TOKEN_BAIT|PAIRING_SECRET_BAIT|CIPHERTEXT_BAIT/,
    )
  })

  it('rejects a validly shaped but mismatched bootstrap credential and oversized frame', async () => {
    const started = await startGateway()
    const host = identity()
    const wrongCredential = Buffer.alloc(32, 0x44).toString('base64url')
    const socket = await connect(started.webSocketUrl, productionSocketOptions(publicOrigin))
    const closePromise = closed(socket)
    socket.send(encodeRelayDeviceHello({
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'device.hello',
      relayOrigin: publicOrigin,
      role: 'host',
      authMode: 'bootstrap',
      hostId: 'host.production',
      hostDeviceId: 'device.production.host',
      deviceId: 'device.production.host',
      bootstrapCredential: wrongCredential,
      hostSigningKey: host.publicKey,
      hostSigningFingerprint: host.fingerprint,
    }))
    expect(decodeRelayNotAuthenticated(await nextText(socket))).toMatchObject({
      relayType: 'error',
      code: 'not-authenticated',
    })
    expect(await closePromise).toMatchObject({ code: R3_RELAY_CLOSE.notAuthenticated })

    const oversized = await connect(started.webSocketUrl, productionSocketOptions(publicOrigin))
    const oversizedClose = closed(oversized)
    oversized.send('x'.repeat(MAX_FRAME_BYTES + 1))
    expect((await oversizedClose).code).not.toBe(1000)
  })
})
