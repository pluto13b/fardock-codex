import {
  acceptHostSessionReady,
  createClientPairJoin,
  createClientSessionConfirm,
  createClientSessionInit,
  deriveClientSessionAfterGenerationCommit,
  openClientPairResult,
  validateSessionAcceptForClient,
  type ClientAuthorizationMaterial,
  type InstallClientGeneration,
  type ClientSessionAuthorization,
  type EstablishedSessionChannel,
} from '@codex-plus/e2ee'
import {
  MAX_PAIRING_INVITATION_TTL_MS,
  decodePairResultFrame,
  type PairJoinFrame,
} from '@codex-plus/protocol'

import type {
  R3RelayClientCarrier,
  R3RelayWebSocketFactoryForTest,
  R3RelayWebSocketForTest,
} from './relay-carrier.ts'

const PAIR_TIMEOUT_MS = MAX_PAIRING_INVITATION_TTL_MS
const OPEN = 1
const CLOSED = 3

export interface EphemeralClientPairingOptions {
  readonly mode: 'r3-local-test' | 'production'
  readonly invitationFragment: string
  readonly expectedRelayOrigin: string
  readonly webSocketUrl: string
  readonly deviceDisplayName: string
  readonly clearInvitationFragment: () => void
  readonly onConfirmation?: (confirmation: Readonly<{
    sas: string
    clientSigningFingerprint: string
  }>) => void
  readonly now?: () => number
  readonly timeoutMs?: number
}

export interface EphemeralClientPairingResult {
  readonly authorization: ClientAuthorizationMaterial
  readonly sas: string
  readonly clientSigningFingerprint: string
}

export async function signEphemeralClientRelayChallenge(
  authorization: ClientAuthorizationMaterial,
  canonicalInput: Uint8Array,
): Promise<Uint8Array> {
  const signature = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    authorization.clientSigningPrivateKey,
    new Uint8Array(canonicalInput),
  )
  return new Uint8Array(signature)
}

function browserSocketFactory(input: Readonly<{
  url: string
  relayOrigin: string
  connectTimeoutMs: number
}>): R3RelayWebSocketForTest {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('websocket-unavailable')
  const socket = new globalThis.WebSocket(input.url)
  socket.binaryType = 'arraybuffer'
  return {
    get readyState() { return socket.readyState },
    send(frame) { socket.send(frame) },
    close(code, reason) { socket.close(code, reason) },
    onOpen(listener) { socket.addEventListener('open', listener) },
    onMessage(listener) {
      socket.addEventListener('message', event => listener(event.data, typeof event.data !== 'string'))
    },
    onError(listener) { socket.addEventListener('error', listener) },
    onClose(listener) { socket.addEventListener('close', listener) },
  }
}

function validatePairSocket(
  mode: EphemeralClientPairingOptions['mode'],
  webSocketUrl: string,
  relayOrigin: string,
): void {
  let socket: URL
  let origin: URL
  try {
    socket = new URL(webSocketUrl)
    origin = new URL(relayOrigin)
  } catch {
    throw new Error('invalid-pair-socket')
  }
  const commonInvalid = socket.pathname !== '/api/ws'
    || socket.search !== ''
    || socket.hash !== ''
    || socket.username !== ''
    || socket.password !== ''
    || origin.username !== ''
    || origin.password !== ''
    || origin.pathname !== '/'
    || origin.search !== ''
    || origin.hash !== ''
  if (commonInvalid) throw new Error('invalid-pair-socket')
  if (mode === 'r3-local-test') {
    if (
      socket.protocol !== 'ws:'
      || origin.protocol !== 'http:'
      || socket.hostname !== origin.hostname
      || (socket.hostname !== '127.0.0.1' && socket.hostname !== '[::1]')
      || socket.port === ''
      || origin.port === ''
    ) throw new Error('invalid-pair-socket')
    return
  }
  if (
    socket.protocol !== 'wss:'
    || origin.protocol !== 'https:'
    || origin.origin !== relayOrigin
    || socket.host !== origin.host
  ) throw new Error('invalid-pair-socket')
}

async function exchangePairJoin(
  mode: EphemeralClientPairingOptions['mode'],
  webSocketUrl: string,
  relayOrigin: string,
  join: PairJoinFrame,
  wireText: string,
  now: () => number,
  timeoutMs: number,
  socketFactory: R3RelayWebSocketFactoryForTest,
): Promise<string> {
  validatePairSocket(mode, webSocketUrl, relayOrigin)
  return await new Promise<string>((resolve, reject) => {
    let settled = false
    let socket: R3RelayWebSocketForTest
    const finish = (error?: Error, frame?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { if (socket.readyState !== CLOSED) socket.close(1000, 'pair-complete') } catch {}
      if (error !== undefined) reject(error)
      else if (frame !== undefined) resolve(frame)
      else reject(new Error('pair-result-missing'))
    }
    const timer = setTimeout(() => finish(new Error('pair-timeout')), timeoutMs)
    try {
      socket = socketFactory({ url: webSocketUrl, relayOrigin, connectTimeoutMs: timeoutMs })
    } catch {
      clearTimeout(timer)
      reject(new Error('pair-connect-failed'))
      return
    }
    socket.onOpen(() => {
      try {
        if (socket.readyState !== OPEN) throw new Error('pair-socket-not-open')
        socket.send(wireText)
      } catch {
        finish(new Error('pair-send-failed'))
      }
    })
    socket.onMessage((data, isBinary) => {
      if (isBinary || typeof data !== 'string') return finish(new Error('pair-protocol'))
      try {
        const result = decodePairResultFrame(data, { now: now() })
        if (
          result.hostId !== join.hostId
          || result.hostDeviceId !== join.hostDeviceId
          || result.pairSessionId !== join.pairSessionId
          || result.joinId !== join.joinId
        ) throw new Error('pair-route')
        finish(undefined, data)
      } catch {
        finish(new Error('pair-protocol'))
      }
    })
    socket.onError(() => finish(new Error('pair-socket-error')))
    socket.onClose(() => finish(new Error('pair-socket-closed')))
  })
}

export async function pairEphemeralClient(
  options: EphemeralClientPairingOptions,
): Promise<EphemeralClientPairingResult> {
  return pairEphemeralClientForTest(options, browserSocketFactory)
}

/** @internal Node test seam. */
export async function pairEphemeralClientForTest(
  options: EphemeralClientPairingOptions,
  socketFactory: R3RelayWebSocketFactoryForTest,
): Promise<EphemeralClientPairingResult> {
  if (options.mode !== 'r3-local-test' && options.mode !== 'production') {
    throw new Error('invalid-pair-mode')
  }
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? PAIR_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PAIR_TIMEOUT_MS) {
    throw new Error('invalid-pair-timeout')
  }
  if (options.onConfirmation !== undefined && typeof options.onConfirmation !== 'function') {
    throw new Error('invalid-pair-confirmation')
  }
  const join = await createClientPairJoin({
    invitationFragment: options.invitationFragment,
    expectedRelayOrigin: options.expectedRelayOrigin,
    deviceDisplayName: options.deviceDisplayName,
    now: now(),
  })
  options.clearInvitationFragment()
  options.onConfirmation?.(Object.freeze({
    sas: join.sas,
    clientSigningFingerprint: join.clientSigningFingerprint,
  }))
  const resultFrame = await exchangePairJoin(
    options.mode,
    options.webSocketUrl,
    options.expectedRelayOrigin,
    join.frame,
    join.wireText,
    now,
    timeoutMs,
    socketFactory,
  )
  const opened = await openClientPairResult(join.handle, resultFrame, now())
  if (opened.outcome !== 'approved') throw new Error(`pair-${opened.outcome}`)
  return Object.freeze({
    authorization: opened.authorization,
    sas: join.sas,
    clientSigningFingerprint: join.clientSigningFingerprint,
  })
}

export async function establishEphemeralClientSession(input: {
  readonly authorization: ClientAuthorizationMaterial
  readonly carrier: R3RelayClientCarrier
  readonly installGeneration?: InstallClientGeneration
  readonly now?: () => number
}): Promise<EstablishedSessionChannel> {
  const now = input.now ?? Date.now
  const authorization: ClientSessionAuthorization = {
    status: 'active',
    grantClaims: input.authorization.grantClaims,
    grantClaimsHash: input.authorization.grantClaimsHash,
    hostGrantSignature: input.authorization.hostGrantSignature,
    hostAgreementPublicKey: input.authorization.hostAgreementPublicKey,
    hostSigningPublicKey: input.authorization.hostSigningPublicKey,
    clientAgreementPrivateKey: input.authorization.clientAgreementPrivateKey,
    clientSigningPrivateKey: input.authorization.clientSigningPrivateKey,
  }
  const init = await createClientSessionInit({
    authorization,
    now: now(),
    expiresAt: now() + 30_000,
  })
  const acceptFrame = await input.carrier.exchangeSessionInit(init.frame)
  let highWater = 0
  const validated = await validateSessionAcceptForClient({
    state: init,
    frame: acceptFrame,
    now: now(),
    installGeneration: input.installGeneration ?? (async request => {
      const previous = highWater
      if (request.connectionGeneration <= previous) throw new Error('generation-replay')
      highWater = request.connectionGeneration
      return previous
    }),
  })
  const awaiting = await deriveClientSessionAfterGenerationCommit({ state: validated })
  const readyFrame = new Promise<string>((resolve, reject) => {
    let unsubscribe = (): void => {}
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('session-ready-timeout'))
    }, 30_000)
    try {
      unsubscribe = input.carrier.subscribe(frame => {
        clearTimeout(timeout)
        unsubscribe()
        if (typeof frame === 'string') resolve(frame)
        else resolve(new TextDecoder('utf-8', { fatal: true }).decode(frame))
      })
    } catch (error) {
      clearTimeout(timeout)
      reject(error)
    }
  })
  let confirm
  try {
    confirm = await createClientSessionConfirm({
      state: awaiting,
      now: now(),
      expiresAt: now() + 10_000,
    })
  } catch {
    throw new Error('client-stage:create-session-confirm')
  }
  let receipt
  try {
    receipt = await input.carrier.sendEnvelope(confirm.wireText)
  } catch {
    throw new Error('client-stage:send-session-confirm')
  }
  if (receipt.state !== 'relayed') throw new Error('session-confirm-unavailable')
  let frame
  try {
    frame = await readyFrame
  } catch {
    throw new Error('client-stage:wait-session-ready')
  }
  try {
    return await acceptHostSessionReady({ state: awaiting, frame, now: now() })
  } catch {
    throw new Error('client-stage:accept-session-ready')
  }
}
