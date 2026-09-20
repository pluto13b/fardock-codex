import {
  MAX_PAIRING_INVITATION_TTL_MS,
  MAX_PAIRING_TTL_MS,
  PROTOCOL_VERSION,
  ProtocolViolation,
  decodeBase64Url,
  decodePairJoinDetails,
  decodePairJoinFrame,
  decodePairResultFrame,
  decodePairResultPayload,
  decodePairingInvitationFragment,
  encodeBase64Url,
  encodeGrantClaims,
  encodeGrantSignatureInput,
  encodeInvitationSignatureInput,
  encodePairJoinAad,
  encodePairJoinClaims,
  encodePairJoinDetails,
  encodePairJoinFrame,
  encodePairResultAad,
  encodePairResultFrame,
  encodePairResultPayload,
  encodePairSasInput,
  encodePairingInvitationFragment,
  encodePairingTranscript,
  pairJoinHeader,
  pairResultHeader,
  validatePairingInvitationTime,
  type GrantClaims,
  type P256PublicJwk,
  type PairJoinDetails,
  type PairJoinFrame,
  type PairResultFrame,
  type PairResultPayload,
  type PairingInvitation,
  type UnsignedPairingInvitation,
} from '@codex-plus/protocol'

import { fingerprintP256PublicJwk, fingerprintP256PublicKey } from './fingerprint.ts'
import {
  assertAgreementPublicKey,
  assertSigningPrivateKey,
  assertSigningPublicKey,
  exportPublicJwk,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  importAgreementPublicKey,
  importSigningPublicKey,
} from './keys.ts'
import {
  decryptAes256Gcm,
  deriveAgreementProofKey,
  deriveEcdhSecret,
  derivePairingMaterial,
  encryptAes256Gcm,
  hmacSha256,
  importAes256GcmKey,
  sha256,
  signP256,
  verifyHmacSha256,
  verifyP256,
} from './primitives.ts'
import { failE2ee, randomBytes16, randomBytes32 } from './runtime.ts'
import {
  HostPairingSessionGuard,
  type LocalHostPairingSessionStatus,
  type PendingPairingConfirmation,
} from './pairing-state.ts'

const textEncoder = new TextEncoder()
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export interface CreateHostPairingInvitationInput {
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly hostAgreementPublicKey: CryptoKey
  readonly hostSigningPrivateKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
  readonly now?: number
  readonly lifetimeMs?: number
  /** Defaults to Date.now. Injection exists only for deterministic platform tests. */
  readonly clock?: () => number
}

export interface HostPairingInvitationHandle {
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly pairSessionId: string
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface CreatedHostPairingInvitation {
  readonly handle: HostPairingInvitationHandle
  readonly invitationFragment: string
}

export interface CreateClientPairJoinInput {
  readonly invitationFragment: string
  readonly expectedRelayOrigin: string
  readonly deviceDisplayName: string
  readonly now?: number
}

export interface ClientPairingHandle {
  readonly relayOrigin: string
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly pairSessionId: string
  readonly joinId: string
  readonly expiresAt: number
}

export interface CreatedClientPairJoin {
  readonly handle: ClientPairingHandle
  readonly frame: Readonly<PairJoinFrame>
  readonly wireText: string
  readonly sas: string
  readonly clientSigningFingerprint: string
}

export interface ValidatedHostPairingClaim {
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly pairSessionId: string
  readonly joinId: string
  readonly deviceDisplayName: string
  readonly clientSigningFingerprint: string
  readonly sas: string
  readonly expiresAt: number
}

export interface OpenHostPairJoinInput {
  readonly invitation: HostPairingInvitationHandle
  readonly attemptId: string
  readonly wireFrame: string | Uint8Array
  readonly now?: number
}

export interface HostPairingConfirmation {
  readonly attemptId: string
  readonly claim: ValidatedHostPairingClaim
}

export type OpenHostPairJoinResult =
  | {
    readonly outcome: 'pending-confirmation'
    readonly confirmation: HostPairingConfirmation
  }
  | {
    readonly outcome: 'invalid'
    readonly invalidAttempts: number
    readonly attemptsRemaining: number
  }
  | { readonly outcome: 'unavailable' }
  | {
    readonly outcome: 'consumed'
    readonly terminalOutcome: 'expired' | 'attempt-limit'
  }

export interface ApproveHostPairingInput {
  readonly confirmation: HostPairingConfirmation
  readonly persistenceAdapter: HostPairingApprovalPersistenceAdapter
  readonly now?: number
  readonly remotePermissionModes?: readonly ['ask', 'read-only'] | readonly ['ask', 'read-only', 'full-access']
}

export interface HostAuthorizationMaterial {
  readonly grantClaims: Readonly<GrantClaims>
  readonly hostGrantSignature: string
  readonly grantClaimsHash: string
  readonly clientAgreementPublicKey: CryptoKey
  readonly clientSigningPublicKey: CryptoKey
}

export interface HostPairingApprovalPersistenceInput {
  readonly authorization: HostAuthorizationMaterial
}

export interface HostPairingApprovalPersistenceResult {
  readonly relayRevision: number
  readonly nextGeneration: number
}

/**
 * Trusted platform boundary. The method must atomically persist the local
 * active authorization together with nextGeneration, then complete the
 * idempotent Relay authorization upsert before it resolves.
 */
export interface HostPairingApprovalPersistenceAdapter {
  readonly commitAuthorizationAndUpsertRelay: (
    input: HostPairingApprovalPersistenceInput,
  ) => Promise<HostPairingApprovalPersistenceResult>
}

export interface ApprovedHostPairing {
  readonly outcome: 'approved'
  readonly frame: Readonly<PairResultFrame>
  readonly wireText: string
  readonly authorization: HostAuthorizationMaterial
  readonly persistence: Readonly<HostPairingApprovalPersistenceResult>
}

export interface PreparedHostPairingDenial {
  readonly outcome: 'denied'
  readonly frame: Readonly<PairResultFrame>
  readonly wireText: string
}

export interface ClientAuthorizationMaterial {
  readonly grantClaims: Readonly<GrantClaims>
  readonly hostGrantSignature: string
  readonly grantClaimsHash: string
  readonly clientAgreementPrivateKey: CryptoKey
  readonly clientAgreementPublicKey: CryptoKey
  readonly clientSigningPrivateKey: CryptoKey
  readonly clientSigningPublicKey: CryptoKey
  readonly hostAgreementPublicKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
}

export type OpenedClientPairResult =
  | {
    readonly outcome: 'approved'
    readonly decidedAt: number
    readonly authorization: ClientAuthorizationMaterial
  }
  | {
    readonly outcome: 'denied' | 'expired'
    readonly decidedAt: number
  }

interface HostInvitationState {
  readonly handle: HostPairingInvitationHandle
  readonly invitation: Readonly<PairingInvitation>
  readonly hostEphemeralPrivateKey: CryptoKey
  readonly hostAgreementPublicKey: CryptoKey
  readonly hostAgreementJwk: Readonly<P256PublicJwk>
  readonly hostSigningPrivateKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
  readonly guard: HostPairingSessionGuard<string>
  activeConfirmation?: HostPairingConfirmation
  activeClaimState?: HostClaimState
}

interface ClientPairingState {
  readonly handle: ClientPairingHandle
  readonly expectedRelayOrigin: string
  readonly invitation: Readonly<PairingInvitation>
  readonly clientAgreementKeyPair: CryptoKeyPair
  readonly clientSigningKeyPair: CryptoKeyPair
  readonly clientAgreementJwk: Readonly<P256PublicJwk>
  readonly clientSigningJwk: Readonly<P256PublicJwk>
  readonly clientChallenge: string
  readonly pairingTranscriptHash: string
  readonly joinClaimsHash: string
  readonly resultDecryptKey: CryptoKey
  readonly resultNoncePrefix: Uint8Array
  consumed: boolean
}

interface HostClaimState {
  readonly invitationState: HostInvitationState
  readonly details: Readonly<PairJoinDetails>
  readonly clientAgreementPublicKey: CryptoKey
  readonly clientSigningPublicKey: CryptoKey
  readonly clientSigningFingerprint: string
  readonly pairingTranscriptHash: string
  readonly joinClaimsHash: string
  readonly resultEncryptKey: CryptoKey
  readonly resultNoncePrefix: Uint8Array
  readonly frame: Readonly<PairJoinFrame>
}

interface HostConfirmationState {
  readonly claimState: HostClaimState
  readonly guardConfirmation: PendingPairingConfirmation<string>
  readonly stateId: string
  decisionStarted: boolean
}

interface VerifiedInvitation {
  readonly hostEphemeralAgreementPublicKey: CryptoKey
  readonly hostSigningPublicKey: CryptoKey
}

const hostInvitationStates = new WeakMap<HostPairingInvitationHandle, HostInvitationState>()
const clientPairingStates = new WeakMap<ClientPairingHandle, ClientPairingState>()
const hostConfirmationStates = new WeakMap<HostPairingConfirmation, HostConfirmationState>()

function freezePlainData<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const item of value) freezePlainData(item)
  } else {
    for (const item of Object.values(value)) freezePlainData(item)
  }
  return Object.freeze(value)
}

function authenticationFailed(): never {
  return failE2ee('authentication-failed')
}

function pairUnavailable(): never {
  throw new ProtocolViolation('pair-session-unavailable')
}

function requireFiniteTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolViolation('schema-invalid')
  return value
}

function randomOpaqueId(prefix: 'authorization' | 'client' | 'join' | 'pair' | 'state'): string {
  const bytes = randomBytes16()
  try {
    return `${prefix}.${encodeBase64Url(bytes)}`
  } finally {
    bytes.fill(0)
  }
}

function wipeBytes(...values: Array<Uint8Array | undefined>): void {
  for (const value of values) {
    if (value !== undefined) value.fill(0)
  }
}

function snapshotWireFrame(value: string | Uint8Array): string | Uint8Array<ArrayBuffer> {
  if (typeof value === 'string') return value
  try {
    if (
      !ArrayBuffer.isView(value)
      || Object.prototype.toString.call(value) !== '[object Uint8Array]'
      || Object.prototype.toString.call(value.buffer) === '[object SharedArrayBuffer]'
    ) {
      throw new ProtocolViolation('schema-invalid')
    }
    const source = new Uint8Array(
      value.buffer as ArrayBuffer,
      value.byteOffset,
      value.byteLength,
    )
    const owned = new Uint8Array(source.byteLength)
    owned.set(source)
    return owned
  } catch (error) {
    if (error instanceof ProtocolViolation) throw error
    throw new ProtocolViolation('schema-invalid')
  }
}

function wipeHostClaimState(state: HostClaimState | undefined): void {
  if (state !== undefined) state.resultNoncePrefix.fill(0)
}

function consumeHostInvitationState(state: HostInvitationState): void {
  const confirmation = state.activeConfirmation
  if (confirmation !== undefined) hostConfirmationStates.delete(confirmation)
  wipeHostClaimState(state.activeClaimState)
  state.activeConfirmation = undefined
  state.activeClaimState = undefined
  hostInvitationStates.delete(state.handle)
}

function consumeClientPairingState(
  handle: ClientPairingHandle,
  state: ClientPairingState,
): boolean {
  if (clientPairingStates.get(handle) !== state || state.consumed) return false
  state.consumed = true
  state.resultNoncePrefix.fill(0)
  clientPairingStates.delete(handle)
  return true
}

function requireDecodedBytes(value: string, length: number): Uint8Array {
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== length) return authenticationFailed()
  return decoded
}

function publicJwksEqual(left: P256PublicJwk, right: P256PublicJwk): boolean {
  return left.kty === right.kty
    && left.crv === right.crv
    && left.x === right.x
    && left.y === right.y
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function assertAuthenticatedString(actual: string, expected: string): void {
  const actualBytes = textEncoder.encode(actual)
  const expectedBytes = textEncoder.encode(expected)
  try {
    if (!bytesEqual(actualBytes, expectedBytes)) authenticationFailed()
  } finally {
    wipeBytes(actualBytes, expectedBytes)
  }
}

function assertJoinRoute(frame: PairJoinFrame, invitation: PairingInvitation): void {
  if (
    frame.hostId !== invitation.hostId
    || frame.hostDeviceId !== invitation.hostDeviceId
    || frame.pairSessionId !== invitation.pairSessionId
  ) {
    throw new ProtocolViolation('route-mismatch')
  }
}

function assertResultRoute(
  frame: PairResultFrame,
  invitation: PairingInvitation,
  expectedJoinId: string,
): void {
  if (
    frame.hostId !== invitation.hostId
    || frame.hostDeviceId !== invitation.hostDeviceId
    || frame.pairSessionId !== invitation.pairSessionId
    || frame.joinId !== expectedJoinId
  ) {
    throw new ProtocolViolation('route-mismatch')
  }
}

async function verifyInvitation(
  invitation: PairingInvitation,
  expectedRelayOrigin: string,
  now: number,
): Promise<VerifiedInvitation> {
  if (invitation.relayOrigin !== expectedRelayOrigin) {
    throw new ProtocolViolation('route-mismatch')
  }
  validatePairingInvitationTime(invitation, now)

  // Import both points before ECDH. WebCrypto, rather than coordinate length checks,
  // is the authority for whether the points are on P-256.
  const hostEphemeralAgreementPublicKey = await importAgreementPublicKey(
    invitation.hostEphemeralAgreementKey,
  )
  const hostSigningPublicKey = await importSigningPublicKey(invitation.hostSigningKey)
  if (publicJwksEqual(invitation.hostEphemeralAgreementKey, invitation.hostSigningKey)) {
    return authenticationFailed()
  }

  const fingerprint = await fingerprintP256PublicJwk(invitation.hostSigningKey)
  assertAuthenticatedString(fingerprint, invitation.hostKeyFingerprint)
  const signature = requireDecodedBytes(invitation.invitationSignature, 64)
  let signatureInput: Uint8Array | undefined
  try {
    signatureInput = encodeInvitationSignatureInput(invitation)
    const validSignature = await verifyP256(
      hostSigningPublicKey,
      signatureInput,
      signature,
    )
    if (!validSignature) return authenticationFailed()
    return { hostEphemeralAgreementPublicKey, hostSigningPublicKey }
  } finally {
    wipeBytes(signature, signatureInput)
  }
}

async function pairingSas(
  sasKey: Uint8Array,
  pairingTranscriptHash: string,
  joinClaimsHash: string,
): Promise<string> {
  const sasInput = encodePairSasInput({
    pairingTranscriptHash,
    joinClaimsHash,
  })
  let mac: Uint8Array | undefined
  try {
    mac = await hmacSha256(sasKey, sasInput)
    const first25Bits = ((mac[0] ?? 0) * 0x2_0000)
      + ((mac[1] ?? 0) * 0x200)
      + ((mac[2] ?? 0) * 0x2)
      + ((mac[3] ?? 0) >>> 7)
    let result = ''
    for (let shift = 20; shift >= 0; shift -= 5) {
      result += CROCKFORD_BASE32[(first25Bits >>> shift) & 0x1f]
    }
    return result
  } finally {
    wipeBytes(mac, sasInput)
  }
}

async function deriveClientProvisionalMaterial(
  sharedSecret: Uint8Array,
  rendezvousSecret: Uint8Array,
  transcriptHash: Uint8Array,
): Promise<{
  readonly joinEncryptKey: CryptoKey
  readonly joinNoncePrefix: Uint8Array
  readonly resultDecryptKey: CryptoKey
  readonly resultNoncePrefix: Uint8Array
  readonly sasKey: Uint8Array
}> {
  let joinRaw: Uint8Array | undefined
  let resultRaw: Uint8Array | undefined
  let joinNoncePrefix: Uint8Array | undefined
  let resultNoncePrefix: Uint8Array | undefined
  let sasKey: Uint8Array | undefined
  let completed = false
  try {
    joinRaw = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'client-to-host-key',
    )
    const joinEncryptKey = await importAes256GcmKey(joinRaw, 'encrypt')
    joinNoncePrefix = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'client-to-host-nonce-prefix',
    )
    resultRaw = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'host-to-client-key',
    )
    const resultDecryptKey = await importAes256GcmKey(resultRaw, 'decrypt')
    resultNoncePrefix = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'host-to-client-nonce-prefix',
    )
    sasKey = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'sas-key',
    )
    completed = true
    return { joinEncryptKey, joinNoncePrefix, resultDecryptKey, resultNoncePrefix, sasKey }
  } finally {
    wipeBytes(joinRaw, resultRaw)
    if (!completed) wipeBytes(joinNoncePrefix, resultNoncePrefix, sasKey)
  }
}

async function deriveHostProvisionalMaterial(
  sharedSecret: Uint8Array,
  rendezvousSecret: Uint8Array,
  transcriptHash: Uint8Array,
): Promise<{
  readonly joinDecryptKey: CryptoKey
  readonly joinNoncePrefix: Uint8Array
  readonly resultEncryptKey: CryptoKey
  readonly resultNoncePrefix: Uint8Array
  readonly sasKey: Uint8Array
}> {
  let joinRaw: Uint8Array | undefined
  let resultRaw: Uint8Array | undefined
  let joinNoncePrefix: Uint8Array | undefined
  let resultNoncePrefix: Uint8Array | undefined
  let sasKey: Uint8Array | undefined
  let completed = false
  try {
    joinRaw = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'client-to-host-key',
    )
    const joinDecryptKey = await importAes256GcmKey(joinRaw, 'decrypt')
    joinNoncePrefix = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'client-to-host-nonce-prefix',
    )
    resultRaw = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'host-to-client-key',
    )
    const resultEncryptKey = await importAes256GcmKey(resultRaw, 'encrypt')
    resultNoncePrefix = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'host-to-client-nonce-prefix',
    )
    sasKey = await derivePairingMaterial(
      sharedSecret,
      rendezvousSecret,
      transcriptHash,
      'sas-key',
    )
    completed = true
    return { joinDecryptKey, joinNoncePrefix, resultEncryptKey, resultNoncePrefix, sasKey }
  } finally {
    wipeBytes(joinRaw, resultRaw)
    if (!completed) wipeBytes(joinNoncePrefix, resultNoncePrefix, sasKey)
  }
}

export async function createHostPairingInvitation(
  input: CreateHostPairingInvitationInput,
): Promise<CreatedHostPairingInvitation> {
  // Snapshot every caller-controlled field before the first asynchronous step.
  const relayOrigin = input.relayOrigin
  const hostId = input.hostId
  const hostDeviceId = input.hostDeviceId
  const hostAgreementPublicKey = input.hostAgreementPublicKey
  const hostSigningPrivateKey = input.hostSigningPrivateKey
  const hostSigningPublicKey = input.hostSigningPublicKey
  const clock = input.clock ?? Date.now
  const nowInput = input.now
  const lifetimeInput = input.lifetimeMs
  assertAgreementPublicKey(hostAgreementPublicKey)
  assertSigningPrivateKey(hostSigningPrivateKey)
  assertSigningPublicKey(hostSigningPublicKey)

  const now = requireFiniteTimestamp(nowInput ?? clock())
  const lifetimeMs = requireFiniteTimestamp(lifetimeInput ?? MAX_PAIRING_INVITATION_TTL_MS)
  if (lifetimeMs < 1 || lifetimeMs > MAX_PAIRING_INVITATION_TTL_MS) {
    throw new ProtocolViolation('ttl-exceeded')
  }

  const [hostEphemeralAgreementKeyPair, hostAgreementJwk, hostSigningJwk] = await Promise.all([
    generateAgreementKeyPair(),
    exportPublicJwk(hostAgreementPublicKey),
    exportPublicJwk(hostSigningPublicKey),
  ])
  if (publicJwksEqual(hostAgreementJwk, hostSigningJwk)) return authenticationFailed()

  const hostEphemeralAgreementKey = await exportPublicJwk(hostEphemeralAgreementKeyPair.publicKey)
  const hostKeyFingerprint = await fingerprintP256PublicKey(hostSigningPublicKey)
  const rendezvousSecretBytes = randomBytes32()
  let rendezvousSecret: string
  try {
    rendezvousSecret = encodeBase64Url(rendezvousSecretBytes)
  } finally {
    rendezvousSecretBytes.fill(0)
  }
  const unsignedInvitation: UnsignedPairingInvitation = {
    protocolVersion: PROTOCOL_VERSION,
    relayOrigin,
    hostId,
    hostDeviceId,
    pairSessionId: randomOpaqueId('pair'),
    issuedAt: now,
    expiresAt: now + lifetimeMs,
    rendezvousSecret,
    hostEphemeralAgreementKey,
    hostSigningKey: hostSigningJwk,
    hostKeyFingerprint,
  }
  const invitationSignatureInput = encodeInvitationSignatureInput(unsignedInvitation)
  let invitationSignatureBytes: Uint8Array | undefined
  let invitationSignature: string
  try {
    invitationSignatureBytes = await signP256(
      hostSigningPrivateKey,
      invitationSignatureInput,
    )
    if (!await verifyP256(
      hostSigningPublicKey,
      invitationSignatureInput,
      invitationSignatureBytes,
    )) {
      return authenticationFailed()
    }
    invitationSignature = encodeBase64Url(invitationSignatureBytes)
  } finally {
    wipeBytes(invitationSignatureBytes, invitationSignatureInput)
  }
  const invitation = freezePlainData<PairingInvitation>({
    ...unsignedInvitation,
    invitationSignature,
  })
  validatePairingInvitationTime(invitation, now)
  const invitationFragment = encodePairingInvitationFragment(invitation)
  const handle = Object.freeze<HostPairingInvitationHandle>({
    relayOrigin: invitation.relayOrigin,
    hostId: invitation.hostId,
    hostDeviceId: invitation.hostDeviceId,
    pairSessionId: invitation.pairSessionId,
    issuedAt: invitation.issuedAt,
    expiresAt: invitation.expiresAt,
  })
  const guard = new HostPairingSessionGuard<string>({
    expiresAt: invitation.expiresAt,
    clock,
  })
  if (guard.localStatus().state === 'consumed') return pairUnavailable()
  hostInvitationStates.set(handle, {
    handle,
    invitation,
    hostEphemeralPrivateKey: hostEphemeralAgreementKeyPair.privateKey,
    hostAgreementPublicKey,
    hostAgreementJwk: freezePlainData(hostAgreementJwk),
    hostSigningPrivateKey,
    hostSigningPublicKey,
    guard,
  })
  return Object.freeze({ handle, invitationFragment })
}

export async function createClientPairJoin(
  input: CreateClientPairJoinInput,
): Promise<CreatedClientPairJoin> {
  // Snapshot caller-owned strings and time before verification yields.
  const invitationFragment = input.invitationFragment
  const expectedRelayOrigin = input.expectedRelayOrigin
  const deviceDisplayName = input.deviceDisplayName
  const now = requireFiniteTimestamp(input.now ?? Date.now())
  // Decoding enforces canonical bytes, time and the caller's configured origin
  // before this function creates client identity material or performs ECDH.
  const invitation = freezePlainData(decodePairingInvitationFragment(
    invitationFragment,
    expectedRelayOrigin,
    now,
  ))
  const verifiedInvitation = await verifyInvitation(invitation, expectedRelayOrigin, now)

  const [clientEphemeralKeyPair, clientAgreementKeyPair, clientSigningKeyPair] = await Promise.all([
    generateAgreementKeyPair(),
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const [clientEphemeralJwk, clientAgreementJwk, clientSigningJwk] = await Promise.all([
    exportPublicJwk(clientEphemeralKeyPair.publicKey),
    exportPublicJwk(clientAgreementKeyPair.publicKey),
    exportPublicJwk(clientSigningKeyPair.publicKey),
  ])
  if (publicJwksEqual(clientAgreementJwk, clientSigningJwk)) return authenticationFailed()

  const transcriptBytes = encodePairingTranscript(invitation, clientEphemeralJwk)
  let transcriptHashBytes: Uint8Array | undefined
  let rendezvousSecret: Uint8Array | undefined
  let pairingSharedSecret: Uint8Array | undefined
  let provisional: Awaited<ReturnType<typeof deriveClientProvisionalMaterial>> | undefined
  let clientChallengeBytes: Uint8Array | undefined
  let claimsBytes: Uint8Array | undefined
  let joinClaimsHashBytes: Uint8Array | undefined
  let clientJoinSignature: Uint8Array | undefined
  let agreementPopShared: Uint8Array | undefined
  let agreementProofKey: Uint8Array | undefined
  let clientAgreementProof: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  let aad: Uint8Array | undefined
  let ciphertext: Uint8Array | undefined
  try {
    transcriptHashBytes = await sha256(transcriptBytes)
    const pairingTranscriptHash = encodeBase64Url(transcriptHashBytes)
    rendezvousSecret = requireDecodedBytes(invitation.rendezvousSecret, 32)
    pairingSharedSecret = await deriveEcdhSecret(
      clientEphemeralKeyPair.privateKey,
      verifiedInvitation.hostEphemeralAgreementPublicKey,
    )
    provisional = await deriveClientProvisionalMaterial(
      pairingSharedSecret,
      rendezvousSecret,
      transcriptHashBytes,
    )

    clientChallengeBytes = randomBytes32()
    const claims = {
      pairingTranscriptHash,
      clientDeviceId: randomOpaqueId('client'),
      deviceDisplayName,
      clientChallenge: encodeBase64Url(clientChallengeBytes),
      clientAgreementKey: clientAgreementJwk,
      clientSigningKey: clientSigningJwk,
    }
    claimsBytes = encodePairJoinClaims(claims)
    joinClaimsHashBytes = await sha256(claimsBytes)
    const joinClaimsHash = encodeBase64Url(joinClaimsHashBytes)
    clientJoinSignature = await signP256(clientSigningKeyPair.privateKey, claimsBytes)

    agreementPopShared = await deriveEcdhSecret(
      clientAgreementKeyPair.privateKey,
      verifiedInvitation.hostEphemeralAgreementPublicKey,
    )
    agreementProofKey = await deriveAgreementProofKey(
      agreementPopShared,
      rendezvousSecret,
      transcriptHashBytes,
      joinClaimsHashBytes,
    )
    clientAgreementProof = await hmacSha256(agreementProofKey, joinClaimsHashBytes)

    const details: PairJoinDetails = {
      pairType: 'join-details',
      ...claims,
      clientJoinSignature: encodeBase64Url(clientJoinSignature),
      clientAgreementProof: encodeBase64Url(clientAgreementProof),
    }
    const joinId = randomOpaqueId('join')
    const expiresAt = Math.min(invitation.expiresAt, now + MAX_PAIRING_TTL_MS)
    if (expiresAt <= now) return pairUnavailable()
    const frameWithoutCiphertext = {
      protocolVersion: PROTOCOL_VERSION,
      relayType: 'pair.join' as const,
      hostId: invitation.hostId,
      hostDeviceId: invitation.hostDeviceId,
      pairSessionId: invitation.pairSessionId,
      joinId,
      clientEphemeralAgreementKey: clientEphemeralJwk,
      seq: 1 as const,
      sentAt: now,
      expiresAt,
    }
    plaintext = textEncoder.encode(encodePairJoinDetails(details))
    aad = encodePairJoinAad(frameWithoutCiphertext)
    ciphertext = await encryptAes256Gcm(
      provisional.joinEncryptKey,
      provisional.joinNoncePrefix,
      1n,
      aad,
      plaintext,
    )
    const frame = freezePlainData<PairJoinFrame>({
      ...frameWithoutCiphertext,
      ciphertext: encodeBase64Url(ciphertext),
    })
    const wireText = encodePairJoinFrame(frame)
    const sas = await pairingSas(provisional.sasKey, pairingTranscriptHash, joinClaimsHash)
    const clientSigningFingerprint = await fingerprintP256PublicJwk(clientSigningJwk)
    const handle = Object.freeze<ClientPairingHandle>({
      relayOrigin: invitation.relayOrigin,
      hostId: invitation.hostId,
      hostDeviceId: invitation.hostDeviceId,
      clientDeviceId: claims.clientDeviceId,
      pairSessionId: invitation.pairSessionId,
      joinId,
      expiresAt: invitation.expiresAt,
    })
    clientPairingStates.set(handle, {
      handle,
      expectedRelayOrigin,
      invitation,
      clientAgreementKeyPair,
      clientSigningKeyPair,
      clientAgreementJwk: freezePlainData(clientAgreementJwk),
      clientSigningJwk: freezePlainData(clientSigningJwk),
      clientChallenge: claims.clientChallenge,
      pairingTranscriptHash,
      joinClaimsHash,
      resultDecryptKey: provisional.resultDecryptKey,
      resultNoncePrefix: provisional.resultNoncePrefix.slice(),
      consumed: false,
    })
    return Object.freeze({ handle, frame, wireText, sas, clientSigningFingerprint })
  } finally {
    wipeBytes(
      transcriptBytes,
      transcriptHashBytes,
      rendezvousSecret,
      pairingSharedSecret,
      provisional?.joinNoncePrefix,
      provisional?.resultNoncePrefix,
      provisional?.sasKey,
      clientChallengeBytes,
      claimsBytes,
      joinClaimsHashBytes,
      clientJoinSignature,
      agreementPopShared,
      agreementProofKey,
      clientAgreementProof,
      plaintext,
      aad,
      ciphertext,
    )
  }
}

async function validateHostPairJoinCrypto(
  invitationState: HostInvitationState,
  wireFrame: string | Uint8Array,
  now: number,
): Promise<{
  readonly claim: ValidatedHostPairingClaim
  readonly state: HostClaimState
}> {
  const frame = freezePlainData(decodePairJoinFrame(wireFrame, {
    now,
    invitationExpiresAt: invitationState.invitation.expiresAt,
  }))
  assertJoinRoute(frame, invitationState.invitation)

  const clientEphemeralAgreementPublicKey = await importAgreementPublicKey(
    frame.clientEphemeralAgreementKey,
  )
  const transcriptBytes = encodePairingTranscript(
    invitationState.invitation,
    frame.clientEphemeralAgreementKey,
  )
  let transcriptHashBytes: Uint8Array | undefined
  let rendezvousSecret: Uint8Array | undefined
  let pairingSharedSecret: Uint8Array | undefined
  let provisional: Awaited<ReturnType<typeof deriveHostProvisionalMaterial>> | undefined
  let ciphertext: Uint8Array | undefined
  let aad: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  let claimsBytes: Uint8Array | undefined
  let joinClaimsHashBytes: Uint8Array | undefined
  let clientSignature: Uint8Array | undefined
  let agreementPopShared: Uint8Array | undefined
  let agreementProofKey: Uint8Array | undefined
  let agreementProof: Uint8Array | undefined
  try {
    transcriptHashBytes = await sha256(transcriptBytes)
    const pairingTranscriptHash = encodeBase64Url(transcriptHashBytes)
    rendezvousSecret = requireDecodedBytes(invitationState.invitation.rendezvousSecret, 32)
    pairingSharedSecret = await deriveEcdhSecret(
      invitationState.hostEphemeralPrivateKey,
      clientEphemeralAgreementPublicKey,
    )
    provisional = await deriveHostProvisionalMaterial(
      pairingSharedSecret,
      rendezvousSecret,
      transcriptHashBytes,
    )
    ciphertext = decodeBase64Url(frame.ciphertext)
    if (ciphertext === undefined) return authenticationFailed()
    aad = encodePairJoinAad(pairJoinHeader(frame))
    plaintext = await decryptAes256Gcm(
      provisional.joinDecryptKey,
      provisional.joinNoncePrefix,
      1n,
      aad,
      ciphertext,
    )
    const details = freezePlainData(decodePairJoinDetails(plaintext))
    assertAuthenticatedString(details.pairingTranscriptHash, pairingTranscriptHash)

    const [clientAgreementPublicKey, clientSigningPublicKey] = await Promise.all([
      importAgreementPublicKey(details.clientAgreementKey),
      importSigningPublicKey(details.clientSigningKey),
    ])
    claimsBytes = encodePairJoinClaims(details)
    joinClaimsHashBytes = await sha256(claimsBytes)
    const joinClaimsHash = encodeBase64Url(joinClaimsHashBytes)
    clientSignature = requireDecodedBytes(details.clientJoinSignature, 64)
    if (!await verifyP256(clientSigningPublicKey, claimsBytes, clientSignature)) {
      return authenticationFailed()
    }

    agreementPopShared = await deriveEcdhSecret(
      invitationState.hostEphemeralPrivateKey,
      clientAgreementPublicKey,
    )
    agreementProofKey = await deriveAgreementProofKey(
      agreementPopShared,
      rendezvousSecret,
      transcriptHashBytes,
      joinClaimsHashBytes,
    )
    agreementProof = requireDecodedBytes(details.clientAgreementProof, 32)
    if (!await verifyHmacSha256(agreementProofKey, joinClaimsHashBytes, agreementProof)) {
      return authenticationFailed()
    }

    const sas = await pairingSas(provisional.sasKey, pairingTranscriptHash, joinClaimsHash)
    const clientSigningFingerprint = await fingerprintP256PublicJwk(details.clientSigningKey)
    const claim = Object.freeze<ValidatedHostPairingClaim>({
      hostId: frame.hostId,
      hostDeviceId: frame.hostDeviceId,
      clientDeviceId: details.clientDeviceId,
      pairSessionId: frame.pairSessionId,
      joinId: frame.joinId,
      deviceDisplayName: details.deviceDisplayName,
      clientSigningFingerprint,
      sas,
      expiresAt: invitationState.invitation.expiresAt,
    })
    return {
      claim,
      state: {
        invitationState,
        details,
        clientAgreementPublicKey,
        clientSigningPublicKey,
        clientSigningFingerprint,
        pairingTranscriptHash,
        joinClaimsHash,
        resultEncryptKey: provisional.resultEncryptKey,
        resultNoncePrefix: provisional.resultNoncePrefix.slice(),
        frame,
      },
    }
  } finally {
    wipeBytes(
      transcriptBytes,
      transcriptHashBytes,
      rendezvousSecret,
      pairingSharedSecret,
      provisional?.joinNoncePrefix,
      provisional?.resultNoncePrefix,
      provisional?.sasKey,
      ciphertext,
      aad,
      plaintext,
      claimsBytes,
      joinClaimsHashBytes,
      clientSignature,
      agreementPopShared,
      agreementProofKey,
      agreementProof,
    )
  }
}

export async function openHostPairJoin(
  input: OpenHostPairJoinInput,
): Promise<OpenHostPairJoinResult> {
  const invitation = input.invitation
  const attemptId = input.attemptId
  const wireFrameInput = input.wireFrame
  const now = requireFiniteTimestamp(input.now ?? Date.now())
  const wireFrame = snapshotWireFrame(wireFrameInput)
  const invitationState = hostInvitationStates.get(invitation)
  try {
    if (invitationState === undefined) return Object.freeze({ outcome: 'unavailable' })
    let validated: Awaited<ReturnType<typeof validateHostPairJoinCrypto>> | undefined
    const stateId = randomOpaqueId('state')
    const result = await invitationState.guard.validateAttempt(attemptId, async () => {
      validated = await validateHostPairJoinCrypto(invitationState, wireFrame, now)
      return { valid: true, claim: stateId }
    })
    if (result.outcome !== 'pending-confirmation') {
      wipeHostClaimState(validated?.state)
      if (result.outcome === 'consumed') consumeHostInvitationState(invitationState)
      return result
    }
    if (validated === undefined || result.confirmation.claim !== stateId) {
      invitationState.guard.deny(result.confirmation)
      wipeHostClaimState(validated?.state)
      consumeHostInvitationState(invitationState)
      return Object.freeze({ outcome: 'unavailable' })
    }
    const confirmation = Object.freeze<HostPairingConfirmation>({
      attemptId: result.confirmation.attemptId,
      claim: validated.claim,
    })
    hostConfirmationStates.set(confirmation, {
      claimState: validated.state,
      guardConfirmation: result.confirmation,
      stateId,
      decisionStarted: false,
    })
    invitationState.activeConfirmation = confirmation
    invitationState.activeClaimState = validated.state
    return Object.freeze({ outcome: 'pending-confirmation', confirmation })
  } finally {
    if (typeof wireFrame !== 'string') wireFrame.fill(0)
  }
}

export function getHostPairingSessionStatus(
  invitation: HostPairingInvitationHandle,
  now = Date.now(),
): LocalHostPairingSessionStatus {
  const state = hostInvitationStates.get(invitation)
  if (state === undefined) return pairUnavailable()
  requireFiniteTimestamp(now)
  const status = state.guard.localStatus()
  if (status.state === 'consumed') consumeHostInvitationState(state)
  return status
}

async function sealPairResult(
  state: HostClaimState,
  payload: PairResultPayload,
  now: number,
): Promise<{ readonly frame: Readonly<PairResultFrame>; readonly wireText: string }> {
  const expiresAt = Math.min(state.invitationState.invitation.expiresAt, now + MAX_PAIRING_TTL_MS)
  if (expiresAt <= now) return pairUnavailable()
  const header = {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'pair.result' as const,
    hostId: state.frame.hostId,
    hostDeviceId: state.frame.hostDeviceId,
    pairSessionId: state.frame.pairSessionId,
    joinId: state.frame.joinId,
    seq: 1 as const,
    sentAt: now,
    expiresAt,
  }
  let aad: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  let ciphertext: Uint8Array | undefined
  try {
    aad = encodePairResultAad(header)
    plaintext = textEncoder.encode(encodePairResultPayload(payload))
    ciphertext = await encryptAes256Gcm(
      state.resultEncryptKey,
      state.resultNoncePrefix,
      1n,
      aad,
      plaintext,
    )
    const frame = freezePlainData<PairResultFrame>({
      ...header,
      ciphertext: encodeBase64Url(ciphertext),
    })
    return Object.freeze({ frame, wireText: encodePairResultFrame(frame) })
  } finally {
    wipeBytes(aad, plaintext, ciphertext)
  }
}

export async function approveHostPairing(
  input: ApproveHostPairingInput,
): Promise<ApprovedHostPairing> {
  const confirmation = input.confirmation
  const persistenceAdapter = input.persistenceAdapter
  const commitAuthorizationAndUpsertRelay = persistenceAdapter?.commitAuthorizationAndUpsertRelay
  const now = requireFiniteTimestamp(input.now ?? Date.now())
  if (typeof commitAuthorizationAndUpsertRelay !== 'function') {
    throw new ProtocolViolation('schema-invalid')
  }
  const confirmationState = hostConfirmationStates.get(confirmation)
  if (confirmationState === undefined || confirmationState.decisionStarted) {
    return pairUnavailable()
  }
  const state = confirmationState.claimState
  if (state.invitationState.guard.localStatus().state !== 'pending-confirmation') {
    consumeHostInvitationState(state.invitationState)
    return pairUnavailable()
  }
  // This synchronous transition ensures only the exact local confirmation can
  // start one durable decision, even when two UI callbacks race.
  confirmationState.decisionStarted = true
  const invitation = state.invitationState.invitation
  let hostChallengeBytes: Uint8Array | undefined
  let signatureInput: Uint8Array | undefined
  let signatureBytes: Uint8Array | undefined
  let grantClaimsBytes: Uint8Array | undefined
  let grantClaimsHashBytes: Uint8Array | undefined
  try {
    hostChallengeBytes = randomBytes32()
    const grantClaims = freezePlainData<GrantClaims>({
      protocolVersion: PROTOCOL_VERSION,
      relayOrigin: invitation.relayOrigin,
      hostId: invitation.hostId,
      hostDeviceId: invitation.hostDeviceId,
      clientDeviceId: state.details.clientDeviceId,
      authorizationId: randomOpaqueId('authorization'),
      authorizationEpoch: 1,
      issuedAt: now,
      pairingTranscriptHash: state.pairingTranscriptHash,
      joinClaimsHash: state.joinClaimsHash,
      clientChallenge: state.details.clientChallenge,
      hostChallenge: encodeBase64Url(hostChallengeBytes),
      hostAgreementKey: state.invitationState.hostAgreementJwk,
      hostSigningKey: invitation.hostSigningKey,
      hostSigningFingerprint: invitation.hostKeyFingerprint,
      clientAgreementKey: state.details.clientAgreementKey,
      clientSigningKey: state.details.clientSigningKey,
      clientSigningFingerprint: state.clientSigningFingerprint,
      remotePermissionModes: input.remotePermissionModes === undefined
        ? ['ask', 'read-only']
        : [...input.remotePermissionModes] as ['ask', 'read-only'] | ['ask', 'read-only', 'full-access'],
      approvalDecisions: ['approve-once', 'deny'],
    })
    signatureInput = encodeGrantSignatureInput(grantClaims)
    signatureBytes = await signP256(
      state.invitationState.hostSigningPrivateKey,
      signatureInput,
    )
    if (!await verifyP256(
      state.invitationState.hostSigningPublicKey,
      signatureInput,
      signatureBytes,
    )) {
      return authenticationFailed()
    }
    const hostGrantSignature = encodeBase64Url(signatureBytes)
    grantClaimsBytes = textEncoder.encode(encodeGrantClaims(grantClaims))
    grantClaimsHashBytes = await sha256(grantClaimsBytes)
    const grantClaimsHash = encodeBase64Url(grantClaimsHashBytes)
    const authorization = Object.freeze<HostAuthorizationMaterial>({
      grantClaims,
      hostGrantSignature,
      grantClaimsHash,
      clientAgreementPublicKey: state.clientAgreementPublicKey,
      clientSigningPublicKey: state.clientSigningPublicKey,
    })

    // The trusted adapter executes inside this transition. No caller-supplied
    // post-hoc receipt can release an approved frame.
    const adapterResult = await commitAuthorizationAndUpsertRelay.call(
      persistenceAdapter,
      Object.freeze({ authorization }),
    )
    const relayRevision = adapterResult?.relayRevision
    const nextGeneration = adapterResult?.nextGeneration
    if (
      !Number.isSafeInteger(relayRevision)
      || relayRevision < 1
      || !Number.isSafeInteger(nextGeneration)
      || nextGeneration < 1
    ) {
      throw new ProtocolViolation('schema-invalid')
    }
    const persistence = Object.freeze({ relayRevision, nextGeneration })
    const payload = freezePlainData<PairResultPayload>({
      pairType: 'pair-result',
      hostId: invitation.hostId,
      hostDeviceId: invitation.hostDeviceId,
      pairSessionId: invitation.pairSessionId,
      joinId: state.frame.joinId,
      decidedAt: now,
      outcome: 'approved',
      grantClaims,
      hostGrantSignature,
    })
    const sealed = await sealPairResult(state, payload, now)
    const decision = state.invitationState.guard.approve(confirmationState.guardConfirmation)
    if (
      !decision.accepted
      || decision.terminalOutcome !== 'approved'
      || decision.claim !== confirmationState.stateId
      || sealed.frame.expiresAt <= now
    ) {
      return pairUnavailable()
    }
    const approved = Object.freeze<ApprovedHostPairing>({
      outcome: 'approved',
      ...sealed,
      authorization,
      persistence,
    })
    consumeHostInvitationState(state.invitationState)
    return approved
  } catch (error) {
    state.invitationState.guard.deny(confirmationState.guardConfirmation)
    consumeHostInvitationState(state.invitationState)
    throw error
  } finally {
    wipeBytes(
      hostChallengeBytes,
      signatureInput,
      signatureBytes,
      grantClaimsBytes,
      grantClaimsHashBytes,
    )
  }
}

export async function prepareHostPairingDenial(input: {
  readonly confirmation: HostPairingConfirmation
  readonly now?: number
}): Promise<PreparedHostPairingDenial> {
  const confirmation = input.confirmation
  const now = requireFiniteTimestamp(input.now ?? Date.now())
  const confirmationState = hostConfirmationStates.get(confirmation)
  if (confirmationState === undefined || confirmationState.decisionStarted) {
    return pairUnavailable()
  }
  const state = confirmationState.claimState
  if (state.invitationState.guard.localStatus().state !== 'pending-confirmation') {
    consumeHostInvitationState(state.invitationState)
    return pairUnavailable()
  }
  confirmationState.decisionStarted = true
  const invitation = state.invitationState.invitation
  const payload = freezePlainData<PairResultPayload>({
    pairType: 'pair-result',
    hostId: invitation.hostId,
    hostDeviceId: invitation.hostDeviceId,
    pairSessionId: invitation.pairSessionId,
    joinId: state.frame.joinId,
    decidedAt: now,
    outcome: 'denied',
  })
  try {
    const sealed = await sealPairResult(state, payload, now)
    const decision = state.invitationState.guard.deny(confirmationState.guardConfirmation)
    if (!decision.accepted || decision.terminalOutcome !== 'denied') {
      return pairUnavailable()
    }
    const denial = Object.freeze({ outcome: 'denied' as const, ...sealed })
    consumeHostInvitationState(state.invitationState)
    return denial
  } catch (error) {
    state.invitationState.guard.deny(confirmationState.guardConfirmation)
    consumeHostInvitationState(state.invitationState)
    throw error
  }
}

function assertResultIdentity(
  payload: PairResultPayload,
  state: ClientPairingState,
): void {
  const invitation = state.invitation
  if (
    payload.hostId !== invitation.hostId
    || payload.hostDeviceId !== invitation.hostDeviceId
    || payload.pairSessionId !== invitation.pairSessionId
    || payload.joinId !== state.handle.joinId
  ) {
    authenticationFailed()
  }
}

async function verifyApprovedGrant(
  payload: Extract<PairResultPayload, { outcome: 'approved' }>,
  state: ClientPairingState,
  verifiedInvitation: VerifiedInvitation,
): Promise<{
  readonly hostAgreementPublicKey: CryptoKey
  readonly grantClaimsHash: string
}> {
  const claims = payload.grantClaims
  const invitation = state.invitation
  let signatureInput: Uint8Array | undefined
  let signature: Uint8Array | undefined
  let grantClaimsBytes: Uint8Array | undefined
  let grantClaimsHashBytes: Uint8Array | undefined
  try {
    signatureInput = encodeGrantSignatureInput(claims)
    signature = requireDecodedBytes(payload.hostGrantSignature, 64)
    if (!await verifyP256(
      verifiedInvitation.hostSigningPublicKey,
      signatureInput,
      signature,
    )) {
      return authenticationFailed()
    }

    if (
      claims.relayOrigin !== state.expectedRelayOrigin
      || claims.hostId !== invitation.hostId
      || claims.hostDeviceId !== invitation.hostDeviceId
      || claims.clientDeviceId !== state.handle.clientDeviceId
      || claims.authorizationEpoch !== 1
      || claims.pairingTranscriptHash !== state.pairingTranscriptHash
      || claims.joinClaimsHash !== state.joinClaimsHash
      || claims.clientChallenge !== state.clientChallenge
      || claims.hostSigningFingerprint !== invitation.hostKeyFingerprint
      || !publicJwksEqual(claims.hostSigningKey, invitation.hostSigningKey)
      || !publicJwksEqual(claims.clientAgreementKey, state.clientAgreementJwk)
      || !publicJwksEqual(claims.clientSigningKey, state.clientSigningJwk)
      || claims.issuedAt < invitation.issuedAt
      || claims.issuedAt > invitation.expiresAt
    ) {
      return authenticationFailed()
    }

    const [hostAgreementPublicKey, hostSigningFingerprint, clientSigningFingerprint] = await Promise.all([
      importAgreementPublicKey(claims.hostAgreementKey),
      fingerprintP256PublicJwk(claims.hostSigningKey),
      fingerprintP256PublicJwk(claims.clientSigningKey),
    ])
    assertAuthenticatedString(hostSigningFingerprint, claims.hostSigningFingerprint)
    assertAuthenticatedString(clientSigningFingerprint, claims.clientSigningFingerprint)
    if (publicJwksEqual(claims.hostAgreementKey, claims.hostSigningKey)) {
      return authenticationFailed()
    }
    grantClaimsBytes = textEncoder.encode(encodeGrantClaims(claims))
    grantClaimsHashBytes = await sha256(grantClaimsBytes)
    return {
      hostAgreementPublicKey,
      grantClaimsHash: encodeBase64Url(grantClaimsHashBytes),
    }
  } finally {
    wipeBytes(signatureInput, signature, grantClaimsBytes, grantClaimsHashBytes)
  }
}

export async function openClientPairResult(
  handle: ClientPairingHandle,
  wireFrame: string | Uint8Array,
  now = Date.now(),
): Promise<OpenedClientPairResult> {
  const handleSnapshot = handle
  const checkedNow = requireFiniteTimestamp(now)
  const ownedWireFrame = snapshotWireFrame(wireFrame)
  try {
    const state = clientPairingStates.get(handleSnapshot)
    if (state === undefined || state.consumed) return pairUnavailable()
    if (checkedNow >= state.invitation.expiresAt) {
      consumeClientPairingState(handleSnapshot, state)
      return pairUnavailable()
    }
    // Re-validate the complete invitation trust chain at authorization install time.
    const verifiedInvitation = await verifyInvitation(
      state.invitation,
      state.expectedRelayOrigin,
      checkedNow,
    )
    if (state.consumed) return pairUnavailable()
    const frame = decodePairResultFrame(ownedWireFrame, {
      now: checkedNow,
      invitationExpiresAt: state.invitation.expiresAt,
    })
    assertResultRoute(frame, state.invitation, state.handle.joinId)
    let ciphertext: Uint8Array | undefined
    let aad: Uint8Array | undefined
    let plaintext: Uint8Array | undefined
    try {
      ciphertext = decodeBase64Url(frame.ciphertext)
      if (ciphertext === undefined) return authenticationFailed()
      aad = encodePairResultAad(pairResultHeader(frame))
      plaintext = await decryptAes256Gcm(
        state.resultDecryptKey,
        state.resultNoncePrefix,
        1n,
        aad,
        ciphertext,
      )
      const payload = decodePairResultPayload(plaintext)
      assertResultIdentity(payload, state)

      if (payload.outcome !== 'approved') {
        if (!consumeClientPairingState(handleSnapshot, state)) return pairUnavailable()
        return Object.freeze({ outcome: payload.outcome, decidedAt: payload.decidedAt })
      }

      const verifiedGrant = await verifyApprovedGrant(payload, state, verifiedInvitation)
      if (!consumeClientPairingState(handleSnapshot, state)) return pairUnavailable()
      const authorization = Object.freeze<ClientAuthorizationMaterial>({
        grantClaims: freezePlainData(payload.grantClaims),
        hostGrantSignature: payload.hostGrantSignature,
        grantClaimsHash: verifiedGrant.grantClaimsHash,
        clientAgreementPrivateKey: state.clientAgreementKeyPair.privateKey,
        clientAgreementPublicKey: state.clientAgreementKeyPair.publicKey,
        clientSigningPrivateKey: state.clientSigningKeyPair.privateKey,
        clientSigningPublicKey: state.clientSigningKeyPair.publicKey,
        hostAgreementPublicKey: verifiedGrant.hostAgreementPublicKey,
        hostSigningPublicKey: verifiedInvitation.hostSigningPublicKey,
      })
      return Object.freeze({
        outcome: 'approved',
        decidedAt: payload.decidedAt,
        authorization,
      })
    } finally {
      wipeBytes(ciphertext, aad, plaintext)
    }
  } finally {
    if (typeof ownedWireFrame !== 'string') ownedWireFrame.fill(0)
  }
}
