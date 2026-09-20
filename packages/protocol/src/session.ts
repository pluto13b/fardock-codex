import * as z from 'zod'

import { decodeCanonicalJson, encodeCanonicalJson } from './codec.ts'
import { ProtocolViolation } from './errors.ts'
import {
  Hash32Schema,
  MAX_PAIRING_TTL_MS,
  P256PublicJwkSchema,
  P256RawSignatureSchema,
  RelayOriginSchema,
  Secret32Schema,
  canonicalP256JwkTuple,
} from './pairing.ts'
import {
  MAX_CLOCK_SKEW_MS,
  OpaqueIdentifierSchema,
  PositiveSafeIntegerSchema,
  PROTOCOL_VERSION,
  SafeIntegerSchema,
} from './schemas.ts'

const sessionEncoder = new TextEncoder()

export const MAX_SESSION_HANDSHAKE_BYTES = 8 * 1024
export const MAX_SESSION_HANDSHAKE_TTL_MS = MAX_PAIRING_TTL_MS

const sessionInitUnsignedShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('session.init'),
  relayOrigin: RelayOriginSchema,
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  clientDeviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  handshakeId: OpaqueIdentifierSchema,
  clientNonce: Secret32Schema,
  clientEphemeralAgreementKey: P256PublicJwkSchema,
  issuedAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
}

function refineHandshakeLifetime(
  value: { issuedAt: number; expiresAt: number },
  context: z.RefinementCtx,
): void {
  if (
    value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > MAX_SESSION_HANDSHAKE_TTL_MS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Session handshake lifetime exceeds 30 seconds.',
    })
  }
}

export const UnsignedSessionInitSchema = z.strictObject(sessionInitUnsignedShape)
  .superRefine(refineHandshakeLifetime)

export const SessionInitSchema = z.strictObject({
  ...sessionInitUnsignedShape,
  clientSignature: P256RawSignatureSchema,
}).superRefine(refineHandshakeLifetime)

export type UnsignedSessionInit = z.infer<typeof UnsignedSessionInitSchema>
export type SessionInit = z.infer<typeof SessionInitSchema>

const sessionAcceptUnsignedShape = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('session.accept'),
  relayOrigin: RelayOriginSchema,
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  clientDeviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  handshakeId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  clientToHostKeyId: OpaqueIdentifierSchema,
  hostToClientKeyId: OpaqueIdentifierSchema,
  sessionInitHash: Hash32Schema,
  hostNonce: Secret32Schema,
  hostEphemeralAgreementKey: P256PublicJwkSchema,
  issuedAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
}

type SessionAcceptRefinementValue = {
  issuedAt: number
  expiresAt: number
  clientToHostKeyId: string
  hostToClientKeyId: string
}

function refineSessionAccept(value: SessionAcceptRefinementValue, context: z.RefinementCtx): void {
  refineHandshakeLifetime(value, context)
  if (value.clientToHostKeyId === value.hostToClientKeyId) {
    context.addIssue({
      code: 'custom',
      path: ['hostToClientKeyId'],
      message: 'Directional session key identifiers must be distinct.',
    })
  }
}

export const UnsignedSessionAcceptSchema = z.strictObject(sessionAcceptUnsignedShape)
  .superRefine(refineSessionAccept)

export const SessionAcceptSchema = z.strictObject({
  ...sessionAcceptUnsignedShape,
  hostSignature: P256RawSignatureSchema,
}).superRefine(refineSessionAccept)

export type UnsignedSessionAccept = z.infer<typeof UnsignedSessionAcceptSchema>
export type SessionAccept = z.infer<typeof SessionAcceptSchema>

function parseUnsignedSessionInit(value: unknown): UnsignedSessionInit {
  const unsignedResult = UnsignedSessionInitSchema.safeParse(value)
  if (unsignedResult.success) return unsignedResult.data
  const signedResult = SessionInitSchema.safeParse(value)
  if (!signedResult.success) throw new ProtocolViolation('schema-invalid')
  const init = signedResult.data
  return {
    protocolVersion: init.protocolVersion,
    relayType: init.relayType,
    relayOrigin: init.relayOrigin,
    hostId: init.hostId,
    hostDeviceId: init.hostDeviceId,
    clientDeviceId: init.clientDeviceId,
    authorizationId: init.authorizationId,
    authorizationEpoch: init.authorizationEpoch,
    handshakeId: init.handshakeId,
    clientNonce: init.clientNonce,
    clientEphemeralAgreementKey: init.clientEphemeralAgreementKey,
    issuedAt: init.issuedAt,
    expiresAt: init.expiresAt,
  }
}

function parseUnsignedSessionAccept(value: unknown): UnsignedSessionAccept {
  const unsignedResult = UnsignedSessionAcceptSchema.safeParse(value)
  if (unsignedResult.success) return unsignedResult.data
  const signedResult = SessionAcceptSchema.safeParse(value)
  if (!signedResult.success) throw new ProtocolViolation('schema-invalid')
  const accept = signedResult.data
  return {
    protocolVersion: accept.protocolVersion,
    relayType: accept.relayType,
    relayOrigin: accept.relayOrigin,
    hostId: accept.hostId,
    hostDeviceId: accept.hostDeviceId,
    clientDeviceId: accept.clientDeviceId,
    authorizationId: accept.authorizationId,
    authorizationEpoch: accept.authorizationEpoch,
    handshakeId: accept.handshakeId,
    connectionGeneration: accept.connectionGeneration,
    clientToHostKeyId: accept.clientToHostKeyId,
    hostToClientKeyId: accept.hostToClientKeyId,
    sessionInitHash: accept.sessionInitHash,
    hostNonce: accept.hostNonce,
    hostEphemeralAgreementKey: accept.hostEphemeralAgreementKey,
    issuedAt: accept.issuedAt,
    expiresAt: accept.expiresAt,
  }
}

export function encodeSessionInitSignatureInput(value: unknown): Uint8Array {
  const init = parseUnsignedSessionInit(value)
  return sessionEncoder.encode(JSON.stringify([
    'codex-plus-session-init-signature-v1',
    init.protocolVersion,
    init.relayType,
    init.relayOrigin,
    init.hostId,
    init.hostDeviceId,
    init.clientDeviceId,
    init.authorizationId,
    init.authorizationEpoch,
    init.handshakeId,
    init.clientNonce,
    canonicalP256JwkTuple(init.clientEphemeralAgreementKey),
    init.issuedAt,
    init.expiresAt,
  ]))
}

const SessionAcceptSignatureContextSchema = z.strictObject({
  sessionAccept: z.unknown(),
  grantClaimsHash: Hash32Schema,
})

export function encodeSessionAcceptSignatureInput(value: unknown): Uint8Array {
  const contextResult = SessionAcceptSignatureContextSchema.safeParse(value)
  if (!contextResult.success) throw new ProtocolViolation('schema-invalid')
  const accept = parseUnsignedSessionAccept(contextResult.data.sessionAccept)
  return sessionEncoder.encode(JSON.stringify([
    'codex-plus-session-accept-signature-v1',
    accept.protocolVersion,
    accept.relayType,
    accept.relayOrigin,
    accept.hostId,
    accept.hostDeviceId,
    accept.clientDeviceId,
    accept.authorizationId,
    accept.authorizationEpoch,
    accept.handshakeId,
    accept.connectionGeneration,
    accept.clientToHostKeyId,
    accept.hostToClientKeyId,
    accept.sessionInitHash,
    accept.hostNonce,
    canonicalP256JwkTuple(accept.hostEphemeralAgreementKey),
    accept.issuedAt,
    accept.expiresAt,
    contextResult.data.grantClaimsHash,
  ]))
}

function validateHandshakeTime(
  value: { issuedAt: number; expiresAt: number },
  now: number,
): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolViolation('schema-invalid')
  if (
    value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > MAX_SESSION_HANDSHAKE_TTL_MS
  ) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  if (value.issuedAt > now + MAX_CLOCK_SKEW_MS) throw new ProtocolViolation('future-sent-at')
  if (value.expiresAt <= now) throw new ProtocolViolation('expired')
}

export interface DecodeSessionHandshakeOptions {
  expectedRelayOrigin: string
  now?: number
  validateTime?: boolean
}

function validateExpectedOrigin(actual: string, expectedValue: unknown): void {
  const expected = RelayOriginSchema.safeParse(expectedValue)
  if (!expected.success) throw new ProtocolViolation('schema-invalid')
  if (actual !== expected.data) throw new ProtocolViolation('route-mismatch')
}

export function encodeSessionInit(value: unknown): string {
  return encodeCanonicalJson(SessionInitSchema, value, MAX_SESSION_HANDSHAKE_BYTES)
}

export const encodeSessionInitFrame = encodeSessionInit

export function decodeSessionInit(
  frame: string | Uint8Array,
  options: DecodeSessionHandshakeOptions,
): SessionInit {
  const init = decodeCanonicalJson(SessionInitSchema, frame, MAX_SESSION_HANDSHAKE_BYTES)
  validateExpectedOrigin(init.relayOrigin, options.expectedRelayOrigin)
  if (options.validateTime !== false) validateHandshakeTime(init, options.now ?? Date.now())
  return init
}

export const decodeSessionInitFrame = decodeSessionInit

export function encodeSessionAccept(value: unknown): string {
  return encodeCanonicalJson(SessionAcceptSchema, value, MAX_SESSION_HANDSHAKE_BYTES)
}

export const encodeSessionAcceptFrame = encodeSessionAccept

export function decodeSessionAccept(
  frame: string | Uint8Array,
  options: DecodeSessionHandshakeOptions,
): SessionAccept {
  const accept = decodeCanonicalJson(SessionAcceptSchema, frame, MAX_SESSION_HANDSHAKE_BYTES)
  validateExpectedOrigin(accept.relayOrigin, options.expectedRelayOrigin)
  if (options.validateTime !== false) validateHandshakeTime(accept, options.now ?? Date.now())
  return accept
}

export const decodeSessionAcceptFrame = decodeSessionAccept

export function encodeSessionInitHashInput(value: unknown): Uint8Array {
  return sessionEncoder.encode(encodeSessionInit(value))
}

function sessionInitTuple(init: SessionInit): readonly unknown[] {
  return [
    init.protocolVersion,
    init.relayType,
    init.relayOrigin,
    init.hostId,
    init.hostDeviceId,
    init.clientDeviceId,
    init.authorizationId,
    init.authorizationEpoch,
    init.handshakeId,
    init.clientNonce,
    canonicalP256JwkTuple(init.clientEphemeralAgreementKey),
    init.issuedAt,
    init.expiresAt,
    init.clientSignature,
  ]
}

function sessionAcceptTuple(accept: SessionAccept): readonly unknown[] {
  return [
    accept.protocolVersion,
    accept.relayType,
    accept.relayOrigin,
    accept.hostId,
    accept.hostDeviceId,
    accept.clientDeviceId,
    accept.authorizationId,
    accept.authorizationEpoch,
    accept.handshakeId,
    accept.connectionGeneration,
    accept.clientToHostKeyId,
    accept.hostToClientKeyId,
    accept.sessionInitHash,
    accept.hostNonce,
    canonicalP256JwkTuple(accept.hostEphemeralAgreementKey),
    accept.issuedAt,
    accept.expiresAt,
    accept.hostSignature,
  ]
}

function sameHandshakeAuthority(init: SessionInit, accept: SessionAccept): boolean {
  return init.protocolVersion === accept.protocolVersion
    && init.relayOrigin === accept.relayOrigin
    && init.hostId === accept.hostId
    && init.hostDeviceId === accept.hostDeviceId
    && init.clientDeviceId === accept.clientDeviceId
    && init.authorizationId === accept.authorizationId
    && init.authorizationEpoch === accept.authorizationEpoch
    && init.handshakeId === accept.handshakeId
}

const SessionTranscriptContextSchema = z.strictObject({
  sessionInit: SessionInitSchema,
  sessionAccept: SessionAcceptSchema,
  grantClaimsHash: Hash32Schema,
})

export type SessionTranscriptContext = z.infer<typeof SessionTranscriptContextSchema>

export function encodeSessionTranscript(value: unknown): Uint8Array {
  const result = SessionTranscriptContextSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const context = result.data
  if (!sameHandshakeAuthority(context.sessionInit, context.sessionAccept)) {
    throw new ProtocolViolation('stale-authority')
  }
  return sessionEncoder.encode(JSON.stringify([
    'codex-plus-session-transcript-v1',
    sessionInitTuple(context.sessionInit),
    sessionAcceptTuple(context.sessionAccept),
    context.grantClaimsHash,
  ]))
}

export const encodeSessionConnectionSaltInput = encodeSessionTranscript

export const SessionDirectionSchema = z.enum(['client-to-host', 'host-to-client'])
export const SessionKdfPurposeSchema = z.enum(['aes-key', 'nonce-prefix', 'attachment-key'])

export type SessionDirection = z.infer<typeof SessionDirectionSchema>
export type SessionKdfPurpose = z.infer<typeof SessionKdfPurposeSchema>

export const SessionKdfContextSchema = z.strictObject({
  sessionTranscriptHash: Hash32Schema,
  hostId: OpaqueIdentifierSchema,
  hostDeviceId: OpaqueIdentifierSchema,
  clientDeviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  direction: SessionDirectionSchema,
  keyId: OpaqueIdentifierSchema,
  purpose: SessionKdfPurposeSchema,
})

export type SessionKdfContext = z.infer<typeof SessionKdfContextSchema>

export function encodeSessionKdfInfo(value: unknown): Uint8Array {
  const result = SessionKdfContextSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const context = result.data
  return sessionEncoder.encode(JSON.stringify([
    'codex-plus-session-kdf-v1',
    context.sessionTranscriptHash,
    context.hostId,
    context.hostDeviceId,
    context.clientDeviceId,
    context.authorizationId,
    context.authorizationEpoch,
    context.connectionGeneration,
    context.direction,
    context.keyId,
    context.purpose,
  ]))
}

export const SessionConfirmControlSchema = z.strictObject({
  kind: z.literal('control'),
  operation: z.literal('session.confirm'),
  sessionTranscriptHash: Hash32Schema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  senderRole: z.literal('client'),
})

export const SessionReadyControlSchema = z.strictObject({
  kind: z.literal('control'),
  operation: z.literal('session.ready'),
  sessionTranscriptHash: Hash32Schema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  senderRole: z.literal('host'),
})

export type SessionConfirmControl = z.infer<typeof SessionConfirmControlSchema>
export type SessionReadyControl = z.infer<typeof SessionReadyControlSchema>
