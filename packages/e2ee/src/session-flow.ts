import {
  GrantClaimsSchema,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  ProtocolViolation,
  decodeBase64Url,
  decodeSessionAccept,
  decodeSessionInit,
  decodeApplicationMessage,
  encodeBase64Url,
  encodeApplicationMessage,
  encodeGrantClaims,
  encodeGrantSignatureInput,
  encodeSessionAccept,
  encodeSessionAcceptSignatureInput,
  encodeSessionInit,
  encodeSessionInitHashInput,
  encodeSessionInitSignatureInput,
  encodeSessionTranscript,
  type EnvelopeHeader,
  type GrantClaims,
  type SessionAccept,
  type SessionInit,
} from '@codex-plus/protocol'

import {
  openApplicationEnvelope,
  sealApplicationEnvelope,
  type DirectionalChannelExpectation,
  type OpenedApplicationEnvelope,
  type SealedApplicationEnvelope,
} from './channel.ts'
import { fingerprintP256PublicJwk } from './fingerprint.ts'
import {
  assertAgreementPublicKey,
  assertSigningPublicKey,
  exportPublicJwk,
  generateAgreementKeyPair,
  importAgreementPublicKey,
  importSigningPublicKey,
} from './keys.ts'
import {
  deriveEcdhSecret,
  deriveSessionMaterial,
  importAes256GcmKey,
  sha256,
  signP256,
  verifyP256,
} from './primitives.ts'
import { failE2ee, randomBytes16, randomBytes32 } from './runtime.ts'

const SESSION_CONTROL_TTL_MS = 30_000
const MAX_PENDING_SESSIONS_PER_AUTHORIZATION = 4
const MAX_UNACKNOWLEDGED_OUTBOUND_FRAMES = 16
const MAX_UNACKNOWLEDGED_OUTBOUND_BYTES = 8 * 1024 * 1024
const textEncoder = new TextEncoder()

declare const clientInitBrand: unique symbol
declare const hostValidatedBrand: unique symbol
declare const hostAwaitingBrand: unique symbol
declare const clientValidatedBrand: unique symbol
declare const clientAwaitingBrand: unique symbol
declare const hostConfirmedBrand: unique symbol
declare const establishedBrand: unique symbol

export interface ClientSessionAuthorization {
  readonly status: 'active'
  readonly grantClaims: GrantClaims
  readonly grantClaimsHash: string
  readonly hostGrantSignature: string
  /** Pinned by the verified pairing invitation, never sourced from grant claims. */
  readonly hostAgreementPublicKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
  readonly clientAgreementPrivateKey: CryptoKey
  readonly clientSigningPrivateKey: CryptoKey
}

export interface HostSessionAuthorization {
  readonly status: 'active'
  readonly grantClaims: GrantClaims
  readonly grantClaimsHash: string
  readonly hostGrantSignature: string
  /** Pinned local Host identity keys, never sourced from grant claims. */
  readonly hostAgreementPublicKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
  readonly hostAgreementPrivateKey: CryptoKey
  readonly hostSigningPrivateKey: CryptoKey
}

export interface HostGenerationReservationRequest {
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly handshakeId: string
  readonly clientNonce: string
}

/**
 * Trusted platform boundary. The implementation atomically rechecks that the
 * authorization is active, rejects replayed handshake/nonces, and durably
 * burns a strictly increasing generation before resolving.
 */
export type ReserveHostGeneration = (
  request: Readonly<HostGenerationReservationRequest>,
) => Promise<number>

export interface ClientGenerationInstallRequest {
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly handshakeId: string
  readonly connectionGeneration: number
}

/**
 * Trusted platform boundary. The implementation atomically compares and
 * installs the signed generation, returning the previous durable high-water.
 */
export type InstallClientGeneration = (
  request: Readonly<ClientGenerationInstallRequest>,
) => Promise<number>

export interface SessionAuthority {
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly handshakeId: string
  readonly connectionGeneration: number
  readonly sessionTranscriptHash: string
}

export interface ClientSessionInitPending {
  readonly kind: 'client-session-init-pending'
  readonly frame: string
  readonly [clientInitBrand]: never
}

export interface HostValidatedSessionInit {
  readonly kind: 'host-validated-session-init'
  readonly [hostValidatedBrand]: never
}

export interface HostAwaitingSessionConfirm {
  readonly kind: 'host-awaiting-session-confirm'
  readonly frame: string
  readonly authority: SessionAuthority
  readonly [hostAwaitingBrand]: never
}

export interface ClientValidatedSessionAccept {
  readonly kind: 'client-validated-session-accept'
  readonly [clientValidatedBrand]: never
}

export interface ClientAwaitingSessionReady {
  readonly kind: 'client-awaiting-session-ready'
  readonly authority: SessionAuthority
  readonly [clientAwaitingBrand]: never
}

export interface HostConfirmedSession {
  readonly kind: 'host-confirmed-session'
  readonly authority: SessionAuthority
  readonly [hostConfirmedBrand]: never
}

export interface EstablishedSessionChannel {
  readonly kind: 'established-session-channel'
  readonly role: 'client' | 'host'
  readonly authority: SessionAuthority
  readonly [establishedBrand]: never
}

export interface EstablishedSessionChannelInfo {
  readonly role: 'client' | 'host'
  readonly authority: SessionAuthority
  readonly outboundKeyId: string
  readonly inboundKeyId: string
  readonly sequenceState: Readonly<{
    nextOutboundSequence: number
    maxSentSequence: number
    lastAcceptedInboundSequence: number
    lastPeerAck: number
  }>
}

export interface OutboundSequenceReservationRequest {
  readonly authority: SessionAuthority
  readonly keyId: string
  readonly direction: 'client-to-host' | 'host-to-client'
  readonly expectedSequence: number
  readonly header: Readonly<Omit<EnvelopeHeader, 'seq' | 'ack'>>
}

export interface OutboundFrameCommitRequest {
  readonly authority: SessionAuthority
  readonly keyId: string
  readonly sequence: number
  readonly wireText: string
}

export interface OutboundFramePersistenceAdapter {
  reserveSequence(request: Readonly<OutboundSequenceReservationRequest>): Promise<number>
  commitFrame(request: Readonly<OutboundFrameCommitRequest>): Promise<void>
}

export interface InboundFrameCommitRequest {
  readonly authority: SessionAuthority
  readonly keyId: string
  readonly sequence: number
  readonly ack: number
  readonly requestId?: string
  readonly taskId?: string
  readonly message: Readonly<OpenedApplicationEnvelope['message']>
}

/**
 * Trusted platform boundary. In one durable authority transaction it rechecks
 * the active epoch, reserves action idempotency, commits seq/ack, and deletes
 * persisted outbound raw frames through `ack`.
 */
export type CommitInboundFrame = (
  request: Readonly<InboundFrameCommitRequest>,
) => Promise<void>

export interface HostReadyResult {
  readonly ready: SealedApplicationEnvelope
  readonly channel: EstablishedSessionChannel
}

interface ValidatedAuthorization {
  claims: GrantClaims
  grantClaimsHash: string
  hostAgreementPublicKey: CryptoKey
  hostSigningPublicKey: CryptoKey
  clientAgreementPublicKey: CryptoKey
  clientSigningPublicKey: CryptoKey
  lineage: AuthorizationLineage
}

interface AuthorizationLineage {
  readonly side: 'client' | 'host'
  readonly hostId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  active: boolean
}

interface ClientInitSecret {
  authorization: ValidatedAuthorization
  clientAgreementPrivateKey: CryptoKey
  clientEphemeralKeyPair: CryptoKeyPair
  init: SessionInit
}

interface HostValidatedSecret {
  authorization: ValidatedAuthorization
  hostAgreementPrivateKey: CryptoKey
  hostSigningPrivateKey: CryptoKey
  init: SessionInit
  connectionGeneration: number
}

interface DirectionalSecrets {
  role: 'client' | 'host'
  phase: 'pending' | 'established'
  authorization: ValidatedAuthorization
  authority: SessionAuthority
  outboundKey: CryptoKey
  outboundNoncePrefix: Uint8Array
  outboundExpectation: DirectionalChannelExpectation
  inboundKey: CryptoKey
  inboundNoncePrefix: Uint8Array
  inboundExpectation: DirectionalChannelExpectation
  handshakeExpiresAt: number
  closed: boolean
  nextOutboundSequence: number
  maxSentSequence: number
  lastAcceptedInboundSequence: number
  lastPeerAck: number
  outboundBusy: boolean
  inboundBusy: boolean
  outboundFrames: Map<number, SealedApplicationEnvelope>
  outboundFrameBytes: number
}

interface HostAwaitingSecret extends DirectionalSecrets {
  ready?: HostReadyResult
  readyPromise?: Promise<HostReadyResult>
}

interface ClientValidatedSecret {
  authorization: ValidatedAuthorization
  clientAgreementPrivateKey: CryptoKey
  clientEphemeralKeyPair: CryptoKeyPair
  init: SessionInit
  accept: SessionAccept
  hostEphemeralPublicKey: CryptoKey
}

interface ClientAwaitingSecret extends DirectionalSecrets {
  confirm?: SealedApplicationEnvelope
  confirmPromise?: Promise<SealedApplicationEnvelope>
}

interface HostConfirmedSecret extends DirectionalSecrets {
  ready?: HostReadyResult
  readyPromise?: Promise<HostReadyResult>
}

const clientInitSecrets = new WeakMap<ClientSessionInitPending, ClientInitSecret>()
const hostValidatedSecrets = new WeakMap<HostValidatedSessionInit, HostValidatedSecret>()
const hostAwaitingSecrets = new WeakMap<HostAwaitingSessionConfirm, HostAwaitingSecret>()
const clientValidatedSecrets = new WeakMap<ClientValidatedSessionAccept, ClientValidatedSecret>()
const clientAwaitingSecrets = new WeakMap<ClientAwaitingSessionReady, ClientAwaitingSecret>()
const hostConfirmedSecrets = new WeakMap<HostConfirmedSession, HostConfirmedSecret>()
const establishedSecrets = new WeakMap<EstablishedSessionChannel, DirectionalSecrets>()
const activeDirectionalSecrets = new Set<DirectionalSecrets>()
const establishedByRoleAndAuthorization = new Map<string, DirectionalSecrets>()
const highestEstablishedGeneration = new Map<string, number>()
const authorizationLineages = new Map<string, AuthorizationLineage>()

function staleAuthority(): never {
  throw new ProtocolViolation('stale-authority')
}

function requireOpaqueState<T extends object, S>(map: WeakMap<T, S>, value: T): S {
  if (typeof value !== 'object' || value === null) return staleAuthority()
  const secret = map.get(value)
  if (secret === undefined) return staleAuthority()
  return secret
}

function requireSafeHighWater(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return staleAuthority()
  return value
}

function establishedRegistryKey(
  role: 'client' | 'host',
  authority: SessionAuthority,
): string {
  return `${role}\u0000${authority.hostId}\u0000${authority.authorizationId}`
}

function authorizationLineageKey(
  side: 'client' | 'host',
  hostId: string,
  authorizationId: string,
  authorizationEpoch: number,
): string {
  return `${side}\u0000${hostId}\u0000${authorizationId}\u0000${authorizationEpoch}`
}

function requireAuthorizationLineageActive(authorization: ValidatedAuthorization): void {
  if (!authorization.lineage.active) return staleAuthority()
}

function invalidateDirectionalSecret(secret: DirectionalSecrets): void {
  if (secret.closed) return
  secret.closed = true
  secret.outboundNoncePrefix.fill(0)
  secret.inboundNoncePrefix.fill(0)
  secret.outboundFrames.clear()
  secret.outboundFrameBytes = 0
  secret.outboundBusy = false
  secret.inboundBusy = false
  activeDirectionalSecrets.delete(secret)
  const key = establishedRegistryKey(secret.role, secret.authority)
  if (establishedByRoleAndAuthorization.get(key) === secret) {
    establishedByRoleAndAuthorization.delete(key)
  }
}

function sweepExpiredDirectional(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) return staleAuthority()
  let swept = 0
  for (const secret of [...activeDirectionalSecrets]) {
    if (secret.phase === 'pending' && secret.handshakeExpiresAt <= now) {
      invalidateDirectionalSecret(secret)
      swept += 1
    }
  }
  return swept
}

export function pruneExpiredSessionStates(now: number): number {
  return sweepExpiredDirectional(now)
}

function assertPendingCapacity(
  role: 'client' | 'host',
  authority: SessionAuthority,
): void {
  let pending = 0
  for (const secret of activeDirectionalSecrets) {
    if (
      secret.phase === 'pending'
      && secret.role === role
      && secret.authority.authorizationId === authority.authorizationId
      && secret.authority.hostId === authority.hostId
    ) {
      pending += 1
    }
  }
  if (pending >= MAX_PENDING_SESSIONS_PER_AUTHORIZATION) {
    throw new ProtocolViolation('rate-limited')
  }
}

function requireActiveDirectional(secret: DirectionalSecrets): void {
  requireAuthorizationLineageActive(secret.authorization)
  if (secret.closed || !activeDirectionalSecrets.has(secret)) return staleAuthority()
}

export type AssertSessionAuthorizationActive = (
  authority: Readonly<SessionAuthority>,
) => Promise<void>

async function checkAuthorizationActive(
  secret: DirectionalSecrets,
  check: AssertSessionAuthorizationActive,
): Promise<void> {
  requireActiveDirectional(secret)
  if (typeof check !== 'function') return staleAuthority()
  try {
    await check(secret.authority)
  } catch (error) {
    invalidateDirectionalSecret(secret)
    throw error
  }
  requireActiveDirectional(secret)
}

function requireControlTiming(now: number, expiresAt: number, handshakeExpiresAt: number): void {
  if (
    !Number.isSafeInteger(now)
    || !Number.isSafeInteger(expiresAt)
    || now < 0
    || expiresAt <= now
    || expiresAt - now > SESSION_CONTROL_TTL_MS
    || expiresAt > handshakeExpiresAt
  ) {
    throw new ProtocolViolation('ttl-exceeded')
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}

function requireDecodedBytes(value: string, length: number): Uint8Array {
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== length) {
    throw new ProtocolViolation('schema-invalid')
  }
  return decoded
}

function randomOpaqueIdentifier(prefix: 'handshake' | 'key'): string {
  return `${prefix}.${encodeBase64Url(randomBytes16())}`
}

async function canonicalGrantClaimsHash(claims: GrantClaims): Promise<string> {
  return encodeBase64Url(await sha256(textEncoder.encode(encodeGrantClaims(claims))))
}

async function validateAuthorization(
  authorization: ClientSessionAuthorization | HostSessionAuthorization,
): Promise<ValidatedAuthorization> {
  if (authorization === null || typeof authorization !== 'object' || authorization.status !== 'active') {
    return staleAuthority()
  }
  const suppliedGrantClaimsHash = authorization.grantClaimsHash
  const suppliedGrantSignature = authorization.hostGrantSignature
  const pinnedHostAgreementPublicKey = authorization.hostAgreementPublicKey
  const pinnedHostSigningPublicKey = authorization.hostSigningPublicKey
  const side = 'clientAgreementPrivateKey' in authorization ? 'client' : 'host'
  const result = GrantClaimsSchema.safeParse(authorization.grantClaims)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const claims = result.data
  const grantClaimsHash = await canonicalGrantClaimsHash(claims)
  if (suppliedGrantClaimsHash !== grantClaimsHash) return staleAuthority()

  const hostAgreementPublicKey = pinnedHostAgreementPublicKey
  const hostSigningPublicKey = pinnedHostSigningPublicKey
  assertAgreementPublicKey(hostAgreementPublicKey)
  assertSigningPublicKey(hostSigningPublicKey)
  const [pinnedHostAgreementJwk, pinnedHostSigningJwk, clientAgreementPublicKey, clientSigningPublicKey] = await Promise.all([
    exportPublicJwk(hostAgreementPublicKey),
    exportPublicJwk(hostSigningPublicKey),
    importAgreementPublicKey(claims.clientAgreementKey),
    importSigningPublicKey(claims.clientSigningKey),
  ])
  if (
    pinnedHostAgreementJwk.kty !== claims.hostAgreementKey.kty
    || pinnedHostAgreementJwk.crv !== claims.hostAgreementKey.crv
    || pinnedHostAgreementJwk.x !== claims.hostAgreementKey.x
    || pinnedHostAgreementJwk.y !== claims.hostAgreementKey.y
    || pinnedHostSigningJwk.kty !== claims.hostSigningKey.kty
    || pinnedHostSigningJwk.crv !== claims.hostSigningKey.crv
    || pinnedHostSigningJwk.x !== claims.hostSigningKey.x
    || pinnedHostSigningJwk.y !== claims.hostSigningKey.y
  ) {
    return staleAuthority()
  }
  const [hostFingerprint, clientFingerprint] = await Promise.all([
    fingerprintP256PublicJwk(claims.hostSigningKey),
    fingerprintP256PublicJwk(claims.clientSigningKey),
  ])
  if (
    hostFingerprint !== claims.hostSigningFingerprint
    || clientFingerprint !== claims.clientSigningFingerprint
  ) {
    return staleAuthority()
  }
  if (typeof suppliedGrantSignature !== 'string') return staleAuthority()
  const grantSignature = decodeBase64Url(suppliedGrantSignature)
  if (
    grantSignature === undefined
    || grantSignature.byteLength !== 64
    || !await verifyP256(
      hostSigningPublicKey,
      encodeGrantSignatureInput(claims),
      grantSignature,
    )
  ) {
    return staleAuthority()
  }
  const lineageKey = authorizationLineageKey(
    side,
    claims.hostId,
    claims.authorizationId,
    claims.authorizationEpoch,
  )
  let lineage = authorizationLineages.get(lineageKey)
  if (lineage === undefined) {
    lineage = {
      side,
      hostId: claims.hostId,
      authorizationId: claims.authorizationId,
      authorizationEpoch: claims.authorizationEpoch,
      active: true,
    }
    authorizationLineages.set(lineageKey, lineage)
  }
  if (!lineage.active) return staleAuthority()
  return {
    claims,
    grantClaimsHash,
    hostAgreementPublicKey,
    hostSigningPublicKey,
    clientAgreementPublicKey,
    clientSigningPublicKey,
    lineage,
  }
}

async function assertAgreementPrivateMatchesPublic(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  probe: CryptoKeyPair,
): Promise<void> {
  let left: Uint8Array | undefined
  let right: Uint8Array | undefined
  try {
    left = await deriveEcdhSecret(privateKey, probe.publicKey)
    right = await deriveEcdhSecret(probe.privateKey, publicKey)
    if (!bytesEqual(left, right)) return failE2ee('authentication-failed')
  } finally {
    left?.fill(0)
    right?.fill(0)
  }
}

function assertAuthorityMatchesClaims(
  value: Pick<SessionInit | SessionAccept,
    | 'relayOrigin'
    | 'hostId'
    | 'hostDeviceId'
    | 'clientDeviceId'
    | 'authorizationId'
    | 'authorizationEpoch'>,
  claims: GrantClaims,
): void {
  if (
    value.relayOrigin !== claims.relayOrigin
    || value.hostId !== claims.hostId
    || value.hostDeviceId !== claims.hostDeviceId
    || value.clientDeviceId !== claims.clientDeviceId
    || value.authorizationId !== claims.authorizationId
    || value.authorizationEpoch !== claims.authorizationEpoch
  ) {
    return staleAuthority()
  }
}

function sessionAuthority(
  init: SessionInit,
  accept: SessionAccept,
  sessionTranscriptHash: string,
): SessionAuthority {
  return Object.freeze({
    relayOrigin: init.relayOrigin,
    hostId: init.hostId,
    hostDeviceId: init.hostDeviceId,
    clientDeviceId: init.clientDeviceId,
    authorizationId: init.authorizationId,
    authorizationEpoch: init.authorizationEpoch,
    handshakeId: init.handshakeId,
    connectionGeneration: accept.connectionGeneration,
    sessionTranscriptHash,
  })
}

function directionalExpectation(
  authority: SessionAuthority,
  direction: 'client-to-host' | 'host-to-client',
  keyId: string,
): DirectionalChannelExpectation {
  const fromClient = direction === 'client-to-host'
  return Object.freeze({
    hostId: authority.hostId,
    fromDeviceId: fromClient ? authority.clientDeviceId : authority.hostDeviceId,
    toDeviceId: fromClient ? authority.hostDeviceId : authority.clientDeviceId,
    connectionGeneration: authority.connectionGeneration,
    keyId,
    authorizationId: authority.authorizationId,
    authorizationEpoch: authority.authorizationEpoch,
    sessionTranscriptHash: authority.sessionTranscriptHash,
    handshakeId: authority.handshakeId,
    fromRole: fromClient ? 'client' : 'host',
  })
}

async function deriveDirectionalSecrets(
  role: 'client' | 'host',
  authorization: ValidatedAuthorization,
  init: SessionInit,
  accept: SessionAccept,
  ephemeralSharedSecret: Uint8Array,
  longTermSharedSecret: Uint8Array,
): Promise<DirectionalSecrets> {
  const connectionIkm = new Uint8Array(64)
  connectionIkm.set(ephemeralSharedSecret, 0)
  connectionIkm.set(longTermSharedSecret, 32)
  ephemeralSharedSecret.fill(0)
  longTermSharedSecret.fill(0)

  let transcriptHashBytes: Uint8Array | undefined
  let clientToHostRaw: Uint8Array | undefined
  let hostToClientRaw: Uint8Array | undefined
  let clientToHostPrefix: Uint8Array | undefined
  let hostToClientPrefix: Uint8Array | undefined
  let prefixesTransferred = false
  try {
    transcriptHashBytes = await sha256(encodeSessionTranscript({
      sessionInit: init,
      sessionAccept: accept,
      grantClaimsHash: authorization.grantClaimsHash,
    }))
    const transcriptHash = encodeBase64Url(transcriptHashBytes)
    const authority = sessionAuthority(init, accept, transcriptHash)
    const baseContext = {
      transcriptHash32: transcriptHashBytes,
      hostId: authority.hostId,
      hostDeviceId: authority.hostDeviceId,
      clientDeviceId: authority.clientDeviceId,
      authorizationId: authority.authorizationId,
      authorizationEpoch: authority.authorizationEpoch,
      generation: authority.connectionGeneration,
    }
    clientToHostRaw = await deriveSessionMaterial(connectionIkm, {
      ...baseContext,
      direction: 'client-to-host',
      directionalKeyId: accept.clientToHostKeyId,
    }, 'aes-key')
    hostToClientRaw = await deriveSessionMaterial(connectionIkm, {
      ...baseContext,
      direction: 'host-to-client',
      directionalKeyId: accept.hostToClientKeyId,
    }, 'aes-key')
    if (bytesEqual(clientToHostRaw, hostToClientRaw)) {
      return failE2ee('crypto-operation-failed')
    }
    ;[clientToHostPrefix, hostToClientPrefix] = await Promise.all([
      deriveSessionMaterial(connectionIkm, {
        ...baseContext,
        direction: 'client-to-host',
        directionalKeyId: accept.clientToHostKeyId,
      }, 'nonce-prefix'),
      deriveSessionMaterial(connectionIkm, {
        ...baseContext,
        direction: 'host-to-client',
        directionalKeyId: accept.hostToClientKeyId,
      }, 'nonce-prefix'),
    ])
    if (bytesEqual(clientToHostPrefix, hostToClientPrefix)) {
      return failE2ee('crypto-operation-failed')
    }

    const [clientToHostKey, hostToClientKey] = await Promise.all([
      importAes256GcmKey(clientToHostRaw, role === 'client' ? 'encrypt' : 'decrypt'),
      importAes256GcmKey(hostToClientRaw, role === 'host' ? 'encrypt' : 'decrypt'),
    ])
    const clientToHostExpectation = directionalExpectation(
      authority,
      'client-to-host',
      accept.clientToHostKeyId,
    )
    const hostToClientExpectation = directionalExpectation(
      authority,
      'host-to-client',
      accept.hostToClientKeyId,
    )
    const result = role === 'client'
      ? {
          role,
          phase: 'pending' as const,
          authorization,
          authority,
          outboundKey: clientToHostKey,
          outboundNoncePrefix: clientToHostPrefix,
          outboundExpectation: clientToHostExpectation,
          inboundKey: hostToClientKey,
          inboundNoncePrefix: hostToClientPrefix,
          inboundExpectation: hostToClientExpectation,
          handshakeExpiresAt: Math.min(init.expiresAt, accept.expiresAt),
          closed: false,
          nextOutboundSequence: 2,
          maxSentSequence: 1,
          lastAcceptedInboundSequence: 1,
          lastPeerAck: 1,
          outboundBusy: false,
          inboundBusy: false,
          outboundFrames: new Map(),
          outboundFrameBytes: 0,
        }
      : {
          role,
          phase: 'pending' as const,
          authorization,
          authority,
          outboundKey: hostToClientKey,
          outboundNoncePrefix: hostToClientPrefix,
          outboundExpectation: hostToClientExpectation,
          inboundKey: clientToHostKey,
          inboundNoncePrefix: clientToHostPrefix,
          inboundExpectation: clientToHostExpectation,
          handshakeExpiresAt: Math.min(init.expiresAt, accept.expiresAt),
          closed: false,
          nextOutboundSequence: 2,
          maxSentSequence: 1,
          lastAcceptedInboundSequence: 1,
          lastPeerAck: 0,
          outboundBusy: false,
          inboundBusy: false,
          outboundFrames: new Map(),
          outboundFrameBytes: 0,
        }
    requireAuthorizationLineageActive(authorization)
    assertPendingCapacity(role, authority)
    prefixesTransferred = true
    activeDirectionalSecrets.add(result)
    return result
  } finally {
    connectionIkm.fill(0)
    transcriptHashBytes?.fill(0)
    clientToHostRaw?.fill(0)
    hostToClientRaw?.fill(0)
    if (!prefixesTransferred) {
      clientToHostPrefix?.fill(0)
      hostToClientPrefix?.fill(0)
    }
  }
}

export async function createClientSessionInit(input: {
  authorization: ClientSessionAuthorization
  now: number
  expiresAt: number
}): Promise<ClientSessionInitPending> {
  sweepExpiredDirectional(input.now)
  const now = input.now
  const expiresAt = input.expiresAt
  const authorizationInput = input.authorization
  const clientAgreementPrivateKey = authorizationInput?.clientAgreementPrivateKey
  const clientSigningPrivateKey = authorizationInput?.clientSigningPrivateKey
  requireControlTiming(now, expiresAt, expiresAt)
  const authorization = await validateAuthorization(authorizationInput)
  const clientEphemeralKeyPair = await generateAgreementKeyPair()
  await assertAgreementPrivateMatchesPublic(
    clientAgreementPrivateKey,
    authorization.clientAgreementPublicKey,
    clientEphemeralKeyPair,
  )
  const unsignedInit = {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'session.init' as const,
    relayOrigin: authorization.claims.relayOrigin,
    hostId: authorization.claims.hostId,
    hostDeviceId: authorization.claims.hostDeviceId,
    clientDeviceId: authorization.claims.clientDeviceId,
    authorizationId: authorization.claims.authorizationId,
    authorizationEpoch: authorization.claims.authorizationEpoch,
    handshakeId: randomOpaqueIdentifier('handshake'),
    clientNonce: encodeBase64Url(randomBytes32()),
    clientEphemeralAgreementKey: await exportPublicJwk(clientEphemeralKeyPair.publicKey),
    issuedAt: now,
    expiresAt,
  }
  const signature = await signP256(
    clientSigningPrivateKey,
    encodeSessionInitSignatureInput(unsignedInit),
  )
  const init = {
    ...unsignedInit,
    clientSignature: encodeBase64Url(signature),
  }
  const frame = encodeSessionInit(init)
  const canonicalInit = decodeSessionInit(frame, {
    expectedRelayOrigin: authorization.claims.relayOrigin,
    now,
  })
  if (!await verifyP256(
    authorization.clientSigningPublicKey,
    encodeSessionInitSignatureInput(canonicalInit),
    signature,
  )) {
    return failE2ee('authentication-failed')
  }
  requireAuthorizationLineageActive(authorization)
  const state = Object.freeze({
    kind: 'client-session-init-pending' as const,
    frame,
  }) as ClientSessionInitPending
  clientInitSecrets.set(state, {
    authorization,
    clientAgreementPrivateKey,
    clientEphemeralKeyPair,
    init: canonicalInit,
  })
  return state
}

export async function validateSessionInitForHost(input: {
  authorization: HostSessionAuthorization
  reserveGeneration: ReserveHostGeneration
  frame: string | Uint8Array
  now: number
}): Promise<HostValidatedSessionInit> {
  sweepExpiredDirectional(input.now)
  const authorizationInput = input.authorization
  const hostAgreementPrivateKey = authorizationInput?.hostAgreementPrivateKey
  const hostSigningPrivateKey = authorizationInput?.hostSigningPrivateKey
  const reserveGeneration = input.reserveGeneration
  const frame = typeof input.frame === 'string' ? input.frame : new Uint8Array(input.frame)
  const now = input.now
  const authorization = await validateAuthorization(authorizationInput)
  const init = decodeSessionInit(frame, {
    expectedRelayOrigin: authorization.claims.relayOrigin,
    now,
  })
  assertAuthorityMatchesClaims(init, authorization.claims)
  const clientEphemeralPublicKey = await importAgreementPublicKey(init.clientEphemeralAgreementKey)
  void clientEphemeralPublicKey
  const signature = requireDecodedBytes(init.clientSignature, 64)
  if (!await verifyP256(
    authorization.clientSigningPublicKey,
    encodeSessionInitSignatureInput(init),
    signature,
  )) {
    return failE2ee('authentication-failed')
  }
  if (typeof reserveGeneration !== 'function') return staleAuthority()
  const connectionGeneration = await reserveGeneration(Object.freeze({
    hostId: init.hostId,
    hostDeviceId: init.hostDeviceId,
    clientDeviceId: init.clientDeviceId,
    authorizationId: init.authorizationId,
    authorizationEpoch: init.authorizationEpoch,
    handshakeId: init.handshakeId,
    clientNonce: init.clientNonce,
  }))
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    return staleAuthority()
  }
  requireAuthorizationLineageActive(authorization)
  const state = Object.freeze({
    kind: 'host-validated-session-init' as const,
  }) as HostValidatedSessionInit
  hostValidatedSecrets.set(state, {
    authorization,
    hostAgreementPrivateKey,
    hostSigningPrivateKey,
    init,
    connectionGeneration,
  })
  return state
}

export async function createHostSessionAccept(input: {
  state: HostValidatedSessionInit
  now: number
  expiresAt: number
}): Promise<HostAwaitingSessionConfirm> {
  sweepExpiredDirectional(input.now)
  const validatedState = input.state
  const now = input.now
  const requestedExpiresAt = input.expiresAt
  const secret = requireOpaqueState(hostValidatedSecrets, validatedState)
  hostValidatedSecrets.delete(validatedState)
  requireAuthorizationLineageActive(secret.authorization)
  if (
    !Number.isSafeInteger(requestedExpiresAt)
    || requestedExpiresAt <= now
    || requestedExpiresAt - now > SESSION_CONTROL_TTL_MS
  ) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  const issuedAt = Math.max(now, secret.init.issuedAt)
  const expiresAt = Math.min(requestedExpiresAt, secret.init.expiresAt)
  requireControlTiming(now, expiresAt, secret.init.expiresAt)
  if (expiresAt <= issuedAt) throw new ProtocolViolation('ttl-exceeded')

  const hostEphemeralKeyPair = await generateAgreementKeyPair()
  await assertAgreementPrivateMatchesPublic(
    secret.hostAgreementPrivateKey,
    secret.authorization.hostAgreementPublicKey,
    hostEphemeralKeyPair,
  )
  const sessionInitHash = encodeBase64Url(await sha256(encodeSessionInitHashInput(secret.init)))
  const clientToHostKeyId = randomOpaqueIdentifier('key')
  let hostToClientKeyId = randomOpaqueIdentifier('key')
  while (hostToClientKeyId === clientToHostKeyId) {
    hostToClientKeyId = randomOpaqueIdentifier('key')
  }
  const unsignedAccept = {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'session.accept' as const,
    relayOrigin: secret.init.relayOrigin,
    hostId: secret.init.hostId,
    hostDeviceId: secret.init.hostDeviceId,
    clientDeviceId: secret.init.clientDeviceId,
    authorizationId: secret.init.authorizationId,
    authorizationEpoch: secret.init.authorizationEpoch,
    handshakeId: secret.init.handshakeId,
    connectionGeneration: secret.connectionGeneration,
    clientToHostKeyId,
    hostToClientKeyId,
    sessionInitHash,
    hostNonce: encodeBase64Url(randomBytes32()),
    hostEphemeralAgreementKey: await exportPublicJwk(hostEphemeralKeyPair.publicKey),
    issuedAt,
    expiresAt,
  }
  const hostSignature = await signP256(
    secret.hostSigningPrivateKey,
    encodeSessionAcceptSignatureInput({
      sessionAccept: unsignedAccept,
      grantClaimsHash: secret.authorization.grantClaimsHash,
    }),
  )
  const acceptFrame = encodeSessionAccept({
    ...unsignedAccept,
    hostSignature: encodeBase64Url(hostSignature),
  })
  const accept = decodeSessionAccept(acceptFrame, {
    expectedRelayOrigin: secret.init.relayOrigin,
    now,
  })
  if (!await verifyP256(
    secret.authorization.hostSigningPublicKey,
    encodeSessionAcceptSignatureInput({
      sessionAccept: accept,
      grantClaimsHash: secret.authorization.grantClaimsHash,
    }),
    hostSignature,
  )) {
    return failE2ee('authentication-failed')
  }

  const clientEphemeralPublicKey = await importAgreementPublicKey(
    secret.init.clientEphemeralAgreementKey,
  )
  let ephemeralShared: Uint8Array | undefined
  let longTermShared: Uint8Array | undefined
  let directional: DirectionalSecrets
  try {
    ephemeralShared = await deriveEcdhSecret(
      hostEphemeralKeyPair.privateKey,
      clientEphemeralPublicKey,
    )
    longTermShared = await deriveEcdhSecret(
      secret.hostAgreementPrivateKey,
      secret.authorization.clientAgreementPublicKey,
    )
    directional = await deriveDirectionalSecrets(
      'host',
      secret.authorization,
      secret.init,
      accept,
      ephemeralShared,
      longTermShared,
    )
  } finally {
    ephemeralShared?.fill(0)
    longTermShared?.fill(0)
  }
  requireAuthorizationLineageActive(secret.authorization)
  const state = Object.freeze({
    kind: 'host-awaiting-session-confirm' as const,
    frame: acceptFrame,
    authority: directional.authority,
  }) as HostAwaitingSessionConfirm
  hostAwaitingSecrets.set(state, directional)
  return state
}

export async function validateSessionAcceptForClient(input: {
  state: ClientSessionInitPending
  frame: string | Uint8Array
  now: number
  installGeneration: InstallClientGeneration
}): Promise<ClientValidatedSessionAccept> {
  sweepExpiredDirectional(input.now)
  const initState = input.state
  const frame = typeof input.frame === 'string' ? input.frame : new Uint8Array(input.frame)
  const now = input.now
  const installGeneration = input.installGeneration
  const pending = requireOpaqueState(clientInitSecrets, initState)
  clientInitSecrets.delete(initState)
  requireAuthorizationLineageActive(pending.authorization)
  const accept = decodeSessionAccept(frame, {
    expectedRelayOrigin: pending.authorization.claims.relayOrigin,
    now,
  })
  assertAuthorityMatchesClaims(accept, pending.authorization.claims)
  if (
    accept.handshakeId !== pending.init.handshakeId
    || accept.issuedAt < pending.init.issuedAt
    || accept.expiresAt > pending.init.expiresAt
  ) {
    return staleAuthority()
  }
  const expectedInitHash = encodeBase64Url(await sha256(encodeSessionInitHashInput(pending.init)))
  if (accept.sessionInitHash !== expectedInitHash) return staleAuthority()
  const signature = requireDecodedBytes(accept.hostSignature, 64)
  if (!await verifyP256(
    pending.authorization.hostSigningPublicKey,
    encodeSessionAcceptSignatureInput({
      sessionAccept: accept,
      grantClaimsHash: pending.authorization.grantClaimsHash,
    }),
    signature,
  )) {
    return failE2ee('authentication-failed')
  }
  const hostEphemeralPublicKey = await importAgreementPublicKey(
    accept.hostEphemeralAgreementKey,
  )
  if (typeof installGeneration !== 'function') return staleAuthority()
  const previousGenerationHighWater = requireSafeHighWater(
    await installGeneration(Object.freeze({
      hostId: accept.hostId,
      hostDeviceId: accept.hostDeviceId,
      clientDeviceId: accept.clientDeviceId,
      authorizationId: accept.authorizationId,
      authorizationEpoch: accept.authorizationEpoch,
      handshakeId: accept.handshakeId,
      connectionGeneration: accept.connectionGeneration,
    })),
  )
  if (accept.connectionGeneration <= previousGenerationHighWater) {
    return staleAuthority()
  }
  requireAuthorizationLineageActive(pending.authorization)
  const state = Object.freeze({
    kind: 'client-validated-session-accept' as const,
  }) as ClientValidatedSessionAccept
  clientValidatedSecrets.set(state, {
    authorization: pending.authorization,
    clientAgreementPrivateKey: pending.clientAgreementPrivateKey,
    clientEphemeralKeyPair: pending.clientEphemeralKeyPair,
    init: pending.init,
    accept,
    hostEphemeralPublicKey,
  })
  return state
}

export async function deriveClientSessionAfterGenerationCommit(input: {
  state: ClientValidatedSessionAccept
}): Promise<ClientAwaitingSessionReady> {
  const validatedState = input.state
  const secret = requireOpaqueState(clientValidatedSecrets, validatedState)
  clientValidatedSecrets.delete(validatedState)
  requireAuthorizationLineageActive(secret.authorization)
  await assertAgreementPrivateMatchesPublic(
    secret.clientAgreementPrivateKey,
    secret.authorization.clientAgreementPublicKey,
    secret.clientEphemeralKeyPair,
  )
  let ephemeralShared: Uint8Array | undefined
  let longTermShared: Uint8Array | undefined
  let directional: DirectionalSecrets
  try {
    ephemeralShared = await deriveEcdhSecret(
      secret.clientEphemeralKeyPair.privateKey,
      secret.hostEphemeralPublicKey,
    )
    longTermShared = await deriveEcdhSecret(
      secret.clientAgreementPrivateKey,
      secret.authorization.hostAgreementPublicKey,
    )
    directional = await deriveDirectionalSecrets(
      'client',
      secret.authorization,
      secret.init,
      secret.accept,
      ephemeralShared,
      longTermShared,
    )
  } finally {
    ephemeralShared?.fill(0)
    longTermShared?.fill(0)
  }
  requireAuthorizationLineageActive(secret.authorization)
  const state = Object.freeze({
    kind: 'client-awaiting-session-ready' as const,
    authority: directional.authority,
  }) as ClientAwaitingSessionReady
  clientAwaitingSecrets.set(state, directional)
  return state
}

function controlHeader(
  secret: DirectionalSecrets,
  direction: 'outbound',
  now: number,
  expiresAt: number,
  ack: 0 | 1,
): EnvelopeHeader {
  void direction
  return {
    protocolVersion: PROTOCOL_VERSION,
    connectionGeneration: secret.authority.connectionGeneration,
    fromDeviceId: secret.outboundExpectation.fromDeviceId,
    toDeviceId: secret.outboundExpectation.toDeviceId,
    hostId: secret.authority.hostId,
    keyId: secret.outboundExpectation.keyId,
    requestId: secret.authority.handshakeId,
    seq: 1,
    ack,
    sentAt: now,
    expiresAt,
    messageType: 'control',
  }
}

export async function createClientSessionConfirm(input: {
  state: ClientAwaitingSessionReady
  now: number
  expiresAt: number
}): Promise<SealedApplicationEnvelope> {
  sweepExpiredDirectional(input.now)
  const state = input.state
  const secret = requireOpaqueState(clientAwaitingSecrets, state)
  requireActiveDirectional(secret)
  if (secret.confirm !== undefined) return secret.confirm
  if (secret.confirmPromise !== undefined) return secret.confirmPromise
  const now = input.now
  const expiresAt = input.expiresAt
  requireControlTiming(now, expiresAt, secret.handshakeExpiresAt)
  const promise = sealApplicationEnvelope(
    secret.outboundKey,
    secret.outboundNoncePrefix,
    secret.outboundExpectation,
    controlHeader(secret, 'outbound', now, expiresAt, 0),
    {
      kind: 'control',
      operation: 'session.confirm',
      sessionTranscriptHash: secret.authority.sessionTranscriptHash,
      authorizationId: secret.authority.authorizationId,
      authorizationEpoch: secret.authority.authorizationEpoch,
      connectionGeneration: secret.authority.connectionGeneration,
      senderRole: 'client',
    },
    now,
  ).then(confirm => {
    requireActiveDirectional(secret)
    secret.confirm = confirm
    return confirm
  }).catch(error => {
    clientAwaitingSecrets.delete(state)
    invalidateDirectionalSecret(secret)
    throw error
  })
  secret.confirmPromise = promise
  return promise
}

export async function acceptClientSessionConfirm(input: {
  state: HostAwaitingSessionConfirm
  frame: string | Uint8Array
  now: number
}): Promise<HostConfirmedSession> {
  sweepExpiredDirectional(input.now)
  const pendingState = input.state
  const secret = requireOpaqueState(hostAwaitingSecrets, pendingState)
  hostAwaitingSecrets.delete(pendingState)
  requireActiveDirectional(secret)
  try {
    await openApplicationEnvelope(
      secret.inboundKey,
      secret.inboundNoncePrefix,
      secret.inboundExpectation,
      input.frame,
      input.now,
    )
  } catch (error) {
    invalidateDirectionalSecret(secret)
    throw error
  }
  const state = Object.freeze({
    kind: 'host-confirmed-session' as const,
    authority: secret.authority,
  }) as HostConfirmedSession
  hostConfirmedSecrets.set(state, secret)
  return state
}

function makeEstablished(
  role: 'client' | 'host',
  secret: DirectionalSecrets,
): EstablishedSessionChannel {
  requireActiveDirectional(secret)
  const registryKey = establishedRegistryKey(role, secret.authority)
  const generationFloor = highestEstablishedGeneration.get(registryKey) ?? 0
  if (secret.authority.connectionGeneration <= generationFloor) {
    invalidateDirectionalSecret(secret)
    return staleAuthority()
  }
  const previous = establishedByRoleAndAuthorization.get(registryKey)
  if (previous !== undefined && previous !== secret) {
    if (
      secret.authority.connectionGeneration
      <= previous.authority.connectionGeneration
    ) {
      invalidateDirectionalSecret(secret)
      return staleAuthority()
    }
    invalidateDirectionalSecret(previous)
  }
  highestEstablishedGeneration.set(
    registryKey,
    secret.authority.connectionGeneration,
  )
  secret.phase = 'established'
  const state = Object.freeze({
    kind: 'established-session-channel' as const,
    role,
    authority: secret.authority,
  }) as EstablishedSessionChannel
  establishedSecrets.set(state, secret)
  establishedByRoleAndAuthorization.set(registryKey, secret)
  return state
}

export async function createHostSessionReady(input: {
  state: HostConfirmedSession
  now: number
  expiresAt: number
}): Promise<HostReadyResult> {
  sweepExpiredDirectional(input.now)
  const state = input.state
  const secret = requireOpaqueState(hostConfirmedSecrets, state)
  requireActiveDirectional(secret)
  if (secret.ready !== undefined) return secret.ready
  if (secret.readyPromise !== undefined) return secret.readyPromise
  const now = input.now
  const expiresAt = input.expiresAt
  requireControlTiming(now, expiresAt, secret.handshakeExpiresAt)
  const promise = sealApplicationEnvelope(
    secret.outboundKey,
    secret.outboundNoncePrefix,
    secret.outboundExpectation,
    controlHeader(secret, 'outbound', now, expiresAt, 1),
    {
      kind: 'control',
      operation: 'session.ready',
      sessionTranscriptHash: secret.authority.sessionTranscriptHash,
      authorizationId: secret.authority.authorizationId,
      authorizationEpoch: secret.authority.authorizationEpoch,
      connectionGeneration: secret.authority.connectionGeneration,
      senderRole: 'host',
    },
    now,
  ).then(ready => {
    requireActiveDirectional(secret)
    const result = Object.freeze({
      ready,
      channel: makeEstablished('host', secret),
    })
    secret.ready = result
    return result
  }).catch(error => {
    hostConfirmedSecrets.delete(state)
    invalidateDirectionalSecret(secret)
    throw error
  })
  secret.readyPromise = promise
  return promise
}

export async function acceptHostSessionReady(input: {
  state: ClientAwaitingSessionReady
  frame: string | Uint8Array
  now: number
}): Promise<EstablishedSessionChannel> {
  sweepExpiredDirectional(input.now)
  const state = input.state
  const secret = requireOpaqueState(clientAwaitingSecrets, state)
  clientAwaitingSecrets.delete(state)
  requireActiveDirectional(secret)
  if (secret.confirm === undefined) {
    invalidateDirectionalSecret(secret)
    return staleAuthority()
  }
  try {
    await openApplicationEnvelope(
      secret.inboundKey,
      secret.inboundNoncePrefix,
      secret.inboundExpectation,
      input.frame,
      input.now,
    )
  } catch (error) {
    invalidateDirectionalSecret(secret)
    throw error
  }
  return makeEstablished('client', secret)
}

export function getEstablishedSessionChannelInfo(
  state: EstablishedSessionChannel,
): EstablishedSessionChannelInfo {
  const secret = requireOpaqueState(establishedSecrets, state)
  requireActiveDirectional(secret)
  return Object.freeze({
    role: state.role,
    authority: secret.authority,
    outboundKeyId: secret.outboundExpectation.keyId,
    inboundKeyId: secret.inboundExpectation.keyId,
    sequenceState: Object.freeze({
      nextOutboundSequence: secret.nextOutboundSequence,
      maxSentSequence: secret.maxSentSequence,
      lastAcceptedInboundSequence: secret.lastAcceptedInboundSequence,
      lastPeerAck: secret.lastPeerAck,
    }),
  })
}

/**
 * Seal one application frame with a sequence already reserved durably by the
 * caller. Directional key handles and nonce prefixes never leave this module.
 */
export async function sealEstablishedApplication(input: {
  state: EstablishedSessionChannel
  header: Omit<EnvelopeHeader, 'seq' | 'ack'>
  message: unknown
  now: number
  assertAuthorizationActive: AssertSessionAuthorizationActive
  persistence: OutboundFramePersistenceAdapter
}): Promise<SealedApplicationEnvelope> {
  sweepExpiredDirectional(input.now)
  const state = input.state
  const secret = requireOpaqueState(establishedSecrets, state)
  requireActiveDirectional(secret)
  if (secret.outboundBusy) throw new ProtocolViolation('backpressure')
  if (
    secret.outboundFrames.size >= MAX_UNACKNOWLEDGED_OUTBOUND_FRAMES
    || secret.outboundFrameBytes + MAX_FRAME_BYTES > MAX_UNACKNOWLEDGED_OUTBOUND_BYTES
  ) {
    throw new ProtocolViolation('backpressure')
  }

  const header = Object.freeze({ ...input.header })
  const now = input.now
  const message = decodeApplicationMessage(
    encodeApplicationMessage(input.message),
    header.messageType,
  )
  const persistence = input.persistence
  const assertAuthorizationActive = input.assertAuthorizationActive
  const reserveSequence = persistence?.reserveSequence
  const commitFrame = persistence?.commitFrame
  if (typeof reserveSequence !== 'function' || typeof commitFrame !== 'function') {
    invalidateDirectionalSecret(secret)
    return staleAuthority()
  }

  secret.outboundBusy = true
  try {
    await checkAuthorizationActive(secret, assertAuthorizationActive)
    const expectedSequence = secret.nextOutboundSequence
    const direction = secret.role === 'client' ? 'client-to-host' : 'host-to-client'
    const sequence = await reserveSequence.call(persistence, Object.freeze({
      authority: secret.authority,
      keyId: secret.outboundExpectation.keyId,
      direction,
      expectedSequence,
      header,
    }))
    requireActiveDirectional(secret)
    if (!Number.isSafeInteger(sequence) || sequence !== expectedSequence) {
      throw new ProtocolViolation(
        Number.isSafeInteger(sequence) && sequence < expectedSequence ? 'replay' : 'sequence-gap',
      )
    }
    secret.nextOutboundSequence = expectedSequence + 1
    await checkAuthorizationActive(secret, assertAuthorizationActive)
    const sealed = await sealApplicationEnvelope(
      secret.outboundKey,
      secret.outboundNoncePrefix,
      secret.outboundExpectation,
      {
        ...header,
        seq: sequence,
        ack: secret.lastAcceptedInboundSequence,
      },
      message,
      now,
    )
    await commitFrame.call(persistence, Object.freeze({
      authority: secret.authority,
      keyId: secret.outboundExpectation.keyId,
      sequence,
      wireText: sealed.wireText,
    }))
    await checkAuthorizationActive(secret, assertAuthorizationActive)
    secret.maxSentSequence = sequence
    secret.outboundFrames.set(sequence, sealed)
    secret.outboundFrameBytes += textEncoder.encode(sealed.wireText).byteLength
    return sealed
  } catch (error) {
    invalidateDirectionalSecret(secret)
    throw error
  } finally {
    secret.outboundBusy = false
  }
}

/**
 * Authenticate and decode without advancing seq/ack or application state.
 * The caller commits those states only after idempotency reservation succeeds.
 */
export async function openEstablishedApplication(input: {
  state: EstablishedSessionChannel
  frame: string | Uint8Array
  now: number
  assertAuthorizationActive: AssertSessionAuthorizationActive
  commitInbound: CommitInboundFrame
}): Promise<OpenedApplicationEnvelope> {
  sweepExpiredDirectional(input.now)
  const state = input.state
  const secret = requireOpaqueState(establishedSecrets, state)
  requireActiveDirectional(secret)
  if (secret.inboundBusy) throw new ProtocolViolation('backpressure')
  const frame = typeof input.frame === 'string'
    ? input.frame
    : new Uint8Array(input.frame)
  const now = input.now
  const commitInbound = input.commitInbound
  const assertAuthorizationActive = input.assertAuthorizationActive
  if (typeof commitInbound !== 'function') {
    invalidateDirectionalSecret(secret)
    return staleAuthority()
  }
  secret.inboundBusy = true
  try {
    await checkAuthorizationActive(secret, assertAuthorizationActive)
    const opened = await openApplicationEnvelope(
      secret.inboundKey,
      secret.inboundNoncePrefix,
      secret.inboundExpectation,
      frame,
      now,
    )
    if (opened.envelope.seq <= secret.lastAcceptedInboundSequence) {
      throw new ProtocolViolation('replay')
    }
    if (opened.envelope.seq !== secret.lastAcceptedInboundSequence + 1) {
      throw new ProtocolViolation('sequence-gap')
    }
    if (opened.envelope.ack < secret.lastPeerAck) {
      throw new ProtocolViolation('ack-regression')
    }
    if (opened.envelope.ack > secret.maxSentSequence) {
      throw new ProtocolViolation('ack-ahead')
    }
    await checkAuthorizationActive(secret, assertAuthorizationActive)
    await commitInbound(Object.freeze({
      authority: secret.authority,
      keyId: secret.inboundExpectation.keyId,
      sequence: opened.envelope.seq,
      ack: opened.envelope.ack,
      requestId: opened.envelope.requestId,
      taskId: opened.envelope.taskId,
      message: opened.message,
    }))
    await checkAuthorizationActive(secret, assertAuthorizationActive)
    secret.lastAcceptedInboundSequence = opened.envelope.seq
    secret.lastPeerAck = opened.envelope.ack
    for (const sequence of secret.outboundFrames.keys()) {
      if (sequence <= opened.envelope.ack) {
        const acknowledged = secret.outboundFrames.get(sequence)
        if (acknowledged !== undefined) {
          secret.outboundFrameBytes -= textEncoder.encode(acknowledged.wireText).byteLength
        }
        secret.outboundFrames.delete(sequence)
      }
    }
    if (secret.outboundFrameBytes < 0) secret.outboundFrameBytes = 0
    return opened
  } catch (error) {
    invalidateDirectionalSecret(secret)
    throw error
  } finally {
    secret.inboundBusy = false
  }
}

/** Return only the exact canonical frame already persisted for retransmission. */
export function getCachedOutboundFrame(
  state: EstablishedSessionChannel,
  sequence: number,
): SealedApplicationEnvelope {
  const secret = requireOpaqueState(establishedSecrets, state)
  requireActiveDirectional(secret)
  if (!Number.isSafeInteger(sequence) || sequence < 2) return staleAuthority()
  const frame = secret.outboundFrames.get(sequence)
  if (frame === undefined) return staleAuthority()
  return frame
}

/** Close one opaque session capability and wipe its nonce-prefix material. */
export function invalidateEstablishedSession(state: EstablishedSessionChannel): void {
  const secret = requireOpaqueState(establishedSecrets, state)
  invalidateDirectionalSecret(secret)
  establishedSecrets.delete(state)
}

/**
 * Fail closed on revoke/epoch transition. This also closes pending handshakes
 * whose directional keys have already been derived.
 */
export function invalidateAuthorizationSessions(input: {
  authorizationId: string
  throughEpoch: number
}): number {
  if (
    typeof input?.authorizationId !== 'string'
    || !Number.isSafeInteger(input.throughEpoch)
    || input.throughEpoch < 1
  ) {
    return staleAuthority()
  }
  let invalidated = 0
  for (const lineage of authorizationLineages.values()) {
    if (
      lineage.authorizationId === input.authorizationId
      && lineage.authorizationEpoch <= input.throughEpoch
      && lineage.active
    ) {
      lineage.active = false
      invalidated += 1
    }
  }
  for (const secret of [...activeDirectionalSecrets]) {
    if (
      secret.authority.authorizationId === input.authorizationId
      && secret.authority.authorizationEpoch <= input.throughEpoch
    ) {
      invalidateDirectionalSecret(secret)
      invalidated += 1
    }
  }
  return invalidated
}

export type DisposableSessionState =
  | ClientSessionInitPending
  | HostValidatedSessionInit
  | HostAwaitingSessionConfirm
  | ClientValidatedSessionAccept
  | ClientAwaitingSessionReady
  | HostConfirmedSession
  | EstablishedSessionChannel

/** Idempotently discard a pending or established local session capability. */
export function disposeSessionState(state: DisposableSessionState): void {
  if (typeof state !== 'object' || state === null) return
  const directional =
    hostAwaitingSecrets.get(state as HostAwaitingSessionConfirm)
    ?? clientAwaitingSecrets.get(state as ClientAwaitingSessionReady)
    ?? hostConfirmedSecrets.get(state as HostConfirmedSession)
    ?? establishedSecrets.get(state as EstablishedSessionChannel)
  if (directional !== undefined) invalidateDirectionalSecret(directional)
  clientInitSecrets.delete(state as ClientSessionInitPending)
  hostValidatedSecrets.delete(state as HostValidatedSessionInit)
  hostAwaitingSecrets.delete(state as HostAwaitingSessionConfirm)
  clientValidatedSecrets.delete(state as ClientValidatedSessionAccept)
  clientAwaitingSecrets.delete(state as ClientAwaitingSessionReady)
  hostConfirmedSecrets.delete(state as HostConfirmedSession)
  establishedSecrets.delete(state as EstablishedSessionChannel)
}
