import * as z from 'zod'

import { decodedBase64UrlLength, isBase64Url } from './base64url.ts'

export const PROTOCOL_VERSION = 1 as const
export const MAX_FRAME_BYTES = 768 * 1024
export const MAX_CIPHERTEXT_BYTES = 512 * 1024
export const MAX_CIPHERTEXT_CHARACTERS = 699_051
export const AES_GCM_TAG_BYTES = 16
export const MAX_APPLICATION_BYTES = MAX_CIPHERTEXT_BYTES - AES_GCM_TAG_BYTES
export const MAX_ENVELOPE_TTL_MS = 120_000
export const MAX_CLOCK_SKEW_MS = 30_000

export const OpaqueIdentifierSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/)

export const CursorSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[\x20-\x7e]+$/)

export const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const PositiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)

export const Base64UrlSchema = z.string().min(1).refine(isBase64Url)

export const EnvelopeMessageTypeSchema = z.enum([
  'request',
  'response',
  'event',
  'snapshot',
  'control',
])

export type EnvelopeMessageType = z.infer<typeof EnvelopeMessageTypeSchema>

export const RoutedEnvelopeSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  connectionGeneration: PositiveSafeIntegerSchema,
  fromDeviceId: OpaqueIdentifierSchema,
  toDeviceId: OpaqueIdentifierSchema,
  hostId: OpaqueIdentifierSchema,
  keyId: OpaqueIdentifierSchema,
  requestId: OpaqueIdentifierSchema,
  taskId: OpaqueIdentifierSchema.optional(),
  seq: PositiveSafeIntegerSchema,
  ack: SafeIntegerSchema,
  sentAt: SafeIntegerSchema,
  expiresAt: SafeIntegerSchema,
  messageType: EnvelopeMessageTypeSchema,
  ciphertext: Base64UrlSchema.max(MAX_CIPHERTEXT_CHARACTERS),
}).superRefine((envelope, context) => {
  const ciphertextBytes = decodedBase64UrlLength(envelope.ciphertext)
  if (ciphertextBytes === undefined || ciphertextBytes > MAX_CIPHERTEXT_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['ciphertext'],
      message: 'Ciphertext exceeds its decoded byte limit.',
    })
  }
  if ((envelope.messageType === 'event' || envelope.messageType === 'snapshot') && envelope.taskId === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['taskId'],
      message: 'Task events and snapshots require task authority.',
    })
  }
})

export type RoutedEnvelope = z.infer<typeof RoutedEnvelopeSchema>

const RelayReceiptCommonSchema = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  relayType: z.literal('receipt'),
  connectionGeneration: PositiveSafeIntegerSchema,
  requestId: OpaqueIdentifierSchema,
  seq: PositiveSafeIntegerSchema,
}

export const RelayReceiptSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...RelayReceiptCommonSchema, state: z.literal('relayed') }),
  z.strictObject({
    ...RelayReceiptCommonSchema,
    state: z.literal('unavailable'),
    code: z.literal('host-unavailable'),
  }),
  z.strictObject({
    ...RelayReceiptCommonSchema,
    state: z.literal('rejected'),
    code: z.enum(['rate-limited', 'backpressure']),
  }),
])

export type RelayReceipt = z.infer<typeof RelayReceiptSchema>

export interface EnvelopeHeader {
  protocolVersion: typeof PROTOCOL_VERSION
  connectionGeneration: number
  fromDeviceId: string
  toDeviceId: string
  hostId: string
  keyId: string
  requestId: string
  taskId?: string
  seq: number
  ack: number
  sentAt: number
  expiresAt: number
  messageType: EnvelopeMessageType
}

export function envelopeHeader(envelope: RoutedEnvelope): EnvelopeHeader {
  return {
    protocolVersion: envelope.protocolVersion,
    connectionGeneration: envelope.connectionGeneration,
    fromDeviceId: envelope.fromDeviceId,
    toDeviceId: envelope.toDeviceId,
    hostId: envelope.hostId,
    keyId: envelope.keyId,
    requestId: envelope.requestId,
    ...(envelope.taskId === undefined ? {} : { taskId: envelope.taskId }),
    seq: envelope.seq,
    ack: envelope.ack,
    sentAt: envelope.sentAt,
    expiresAt: envelope.expiresAt,
    messageType: envelope.messageType,
  }
}
