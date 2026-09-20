import * as z from 'zod'

import { decodeBase64Url } from './base64url.ts'
import { decodeCanonicalJson, encodeCanonicalJson } from './codec.ts'
import {
  MAX_FRAME_BYTES,
  OpaqueIdentifierSchema,
  PositiveSafeIntegerSchema,
  PROTOCOL_VERSION,
} from './schemas.ts'

export const MAX_RELAY_CONTROL_BYTES = 4 * 1024

export const RelayCredentialSchema = z.string()
  .length(43)
  .refine(value => decodeBase64Url(value)?.byteLength === 32)

export const RelayRoleSchema = z.enum(['host', 'client'])
export type RelayRole = z.infer<typeof RelayRoleSchema>

const RelayHelloCommonSchema = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('hello'),
  hostId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  credential: RelayCredentialSchema,
}

export const RelayHelloSchema = z.discriminatedUnion('authMode', [
  z.strictObject({
    ...RelayHelloCommonSchema,
    role: z.literal('host'),
    authMode: z.literal('bootstrap'),
    sessionCredential: RelayCredentialSchema,
  }),
  z.strictObject({
    ...RelayHelloCommonSchema,
    role: RelayRoleSchema,
    authMode: z.literal('resume'),
  }),
])

export type RelayHello = z.infer<typeof RelayHelloSchema>

const RelayWelcomeCommonSchema = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('welcome'),
  hostId: OpaqueIdentifierSchema,
  deviceId: OpaqueIdentifierSchema,
  registrationState: z.literal('closed'),
  heartbeatIntervalMs: PositiveSafeIntegerSchema.max(60_000),
  maxFrameBytes: PositiveSafeIntegerSchema.max(MAX_FRAME_BYTES),
}

export const RelayWelcomeSchema = z.discriminatedUnion('authMode', [
  z.strictObject({
    ...RelayWelcomeCommonSchema,
    role: z.literal('host'),
    authMode: z.literal('bootstrap'),
  }),
  z.strictObject({
    ...RelayWelcomeCommonSchema,
    role: RelayRoleSchema,
    authMode: z.literal('resume'),
  }),
])

export type RelayWelcome = z.infer<typeof RelayWelcomeSchema>

export const RelayNotAuthenticatedSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('error'),
  code: z.literal('not-authenticated'),
})

export type RelayNotAuthenticated = z.infer<typeof RelayNotAuthenticatedSchema>

export function encodeRelayHello(value: unknown): string {
  return encodeCanonicalJson(RelayHelloSchema, value, MAX_RELAY_CONTROL_BYTES)
}

export function decodeRelayHello(frame: string | Uint8Array): RelayHello {
  return decodeCanonicalJson(RelayHelloSchema, frame, MAX_RELAY_CONTROL_BYTES)
}

export function encodeRelayWelcome(value: unknown): string {
  return encodeCanonicalJson(RelayWelcomeSchema, value, MAX_RELAY_CONTROL_BYTES)
}

export function decodeRelayWelcome(frame: string | Uint8Array): RelayWelcome {
  return decodeCanonicalJson(RelayWelcomeSchema, frame, MAX_RELAY_CONTROL_BYTES)
}

export function encodeRelayNotAuthenticated(value: unknown = {
  protocolVersion: PROTOCOL_VERSION,
  relayType: 'error',
  code: 'not-authenticated',
}): string {
  return encodeCanonicalJson(RelayNotAuthenticatedSchema, value, MAX_RELAY_CONTROL_BYTES)
}

export function decodeRelayNotAuthenticated(frame: string | Uint8Array): RelayNotAuthenticated {
  return decodeCanonicalJson(RelayNotAuthenticatedSchema, frame, MAX_RELAY_CONTROL_BYTES)
}
