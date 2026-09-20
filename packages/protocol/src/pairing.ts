import * as z from 'zod'

import { decodeBase64Url, encodeBase64Url } from './base64url.ts'
import { decodeCanonicalJson, encodeCanonicalJson } from './codec.ts'
import { ProtocolViolation } from './errors.ts'
import {
  AES_GCM_TAG_BYTES,
  Base64UrlSchema,
  MAX_CLOCK_SKEW_MS,
  OpaqueIdentifierSchema,
  PROTOCOL_VERSION,
  SafeIntegerSchema,
} from './schemas.ts'

const pairingEncoder = new TextEncoder()
const pairingDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export const MAX_PAIRING_FRAGMENT_BYTES = 8 * 1024
export const MAX_PAIRING_CIPHERTEXT_BYTES = 8 * 1024
export const MAX_PAIRING_PLAINTEXT_BYTES = MAX_PAIRING_CIPHERTEXT_BYTES - AES_GCM_TAG_BYTES
export const MAX_PAIRING_FRAME_BYTES = 16 * 1024
export const MAX_PAIRING_TTL_MS = 30_000
export const MAX_PAIRING_INVITATION_TTL_MS = 300_000

const MAX_PAIRING_FRAGMENT_CHARACTERS = Math.ceil(MAX_PAIRING_FRAGMENT_BYTES * 4 / 3)
const MAX_PAIRING_CIPHERTEXT_CHARACTERS = Math.ceil(MAX_PAIRING_CIPHERTEXT_BYTES * 4 / 3)

export const base64UrlBytesSchema = (byteLength: number) => Base64UrlSchema.refine(
  value => decodeBase64Url(value)?.byteLength === byteLength,
)

export const Hash32Schema = base64UrlBytesSchema(32)
export const Secret32Schema = base64UrlBytesSchema(32)
export const P256RawSignatureSchema = base64UrlBytesSchema(64)

export const P256PublicJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: base64UrlBytesSchema(32),
  y: base64UrlBytesSchema(32),
})

export type P256PublicJwk = z.infer<typeof P256PublicJwkSchema>

function relayOriginIsAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    if (
      url.origin !== value
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/'
      || url.search !== ''
      || url.hash !== ''
    ) {
      return false
    }
    if (url.protocol === 'https:') return true
    if (url.protocol !== 'http:') return false
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  } catch {
    return false
  }
}

export const RelayOriginSchema = z.string().max(2048).refine(relayOriginIsAllowed)

function samePublicKey(left: P256PublicJwk, right: P256PublicJwk): boolean {
  return left.x === right.x && left.y === right.y
}

const unsignedInvitationShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayOrigin: RelayOriginSchema,
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  issuedAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
  rendezvousSecret: Secret32Schema,
  hostEphemeralAgreementKey: P256PublicJwkSchema,
  hostSigningKey: P256PublicJwkSchema,
  hostKeyFingerprint: Hash32Schema,
}

type InvitationRefinementValue = {
  issuedAt: number
  expiresAt: number
  hostEphemeralAgreementKey: P256PublicJwk
  hostSigningKey: P256PublicJwk
}

function refineInvitation(invitation: InvitationRefinementValue, context: z.RefinementCtx): void {
  if (
    invitation.expiresAt <= invitation.issuedAt
    || invitation.expiresAt - invitation.issuedAt > MAX_PAIRING_INVITATION_TTL_MS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Pairing invitation lifetime exceeds five minutes.',
    })
  }
  if (samePublicKey(invitation.hostEphemeralAgreementKey, invitation.hostSigningKey)) {
    context.addIssue({
      code: 'custom',
      path: ['hostSigningKey'],
      message: 'Agreement and signing keys must be distinct.',
    })
  }
}

export const UnsignedPairingInvitationSchema = z.strictObject(unsignedInvitationShape)
  .superRefine(refineInvitation)

export const PairingInvitationSchema = z.strictObject({
  ...unsignedInvitationShape,
  invitationSignature: P256RawSignatureSchema,
}).superRefine(refineInvitation)

export type UnsignedPairingInvitation = z.infer<typeof UnsignedPairingInvitationSchema>
export type PairingInvitation = z.infer<typeof PairingInvitationSchema>

export const PairingSessionStatusSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  state: z.enum([
    'waiting',
    'validating',
    'pending-confirmation',
    'approved',
    'denied',
    'expired',
    'attempt-limit',
    'consumed',
  ]),
  updatedAt: SafeIntegerSchema,
})

export type PairingSessionStatus = z.infer<typeof PairingSessionStatusSchema>

export function validatePairingInvitationTime(
  invitation: PairingInvitation | UnsignedPairingInvitation,
  now = Date.now(),
): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolViolation('schema-invalid')
  if (
    invitation.expiresAt <= invitation.issuedAt
    || invitation.expiresAt - invitation.issuedAt > MAX_PAIRING_INVITATION_TTL_MS
  ) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  if (invitation.issuedAt > now + MAX_CLOCK_SKEW_MS) throw new ProtocolViolation('future-sent-at')
  if (invitation.expiresAt <= now) throw new ProtocolViolation('pair-session-unavailable')
}

function parseExpectedRelayOrigin(value: unknown): string {
  const result = RelayOriginSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  return result.data
}

export function encodePairingInvitationFragment(value: unknown): string {
  const json = encodeCanonicalJson(PairingInvitationSchema, value, MAX_PAIRING_FRAGMENT_BYTES)
  return encodeBase64Url(pairingEncoder.encode(json))
}

export function decodePairingInvitationFragment(
  fragment: string,
  expectedRelayOrigin: string,
  now = Date.now(),
): PairingInvitation {
  const expectedOrigin = parseExpectedRelayOrigin(expectedRelayOrigin)
  const encoded = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (encoded.length > MAX_PAIRING_FRAGMENT_CHARACTERS) {
    throw new ProtocolViolation('schema-invalid')
  }
  const bytes = decodeBase64Url(encoded)
  if (bytes === undefined || bytes.byteLength > MAX_PAIRING_FRAGMENT_BYTES) {
    throw new ProtocolViolation('schema-invalid')
  }
  let text: string
  try {
    text = pairingDecoder.decode(bytes)
  } catch {
    throw new ProtocolViolation('invalid-json')
  }
  const invitation = decodeCanonicalJson(PairingInvitationSchema, text, MAX_PAIRING_FRAGMENT_BYTES)
  if (invitation.relayOrigin !== expectedOrigin) throw new ProtocolViolation('route-mismatch')
  validatePairingInvitationTime(invitation, now)
  return invitation
}

export function canonicalP256JwkTuple(
  value: unknown,
): readonly ['EC', 'P-256', string, string] {
  const result = P256PublicJwkSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const jwk = result.data
  return [jwk.kty, jwk.crv, jwk.x, jwk.y]
}

function parseUnsignedInvitation(value: unknown): UnsignedPairingInvitation {
  const unsignedResult = UnsignedPairingInvitationSchema.safeParse(value)
  if (unsignedResult.success) return unsignedResult.data

  const signedResult = PairingInvitationSchema.safeParse(value)
  if (!signedResult.success) throw new ProtocolViolation('schema-invalid')
  const invitation = signedResult.data
  return {
    protocolVersion: invitation.protocolVersion,
    relayOrigin: invitation.relayOrigin,
    hostId: invitation.hostId,
    hostDeviceId: invitation.hostDeviceId,
    pairSessionId: invitation.pairSessionId,
    issuedAt: invitation.issuedAt,
    expiresAt: invitation.expiresAt,
    rendezvousSecret: invitation.rendezvousSecret,
    hostEphemeralAgreementKey: invitation.hostEphemeralAgreementKey,
    hostSigningKey: invitation.hostSigningKey,
    hostKeyFingerprint: invitation.hostKeyFingerprint,
  }
}

export function encodeInvitationSignatureInput(value: unknown): Uint8Array {
  const invitation = parseUnsignedInvitation(value)
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-invitation-signature-v1',
    invitation.protocolVersion,
    invitation.relayOrigin,
    invitation.hostId,
    invitation.hostDeviceId,
    invitation.pairSessionId,
    invitation.issuedAt,
    invitation.expiresAt,
    invitation.rendezvousSecret,
    canonicalP256JwkTuple(invitation.hostEphemeralAgreementKey),
    canonicalP256JwkTuple(invitation.hostSigningKey),
    invitation.hostKeyFingerprint,
  ]))
}

export const encodePairingInvitationSignatureInput = encodeInvitationSignatureInput

export function encodePairingTranscript(
  invitationValue: unknown,
  clientEphemeralValue: unknown,
): Uint8Array {
  const invitationResult = PairingInvitationSchema.safeParse(invitationValue)
  const clientEphemeralResult = P256PublicJwkSchema.safeParse(clientEphemeralValue)
  if (!invitationResult.success || !clientEphemeralResult.success) {
    throw new ProtocolViolation('schema-invalid')
  }
  const invitation = invitationResult.data
  const clientEphemeral = clientEphemeralResult.data
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pairing-transcript-v1',
    invitation.protocolVersion,
    invitation.relayOrigin,
    invitation.hostId,
    invitation.hostDeviceId,
    invitation.pairSessionId,
    invitation.issuedAt,
    invitation.expiresAt,
    canonicalP256JwkTuple(invitation.hostEphemeralAgreementKey),
    canonicalP256JwkTuple(invitation.hostSigningKey),
    invitation.hostKeyFingerprint,
    invitation.invitationSignature,
    canonicalP256JwkTuple(clientEphemeral),
  ]))
}

export function encodeP256JwkThumbprintInput(value: unknown): Uint8Array {
  const result = P256PublicJwkSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const jwk = result.data
  return pairingEncoder.encode(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}

const shortCiphertextSchema = Base64UrlSchema
  .max(MAX_PAIRING_CIPHERTEXT_CHARACTERS)
  .refine(value => (decodeBase64Url(value)?.byteLength ?? Number.POSITIVE_INFINITY) <= MAX_PAIRING_CIPHERTEXT_BYTES)

const pairJoinHeaderShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('pair.join'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  joinId: OpaqueIdentifierSchema,
  clientEphemeralAgreementKey: P256PublicJwkSchema,
  seq: z.literal(1),
  sentAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
}

function refineShortLifetime(
  value: { sentAt: number; expiresAt: number },
  context: z.RefinementCtx,
): void {
  if (value.expiresAt <= value.sentAt || value.expiresAt - value.sentAt > MAX_PAIRING_TTL_MS) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Pair frame lifetime exceeds 30 seconds.' })
  }
}

export const PairJoinHeaderSchema = z.strictObject(pairJoinHeaderShape).superRefine(refineShortLifetime)

export const PairJoinFrameSchema = z.strictObject({
  ...pairJoinHeaderShape,
  ciphertext: shortCiphertextSchema,
}).superRefine(refineShortLifetime)

export type PairJoinHeader = z.infer<typeof PairJoinHeaderSchema>
export type PairJoinFrame = z.infer<typeof PairJoinFrameSchema>

export function pairJoinHeader(frame: PairJoinFrame): PairJoinHeader {
  return {
    protocolVersion: frame.protocolVersion,
    relayType: frame.relayType,
    hostId: frame.hostId,
    hostDeviceId: frame.hostDeviceId,
    pairSessionId: frame.pairSessionId,
    joinId: frame.joinId,
    clientEphemeralAgreementKey: frame.clientEphemeralAgreementKey,
    seq: frame.seq,
    sentAt: frame.sentAt,
    expiresAt: frame.expiresAt,
  }
}

function validatePairTime(
  value: { sentAt: number; expiresAt: number },
  now: number,
  invitationExpiresAt?: number,
): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolViolation('schema-invalid')
  if (
    invitationExpiresAt !== undefined
    && (!Number.isSafeInteger(invitationExpiresAt) || invitationExpiresAt < 0)
  ) {
    throw new ProtocolViolation('schema-invalid')
  }
  if (value.expiresAt <= value.sentAt || value.expiresAt - value.sentAt > MAX_PAIRING_TTL_MS) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  if (invitationExpiresAt !== undefined && value.expiresAt > invitationExpiresAt) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  if (value.sentAt > now + MAX_CLOCK_SKEW_MS) throw new ProtocolViolation('future-sent-at')
  if (value.expiresAt <= now) throw new ProtocolViolation('pair-session-unavailable')
}

export interface DecodePairFrameOptions {
  now?: number
  invitationExpiresAt?: number
  validateTime?: boolean
}

function rejectOversizedCiphertext(value: unknown): void {
  if (
    typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).ciphertext === 'string'
    && ((value as Record<string, unknown>).ciphertext as string).length > MAX_PAIRING_CIPHERTEXT_CHARACTERS
  ) {
    throw new ProtocolViolation('payload-too-large')
  }
}

export function encodePairJoinFrame(value: unknown): string {
  rejectOversizedCiphertext(value)
  return encodeCanonicalJson(PairJoinFrameSchema, value, MAX_PAIRING_FRAME_BYTES)
}

export function decodePairJoinFrame(
  frame: string | Uint8Array,
  options: DecodePairFrameOptions = {},
): PairJoinFrame {
  const join = decodeCanonicalJson(PairJoinFrameSchema, frame, MAX_PAIRING_FRAME_BYTES)
  if (options.validateTime !== false) {
    validatePairTime(join, options.now ?? Date.now(), options.invitationExpiresAt)
  }
  return join
}

export function encodePairJoinAad(value: unknown): Uint8Array {
  const result = PairJoinHeaderSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const header = result.data
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pair-join-aad-v1',
    header.protocolVersion,
    header.hostId,
    header.hostDeviceId,
    header.pairSessionId,
    header.joinId,
    canonicalP256JwkTuple(header.clientEphemeralAgreementKey),
    header.seq,
    header.sentAt,
    header.expiresAt,
  ]))
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function safeDeviceDisplayName(value: string): boolean {
  return value.trim() === value
    && isWellFormedUnicode(value)
    && !/[\p{Cc}\p{Cf}]/u.test(value)
}

export const DeviceDisplayNameSchema = z.string().min(1).max(80).refine(safeDeviceDisplayName)

const pairJoinClaimsShape = {
  pairingTranscriptHash: Hash32Schema,
  clientDeviceId: OpaqueIdentifierSchema,
  deviceDisplayName: DeviceDisplayNameSchema,
  clientChallenge: Secret32Schema,
  clientAgreementKey: P256PublicJwkSchema,
  clientSigningKey: P256PublicJwkSchema,
}

function refineClientKeys(
  value: { clientAgreementKey: P256PublicJwk; clientSigningKey: P256PublicJwk },
  context: z.RefinementCtx,
): void {
  if (samePublicKey(value.clientAgreementKey, value.clientSigningKey)) {
    context.addIssue({
      code: 'custom',
      path: ['clientSigningKey'],
      message: 'Agreement and signing keys must be distinct.',
    })
  }
}

export const PairJoinClaimsSchema = z.strictObject(pairJoinClaimsShape).superRefine(refineClientKeys)

export const PairJoinDetailsSchema = z.strictObject({
  pairType: z.literal('join-details'),
  ...pairJoinClaimsShape,
  clientJoinSignature: P256RawSignatureSchema,
  clientAgreementProof: Hash32Schema,
}).superRefine(refineClientKeys)

export type PairJoinClaims = z.infer<typeof PairJoinClaimsSchema>
export type PairJoinDetails = z.infer<typeof PairJoinDetailsSchema>

export function pairJoinClaims(details: PairJoinDetails): PairJoinClaims {
  return {
    pairingTranscriptHash: details.pairingTranscriptHash,
    clientDeviceId: details.clientDeviceId,
    deviceDisplayName: details.deviceDisplayName,
    clientChallenge: details.clientChallenge,
    clientAgreementKey: details.clientAgreementKey,
    clientSigningKey: details.clientSigningKey,
  }
}

function parsePairJoinClaims(value: unknown): PairJoinClaims {
  const claimsResult = PairJoinClaimsSchema.safeParse(value)
  if (claimsResult.success) return claimsResult.data
  const detailsResult = PairJoinDetailsSchema.safeParse(value)
  if (!detailsResult.success) throw new ProtocolViolation('schema-invalid')
  return pairJoinClaims(detailsResult.data)
}

export function encodePairJoinClaims(value: unknown): Uint8Array {
  const claims = parsePairJoinClaims(value)
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pair-join-signature-v1',
    claims.pairingTranscriptHash,
    claims.clientDeviceId,
    claims.deviceDisplayName,
    claims.clientChallenge,
    canonicalP256JwkTuple(claims.clientAgreementKey),
    canonicalP256JwkTuple(claims.clientSigningKey),
  ]))
}

export const encodePairJoinSignatureInput = encodePairJoinClaims

export function encodePairJoinDetails(value: unknown): string {
  return encodeCanonicalJson(PairJoinDetailsSchema, value, MAX_PAIRING_PLAINTEXT_BYTES)
}

export function decodePairJoinDetails(frame: string | Uint8Array): PairJoinDetails {
  return decodeCanonicalJson(PairJoinDetailsSchema, frame, MAX_PAIRING_PLAINTEXT_BYTES)
}

const PairHashContextSchema = z.strictObject({
  pairingTranscriptHash: Hash32Schema,
  joinClaimsHash: Hash32Schema,
})

export type PairHashContext = z.infer<typeof PairHashContextSchema>

export function encodeAgreementProofInfo(value: unknown): Uint8Array {
  const result = PairHashContextSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pair-agreement-pop-v1',
    result.data.pairingTranscriptHash,
    result.data.joinClaimsHash,
  ]))
}

export function encodePairSasInput(value: unknown): Uint8Array {
  const result = PairHashContextSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pair-sas-v1',
    result.data.pairingTranscriptHash,
    result.data.joinClaimsHash,
  ]))
}

export const PairingKdfPurposeSchema = z.enum([
  'client-to-host-key',
  'client-to-host-nonce-prefix',
  'host-to-client-key',
  'host-to-client-nonce-prefix',
  'sas-key',
])

export type PairingKdfPurpose = z.infer<typeof PairingKdfPurposeSchema>

const PairingKdfContextSchema = z.strictObject({
  pairingTranscriptHash: Hash32Schema,
  purpose: PairingKdfPurposeSchema,
})

export function encodePairingKdfInfo(value: unknown): Uint8Array {
  const result = PairingKdfContextSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pairing-kdf-v1',
    result.data.pairingTranscriptHash,
    result.data.purpose,
  ]))
}

const grantClaimsShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayOrigin: RelayOriginSchema,
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  clientDeviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: z.literal(1),
  issuedAt: SafeIntegerSchema,
  pairingTranscriptHash: Hash32Schema,
  joinClaimsHash: Hash32Schema,
  clientChallenge: Secret32Schema,
  hostChallenge: Secret32Schema,
  hostAgreementKey: P256PublicJwkSchema,
  hostSigningKey: P256PublicJwkSchema,
  hostSigningFingerprint: Hash32Schema,
  clientAgreementKey: P256PublicJwkSchema,
  clientSigningKey: P256PublicJwkSchema,
  clientSigningFingerprint: Hash32Schema,
  remotePermissionModes: z.union([
    z.tuple([z.literal('ask'), z.literal('read-only')]),
    z.tuple([z.literal('ask'), z.literal('read-only'), z.literal('full-access')]),
  ]),
  approvalDecisions: z.tuple([z.literal('approve-once'), z.literal('deny')]),
}

export const GrantClaimsSchema = z.strictObject(grantClaimsShape).superRefine((claims, context) => {
  if (samePublicKey(claims.hostAgreementKey, claims.hostSigningKey)) {
    context.addIssue({ code: 'custom', path: ['hostSigningKey'], message: 'Host keys must be distinct.' })
  }
  if (samePublicKey(claims.clientAgreementKey, claims.clientSigningKey)) {
    context.addIssue({ code: 'custom', path: ['clientSigningKey'], message: 'Client keys must be distinct.' })
  }
})

export type GrantClaims = z.infer<typeof GrantClaimsSchema>

export function encodeGrantClaims(value: unknown): string {
  return encodeCanonicalJson(GrantClaimsSchema, value, MAX_PAIRING_PLAINTEXT_BYTES)
}

export function decodeGrantClaims(frame: string | Uint8Array): GrantClaims {
  return decodeCanonicalJson(GrantClaimsSchema, frame, MAX_PAIRING_PLAINTEXT_BYTES)
}

export function encodeGrantSignatureInput(value: unknown): Uint8Array {
  const result = GrantClaimsSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const claims = result.data
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pair-grant-signature-v1',
    claims.protocolVersion,
    claims.relayOrigin,
    claims.hostId,
    claims.hostDeviceId,
    claims.clientDeviceId,
    claims.authorizationId,
    claims.authorizationEpoch,
    claims.issuedAt,
    claims.pairingTranscriptHash,
    claims.joinClaimsHash,
    claims.clientChallenge,
    claims.hostChallenge,
    canonicalP256JwkTuple(claims.hostAgreementKey),
    canonicalP256JwkTuple(claims.hostSigningKey),
    claims.hostSigningFingerprint,
    canonicalP256JwkTuple(claims.clientAgreementKey),
    canonicalP256JwkTuple(claims.clientSigningKey),
    claims.clientSigningFingerprint,
    claims.remotePermissionModes,
    claims.approvalDecisions,
  ]))
}

const pairResultIdentityShape = {
  pairType: z.literal('pair-result'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  joinId: OpaqueIdentifierSchema,
  decidedAt: SafeIntegerSchema,
}

export const PairResultPayloadSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...pairResultIdentityShape, outcome: z.literal('denied') }),
  z.strictObject({ ...pairResultIdentityShape, outcome: z.literal('expired') }),
  z.strictObject({
    ...pairResultIdentityShape,
    outcome: z.literal('approved'),
    grantClaims: GrantClaimsSchema,
    hostGrantSignature: P256RawSignatureSchema,
  }),
]).superRefine((result, context) => {
  if (
    result.outcome === 'approved'
    && (
      result.hostId !== result.grantClaims.hostId
      || result.hostDeviceId !== result.grantClaims.hostDeviceId
    )
  ) {
    context.addIssue({ code: 'custom', message: 'Pair result authority is inconsistent.' })
  }
})

export type PairResultPayload = z.infer<typeof PairResultPayloadSchema>

export function encodePairResultPayload(value: unknown): string {
  return encodeCanonicalJson(PairResultPayloadSchema, value, MAX_PAIRING_PLAINTEXT_BYTES)
}

export function decodePairResultPayload(frame: string | Uint8Array): PairResultPayload {
  return decodeCanonicalJson(PairResultPayloadSchema, frame, MAX_PAIRING_PLAINTEXT_BYTES)
}

const pairResultHeaderShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('pair.result'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  joinId: OpaqueIdentifierSchema,
  seq: z.literal(1),
  sentAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
}

export const PairResultHeaderSchema = z.strictObject(pairResultHeaderShape).superRefine(refineShortLifetime)

export const PairResultFrameSchema = z.strictObject({
  ...pairResultHeaderShape,
  ciphertext: shortCiphertextSchema,
}).superRefine(refineShortLifetime)

export type PairResultHeader = z.infer<typeof PairResultHeaderSchema>
export type PairResultFrame = z.infer<typeof PairResultFrameSchema>

export function pairResultHeader(frame: PairResultFrame): PairResultHeader {
  return {
    protocolVersion: frame.protocolVersion,
    relayType: frame.relayType,
    hostId: frame.hostId,
    hostDeviceId: frame.hostDeviceId,
    pairSessionId: frame.pairSessionId,
    joinId: frame.joinId,
    seq: frame.seq,
    sentAt: frame.sentAt,
    expiresAt: frame.expiresAt,
  }
}

export function encodePairResultFrame(value: unknown): string {
  rejectOversizedCiphertext(value)
  return encodeCanonicalJson(PairResultFrameSchema, value, MAX_PAIRING_FRAME_BYTES)
}

export function decodePairResultFrame(
  frame: string | Uint8Array,
  options: DecodePairFrameOptions = {},
): PairResultFrame {
  const result = decodeCanonicalJson(PairResultFrameSchema, frame, MAX_PAIRING_FRAME_BYTES)
  if (options.validateTime !== false) {
    validatePairTime(result, options.now ?? Date.now(), options.invitationExpiresAt)
  }
  return result
}

export function encodePairResultAad(value: unknown): Uint8Array {
  const result = PairResultHeaderSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const header = result.data
  return pairingEncoder.encode(JSON.stringify([
    'codex-plus-pair-result-aad-v1',
    header.protocolVersion,
    header.hostId,
    header.hostDeviceId,
    header.pairSessionId,
    header.joinId,
    header.seq,
    header.sentAt,
    header.expiresAt,
  ]))
}
