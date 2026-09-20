import * as z from 'zod'

import { decodeCanonicalJson, encodeCanonicalJson } from './codec.ts'
import { ProtocolViolation } from './errors.ts'
import {
  Hash32Schema,
  P256PublicJwkSchema,
  P256RawSignatureSchema,
  RelayOriginSchema,
  Secret32Schema,
} from './pairing.ts'
import {
  MAX_CLOCK_SKEW_MS,
  MAX_FRAME_BYTES,
  OpaqueIdentifierSchema,
  PositiveSafeIntegerSchema,
  PROTOCOL_VERSION,
  SafeIntegerSchema,
} from './schemas.ts'

const relayR3Encoder = new TextEncoder()

export const MAX_RELAY_R3_CONTROL_BYTES = 16 * 1024
export const MAX_R3_RELAY_CONTROL_BYTES = MAX_RELAY_R3_CONTROL_BYTES
export const MAX_RELAY_CHALLENGE_TTL_MS = 15_000
export const MAX_RELAY_PAIR_OPEN_TTL_MS = 300_000

export const RelayR3RoleSchema = z.enum(['host', 'client'])
export type RelayR3Role = z.infer<typeof RelayR3RoleSchema>

export const RelayR3AuthModeSchema = z.enum(['bootstrap', 'challenge'])
export type RelayR3AuthMode = z.infer<typeof RelayR3AuthModeSchema>

function refineHostIdentity(
  value: { hostDeviceId: string; deviceId: string },
  context: z.RefinementCtx,
): void {
  if (value.deviceId !== value.hostDeviceId) {
    context.addIssue({
      code: 'custom',
      path: ['deviceId'],
      message: 'A Host route must use hostDeviceId as deviceId.',
    })
  }
}

function refineClientIdentity(
  value: { hostDeviceId: string; deviceId: string },
  context: z.RefinementCtx,
): void {
  if (value.deviceId === value.hostDeviceId) {
    context.addIssue({
      code: 'custom',
      path: ['deviceId'],
      message: 'A Client route cannot reuse hostDeviceId.',
    })
  }
}

const helloPrefix = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('device.hello'),
  relayOrigin: RelayOriginSchema,
}

export const RelayHostBootstrapHelloSchema = z.strictObject({
  ...helloPrefix,
  role: z.literal('host'),
  authMode: z.literal('bootstrap'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  bootstrapCredential: Secret32Schema,
  hostSigningKey: P256PublicJwkSchema,
  hostSigningFingerprint: Hash32Schema,
}).superRefine(refineHostIdentity)

export const RelayHostChallengeHelloSchema = z.strictObject({
  ...helloPrefix,
  role: z.literal('host'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
}).superRefine(refineHostIdentity)

export const RelayClientChallengeHelloSchema = z.strictObject({
  ...helloPrefix,
  role: z.literal('client'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
}).superRefine(refineClientIdentity)

export const RelayDeviceHelloSchema = z.union([
  RelayHostBootstrapHelloSchema,
  RelayHostChallengeHelloSchema,
  RelayClientChallengeHelloSchema,
])

export type RelayHostBootstrapHello = z.infer<typeof RelayHostBootstrapHelloSchema>
export type RelayHostChallengeHello = z.infer<typeof RelayHostChallengeHelloSchema>
export type RelayClientChallengeHello = z.infer<typeof RelayClientChallengeHelloSchema>
export type RelayDeviceHello = z.infer<typeof RelayDeviceHelloSchema>

const challengeSuffix = {
  challengeId: OpaqueIdentifierSchema,
  challenge: Secret32Schema,
  issuedAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
}

function refineChallengeLifetime(
  value: { issuedAt: number; expiresAt: number },
  context: z.RefinementCtx,
): void {
  if (
    value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > MAX_RELAY_CHALLENGE_TTL_MS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'A Relay device challenge can live for at most 15 seconds.',
    })
  }
}

const challengePrefix = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('device.challenge'),
  relayOrigin: RelayOriginSchema,
}

export const RelayHostBootstrapChallengeSchema = z.strictObject({
  ...challengePrefix,
  role: z.literal('host'),
  authMode: z.literal('bootstrap'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  hostSigningFingerprint: Hash32Schema,
  ...challengeSuffix,
}).superRefine((value, context) => {
  refineHostIdentity(value, context)
  refineChallengeLifetime(value, context)
})

export const RelayHostChallengeSchema = z.strictObject({
  ...challengePrefix,
  role: z.literal('host'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  ...challengeSuffix,
}).superRefine((value, context) => {
  refineHostIdentity(value, context)
  refineChallengeLifetime(value, context)
})

export const RelayClientChallengeSchema = z.strictObject({
  ...challengePrefix,
  role: z.literal('client'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  ...challengeSuffix,
}).superRefine((value, context) => {
  refineClientIdentity(value, context)
  refineChallengeLifetime(value, context)
})

export const RelayDeviceChallengeSchema = z.union([
  RelayHostBootstrapChallengeSchema,
  RelayHostChallengeSchema,
  RelayClientChallengeSchema,
])

export type RelayHostBootstrapChallenge = z.infer<typeof RelayHostBootstrapChallengeSchema>
export type RelayHostChallenge = z.infer<typeof RelayHostChallengeSchema>
export type RelayClientChallenge = z.infer<typeof RelayClientChallengeSchema>
export type RelayDeviceChallenge = z.infer<typeof RelayDeviceChallengeSchema>

const proofPrefix = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('device.proof'),
  relayOrigin: RelayOriginSchema,
}

const proofSuffix = {
  challengeId: OpaqueIdentifierSchema,
  signature: P256RawSignatureSchema,
}

export const RelayHostBootstrapProofSchema = z.strictObject({
  ...proofPrefix,
  role: z.literal('host'),
  authMode: z.literal('bootstrap'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  hostSigningFingerprint: Hash32Schema,
  ...proofSuffix,
}).superRefine(refineHostIdentity)

export const RelayHostChallengeProofSchema = z.strictObject({
  ...proofPrefix,
  role: z.literal('host'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  ...proofSuffix,
}).superRefine(refineHostIdentity)

export const RelayClientChallengeProofSchema = z.strictObject({
  ...proofPrefix,
  role: z.literal('client'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  ...proofSuffix,
}).superRefine(refineClientIdentity)

export const RelayDeviceProofSchema = z.union([
  RelayHostBootstrapProofSchema,
  RelayHostChallengeProofSchema,
  RelayClientChallengeProofSchema,
])

export type RelayHostBootstrapProof = z.infer<typeof RelayHostBootstrapProofSchema>
export type RelayHostChallengeProof = z.infer<typeof RelayHostChallengeProofSchema>
export type RelayClientChallengeProof = z.infer<typeof RelayClientChallengeProofSchema>
export type RelayDeviceProof = z.infer<typeof RelayDeviceProofSchema>

const welcomePrefix = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('device.welcome'),
  relayOrigin: RelayOriginSchema,
}

const welcomeSuffix = {
  heartbeatIntervalMs: PositiveSafeIntegerSchema.max(60_000),
  maxFrameBytes: PositiveSafeIntegerSchema.max(MAX_FRAME_BYTES),
}

export const RelayHostBootstrapWelcomeSchema = z.strictObject({
  ...welcomePrefix,
  role: z.literal('host'),
  authMode: z.literal('bootstrap'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  hostSigningFingerprint: Hash32Schema,
  ...welcomeSuffix,
}).superRefine(refineHostIdentity)

export const RelayHostChallengeWelcomeSchema = z.strictObject({
  ...welcomePrefix,
  role: z.literal('host'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  ...welcomeSuffix,
}).superRefine(refineHostIdentity)

export const RelayClientChallengeWelcomeSchema = z.strictObject({
  ...welcomePrefix,
  role: z.literal('client'),
  authMode: z.literal('challenge'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  ...welcomeSuffix,
}).superRefine(refineClientIdentity)

export const RelayDeviceWelcomeSchema = z.union([
  RelayHostBootstrapWelcomeSchema,
  RelayHostChallengeWelcomeSchema,
  RelayClientChallengeWelcomeSchema,
])

export type RelayHostBootstrapWelcome = z.infer<typeof RelayHostBootstrapWelcomeSchema>
export type RelayHostChallengeWelcome = z.infer<typeof RelayHostChallengeWelcomeSchema>
export type RelayClientChallengeWelcome = z.infer<typeof RelayClientChallengeWelcomeSchema>
export type RelayDeviceWelcome = z.infer<typeof RelayDeviceWelcomeSchema>

const authorizationPutPrefix = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('authorization.put'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  clientDeviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  hostAuthorizationRevision: PositiveSafeIntegerSchema,
}

function refineAuthorizationRoute(
  value: { hostDeviceId: string; clientDeviceId: string },
  context: z.RefinementCtx,
): void {
  if (value.hostDeviceId === value.clientDeviceId) {
    context.addIssue({
      code: 'custom',
      path: ['clientDeviceId'],
      message: 'An authorization cannot bind the Host device as a Client.',
    })
  }
}

export const RelayActiveAuthorizationPutSchema = z.strictObject({
  ...authorizationPutPrefix,
  status: z.literal('active'),
  clientSigningKey: P256PublicJwkSchema,
  clientSigningFingerprint: Hash32Schema,
}).superRefine(refineAuthorizationRoute)

export const RelayRevokedAuthorizationPutSchema = z.strictObject({
  ...authorizationPutPrefix,
  status: z.literal('revoked'),
}).superRefine(refineAuthorizationRoute)

export const RelayAuthorizationPutSchema = z.union([
  RelayActiveAuthorizationPutSchema,
  RelayRevokedAuthorizationPutSchema,
])

export type RelayActiveAuthorizationPut = z.infer<typeof RelayActiveAuthorizationPutSchema>
export type RelayRevokedAuthorizationPut = z.infer<typeof RelayRevokedAuthorizationPutSchema>
export type RelayAuthorizationPut = z.infer<typeof RelayAuthorizationPutSchema>

const authorizationAppliedPrefix = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('authorization.applied'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  clientDeviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  hostAuthorizationRevision: PositiveSafeIntegerSchema,
}

export const RelayAuthorizationAppliedSchema = z.union([
  z.strictObject({ ...authorizationAppliedPrefix, status: z.literal('active') })
    .superRefine(refineAuthorizationRoute),
  z.strictObject({ ...authorizationAppliedPrefix, status: z.literal('revoked') })
    .superRefine(refineAuthorizationRoute),
])

export type RelayAuthorizationApplied = z.infer<typeof RelayAuthorizationAppliedSchema>

const pairOpenIdentityShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  expiresAt: SafeIntegerSchema,
}

export const RelayPairOpenSchema = z.strictObject({
  protocolVersion: pairOpenIdentityShape.protocolVersion,
  relayType: z.literal('pair.open'),
  hostId: pairOpenIdentityShape.hostId,
  hostDeviceId: pairOpenIdentityShape.hostDeviceId,
  pairSessionId: pairOpenIdentityShape.pairSessionId,
  expiresAt: pairOpenIdentityShape.expiresAt,
})

export const RelayPairOpenedSchema = z.strictObject({
  protocolVersion: pairOpenIdentityShape.protocolVersion,
  relayType: z.literal('pair.opened'),
  hostId: pairOpenIdentityShape.hostId,
  hostDeviceId: pairOpenIdentityShape.hostDeviceId,
  pairSessionId: pairOpenIdentityShape.pairSessionId,
  expiresAt: pairOpenIdentityShape.expiresAt,
})

export type RelayPairOpen = z.infer<typeof RelayPairOpenSchema>
export type RelayPairOpened = z.infer<typeof RelayPairOpenedSchema>

export const RelayPairCodeRegisterSchema = z.strictObject({
  ...pairOpenIdentityShape,
  relayType: z.literal('pair.code.register'),
  invitationFragment: z.string().min(1).max(12 * 1024),
})
export const RelayPairCodeRegisteredSchema = z.strictObject({
  ...pairOpenIdentityShape,
  relayType: z.literal('pair.code.registered'),
  code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/u),
})
export type RelayPairCodeRegister = z.infer<typeof RelayPairCodeRegisterSchema>
export type RelayPairCodeRegistered = z.infer<typeof RelayPairCodeRegisteredSchema>
export function encodeRelayPairCodeRegister(value: unknown): string { return encodeControl(RelayPairCodeRegisterSchema, value) }
export function decodeRelayPairCodeRegister(frame: string | Uint8Array): RelayPairCodeRegister { return decodeControl(RelayPairCodeRegisterSchema, frame) }
export function encodeRelayPairCodeRegistered(value: unknown): string { return encodeControl(RelayPairCodeRegisteredSchema, value) }
export function decodeRelayPairCodeRegistered(frame: string | Uint8Array): RelayPairCodeRegistered { return decodeControl(RelayPairCodeRegisteredSchema, frame) }

const pairClaimIdentityShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  joinId: OpaqueIdentifierSchema,
}

export const RelayPairClaimSchema = z.strictObject({
  protocolVersion: pairClaimIdentityShape.protocolVersion,
  relayType: z.literal('pair.claim'),
  hostId: pairClaimIdentityShape.hostId,
  hostDeviceId: pairClaimIdentityShape.hostDeviceId,
  pairSessionId: pairClaimIdentityShape.pairSessionId,
  joinId: pairClaimIdentityShape.joinId,
})

export const RelayPairClaimedSchema = z.strictObject({
  protocolVersion: pairClaimIdentityShape.protocolVersion,
  relayType: z.literal('pair.claimed'),
  hostId: pairClaimIdentityShape.hostId,
  hostDeviceId: pairClaimIdentityShape.hostDeviceId,
  pairSessionId: pairClaimIdentityShape.pairSessionId,
  joinId: pairClaimIdentityShape.joinId,
})

export type RelayPairClaim = z.infer<typeof RelayPairClaimSchema>
export type RelayPairClaimed = z.infer<typeof RelayPairClaimedSchema>

export const RelayPairCloseReasonSchema = z.enum([
  'approved',
  'denied',
  'expired',
  'attempt-limit',
  'cancelled',
])

export type RelayPairCloseReason = z.infer<typeof RelayPairCloseReasonSchema>

export const RelayPairCloseSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('pair.close'),
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  pairSessionId: OpaqueIdentifierSchema,
  reason: RelayPairCloseReasonSchema,
})

export type RelayPairClose = z.infer<typeof RelayPairCloseSchema>

export const RelayPingSchema = z.strictObject({ protocolVersion: z.literal(PROTOCOL_VERSION), relayType: z.literal('device.ping'), nonce: OpaqueIdentifierSchema })
export const RelayPongSchema = z.strictObject({ protocolVersion: z.literal(PROTOCOL_VERSION), relayType: z.literal('device.pong'), nonce: OpaqueIdentifierSchema })
export function encodeRelayPing(value: unknown): string { return encodeControl(RelayPingSchema, value) }
export function decodeRelayPing(frame: string | Uint8Array) { return decodeControl(RelayPingSchema, frame) }
export function encodeRelayPong(value: unknown): string { return encodeControl(RelayPongSchema, value) }
export function decodeRelayPong(frame: string | Uint8Array) { return decodeControl(RelayPongSchema, frame) }

export const RelayR3ControlSchema = z.union([
  RelayPingSchema,
  RelayPongSchema,
  RelayDeviceHelloSchema,
  RelayDeviceChallengeSchema,
  RelayDeviceProofSchema,
  RelayDeviceWelcomeSchema,
  RelayAuthorizationPutSchema,
  RelayAuthorizationAppliedSchema,
  RelayPairOpenSchema,
  RelayPairOpenedSchema,
  RelayPairCodeRegisterSchema,
  RelayPairCodeRegisteredSchema,
  RelayPairClaimSchema,
  RelayPairClaimedSchema,
  RelayPairCloseSchema,
])

export type RelayR3Control = z.infer<typeof RelayR3ControlSchema>

function encodeControl<T>(schema: z.ZodType<T>, value: unknown): string {
  return encodeCanonicalJson(schema, value, MAX_RELAY_R3_CONTROL_BYTES)
}

function decodeControl<T>(schema: z.ZodType<T>, frame: string | Uint8Array): T {
  return decodeCanonicalJson(schema, frame, MAX_RELAY_R3_CONTROL_BYTES)
}

function expectedRelayOrigin(value: unknown): string {
  const result = RelayOriginSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  return result.data
}

function assertExpectedRelayOrigin(
  value: { relayOrigin: string },
  expected: string,
): void {
  if (value.relayOrigin !== expectedRelayOrigin(expected)) {
    throw new ProtocolViolation('route-mismatch')
  }
}

function assertSafeNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ProtocolViolation('schema-invalid')
  }
}

export function validateRelayDeviceChallengeTime(
  challenge: RelayDeviceChallenge,
  now = Date.now(),
): void {
  assertSafeNow(now)
  if (
    !Number.isSafeInteger(challenge.issuedAt)
    || challenge.issuedAt < 0
    || !Number.isSafeInteger(challenge.expiresAt)
    || challenge.expiresAt < 0
  ) {
    throw new ProtocolViolation('schema-invalid')
  }
  if (
    challenge.expiresAt <= challenge.issuedAt
    || challenge.expiresAt - challenge.issuedAt > MAX_RELAY_CHALLENGE_TTL_MS
  ) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  if (challenge.issuedAt > now + MAX_CLOCK_SKEW_MS) {
    throw new ProtocolViolation('future-sent-at')
  }
  if (challenge.expiresAt <= now) throw new ProtocolViolation('expired')
}

export function validateRelayPairOpenTime(
  value: RelayPairOpen | RelayPairOpened,
  now = Date.now(),
): void {
  assertSafeNow(now)
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 0) {
    throw new ProtocolViolation('schema-invalid')
  }
  if (value.expiresAt <= now) {
    throw new ProtocolViolation('pair-session-unavailable')
  }
  if (value.expiresAt - now > MAX_RELAY_PAIR_OPEN_TTL_MS) {
    throw new ProtocolViolation('ttl-exceeded')
  }
}

export function encodeRelayDeviceHello(value: unknown): string {
  return encodeControl(RelayDeviceHelloSchema, value)
}

export function decodeRelayDeviceHello(
  frame: string | Uint8Array,
  expectedOrigin: string,
): RelayDeviceHello {
  const value = decodeControl(RelayDeviceHelloSchema, frame)
  assertExpectedRelayOrigin(value, expectedOrigin)
  return value
}

export function encodeRelayDeviceChallenge(value: unknown): string {
  return encodeControl(RelayDeviceChallengeSchema, value)
}

export function decodeRelayDeviceChallenge(
  frame: string | Uint8Array,
  expectedOrigin: string,
  now = Date.now(),
): RelayDeviceChallenge {
  const value = decodeControl(RelayDeviceChallengeSchema, frame)
  assertExpectedRelayOrigin(value, expectedOrigin)
  validateRelayDeviceChallengeTime(value, now)
  return value
}

export function encodeRelayDeviceProof(value: unknown): string {
  return encodeControl(RelayDeviceProofSchema, value)
}

export function decodeRelayDeviceProof(
  frame: string | Uint8Array,
  expectedOrigin: string,
): RelayDeviceProof {
  const value = decodeControl(RelayDeviceProofSchema, frame)
  assertExpectedRelayOrigin(value, expectedOrigin)
  return value
}

export function encodeRelayDeviceWelcome(value: unknown): string {
  return encodeControl(RelayDeviceWelcomeSchema, value)
}

export function decodeRelayDeviceWelcome(
  frame: string | Uint8Array,
  expectedOrigin: string,
): RelayDeviceWelcome {
  const value = decodeControl(RelayDeviceWelcomeSchema, frame)
  assertExpectedRelayOrigin(value, expectedOrigin)
  return value
}

export function encodeRelayDeviceProofSignatureInput(value: unknown): Uint8Array {
  const result = RelayDeviceChallengeSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const challenge = result.data
  const authorizationId = challenge.role === 'client' ? challenge.authorizationId : null
  const authorizationEpoch = challenge.role === 'client' ? challenge.authorizationEpoch : null
  const hostSigningFingerprint = challenge.authMode === 'bootstrap'
    ? challenge.hostSigningFingerprint
    : null
  return relayR3Encoder.encode(JSON.stringify([
    'codex-plus-relay-device-proof-v1',
    challenge.protocolVersion,
    challenge.relayOrigin,
    challenge.role,
    challenge.authMode,
    challenge.hostId,
    challenge.hostDeviceId,
    challenge.deviceId,
    authorizationId,
    authorizationEpoch,
    hostSigningFingerprint,
    challenge.challengeId,
    challenge.challenge,
    challenge.issuedAt,
    challenge.expiresAt,
  ]))
}

export const encodeRelayDeviceProofInput = encodeRelayDeviceProofSignatureInput

export function encodeRelayAuthorizationPut(value: unknown): string {
  return encodeControl(RelayAuthorizationPutSchema, value)
}

export function decodeRelayAuthorizationPut(frame: string | Uint8Array): RelayAuthorizationPut {
  return decodeControl(RelayAuthorizationPutSchema, frame)
}

export function encodeRelayAuthorizationApplied(value: unknown): string {
  return encodeControl(RelayAuthorizationAppliedSchema, value)
}

export function decodeRelayAuthorizationApplied(
  frame: string | Uint8Array,
): RelayAuthorizationApplied {
  return decodeControl(RelayAuthorizationAppliedSchema, frame)
}

export function encodeRelayPairOpen(value: unknown): string {
  return encodeControl(RelayPairOpenSchema, value)
}

export function decodeRelayPairOpen(
  frame: string | Uint8Array,
  now = Date.now(),
): RelayPairOpen {
  const value = decodeControl(RelayPairOpenSchema, frame)
  validateRelayPairOpenTime(value, now)
  return value
}

export function encodeRelayPairOpened(value: unknown): string {
  return encodeControl(RelayPairOpenedSchema, value)
}

export function decodeRelayPairOpened(
  frame: string | Uint8Array,
  now = Date.now(),
): RelayPairOpened {
  const value = decodeControl(RelayPairOpenedSchema, frame)
  validateRelayPairOpenTime(value, now)
  return value
}

export function encodeRelayPairClaim(value: unknown): string {
  return encodeControl(RelayPairClaimSchema, value)
}

export function decodeRelayPairClaim(frame: string | Uint8Array): RelayPairClaim {
  return decodeControl(RelayPairClaimSchema, frame)
}

export function encodeRelayPairClaimed(value: unknown): string {
  return encodeControl(RelayPairClaimedSchema, value)
}

export function decodeRelayPairClaimed(frame: string | Uint8Array): RelayPairClaimed {
  return decodeControl(RelayPairClaimedSchema, frame)
}

export function encodeRelayPairClose(value: unknown): string {
  return encodeControl(RelayPairCloseSchema, value)
}

export function decodeRelayPairClose(frame: string | Uint8Array): RelayPairClose {
  return decodeControl(RelayPairCloseSchema, frame)
}

export function encodeRelayR3Control(value: unknown): string {
  return encodeControl(RelayR3ControlSchema, value)
}

export function decodeRelayR3Control(frame: string | Uint8Array): RelayR3Control {
  return decodeControl(RelayR3ControlSchema, frame)
}
