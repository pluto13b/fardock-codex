import type * as z from 'zod'

import { ProtocolViolation } from './errors.ts'
import {
  EnvelopeMessageTypeSchema,
  MAX_CLOCK_SKEW_MS,
  MAX_CIPHERTEXT_CHARACTERS,
  MAX_ENVELOPE_TTL_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  RelayReceiptSchema,
  RoutedEnvelopeSchema,
  type EnvelopeHeader,
  type RoutedEnvelope,
  type RelayReceipt,
} from './schemas.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function canonicalEnvelope(envelope: RoutedEnvelope): RoutedEnvelope {
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
    ciphertext: envelope.ciphertext,
  }
}

function frameText(frame: string | Uint8Array, maximumBytes: number): string {
  if (typeof frame === 'string') {
    if (encoder.encode(frame).byteLength > maximumBytes) throw new ProtocolViolation('frame-too-large')
    return frame
  }
  if (frame.byteLength > maximumBytes) throw new ProtocolViolation('frame-too-large')
  try {
    return decoder.decode(frame)
  } catch {
    throw new ProtocolViolation('invalid-json')
  }
}

export function encodeCanonicalJson<T>(schema: z.ZodType<T>, value: unknown, maximumBytes: number): string {
  const result = schema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const json = JSON.stringify(result.data)
  if (encoder.encode(json).byteLength > maximumBytes) throw new ProtocolViolation('frame-too-large')
  return json
}

export function decodeCanonicalJson<T>(
  schema: z.ZodType<T>,
  frame: string | Uint8Array,
  maximumBytes: number,
): T {
  const text = frameText(frame, maximumBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new ProtocolViolation('invalid-json')
  }
  const result = schema.safeParse(parsed)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  if (JSON.stringify(result.data) !== text) throw new ProtocolViolation('schema-invalid')
  return result.data
}

export function validateEnvelopeTime(envelope: EnvelopeHeader, now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new ProtocolViolation('schema-invalid')
  if (envelope.expiresAt <= envelope.sentAt || envelope.expiresAt - envelope.sentAt > MAX_ENVELOPE_TTL_MS) {
    throw new ProtocolViolation('ttl-exceeded')
  }
  if (envelope.sentAt > now + MAX_CLOCK_SKEW_MS) throw new ProtocolViolation('future-sent-at')
  if (envelope.expiresAt <= now) throw new ProtocolViolation('expired')
}

export function encodeEnvelope(value: unknown): string {
  if (
    typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).ciphertext === 'string'
    && ((value as Record<string, unknown>).ciphertext as string).length > MAX_CIPHERTEXT_CHARACTERS
  ) {
    throw new ProtocolViolation('payload-too-large')
  }
  const result = RoutedEnvelopeSchema.safeParse(value)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const json = JSON.stringify(canonicalEnvelope(result.data))
  if (encoder.encode(json).byteLength > MAX_FRAME_BYTES) throw new ProtocolViolation('frame-too-large')
  return json
}

export interface DecodeEnvelopeOptions {
  now?: number
  validateTime?: boolean
}

export function decodeEnvelope(frame: string | Uint8Array, options: DecodeEnvelopeOptions = {}): RoutedEnvelope {
  const text = frameText(frame, MAX_FRAME_BYTES)
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new ProtocolViolation('invalid-json')
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const candidate = parsed as Record<string, unknown>
    if ('protocolVersion' in candidate && candidate.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolViolation('unsupported-version')
    }
    if ('messageType' in candidate && !EnvelopeMessageTypeSchema.safeParse(candidate.messageType).success) {
      throw new ProtocolViolation('unknown-message-type')
    }
    if (typeof candidate.ciphertext === 'string' && candidate.ciphertext.length > MAX_CIPHERTEXT_CHARACTERS) {
      throw new ProtocolViolation('payload-too-large')
    }
  }

  const result = RoutedEnvelopeSchema.safeParse(parsed)
  if (!result.success) throw new ProtocolViolation('schema-invalid')
  const canonical = JSON.stringify(canonicalEnvelope(result.data))
  if (canonical !== text) throw new ProtocolViolation('schema-invalid')
  if (options.validateTime !== false) validateEnvelopeTime(result.data, options.now)
  return result.data
}

export function encodeEnvelopeAad(header: EnvelopeHeader): Uint8Array {
  const aad = JSON.stringify([
    'codex-plus-envelope-aad-v1',
    header.protocolVersion,
    header.connectionGeneration,
    header.fromDeviceId,
    header.toDeviceId,
    header.hostId,
    header.keyId,
    header.requestId,
    header.taskId ?? null,
    header.seq,
    header.ack,
    header.sentAt,
    header.expiresAt,
    header.messageType,
  ])
  return encoder.encode(aad)
}

export function encodeRelayReceipt(value: unknown): string {
  return encodeCanonicalJson(RelayReceiptSchema, value, 2048)
}

export function decodeRelayReceipt(frame: string | Uint8Array): RelayReceipt {
  return decodeCanonicalJson(RelayReceiptSchema, frame, 2048)
}
