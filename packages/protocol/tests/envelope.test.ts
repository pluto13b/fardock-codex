import { describe, expect, it } from 'vitest'

import {
  decodeEnvelope,
  decodeRelayReceipt,
  encodeEnvelope,
  encodeEnvelopeAad,
  encodeRelayReceipt,
  MAX_CIPHERTEXT_CHARACTERS,
  MAX_FRAME_BYTES,
  ProtocolViolation,
} from '../src/index.ts'
import { envelope, fixedNow } from './helpers.ts'

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

describe('RoutedEnvelope codec', () => {
  it('round-trips only canonical JSON', () => {
    const value = envelope()
    const encoded = encodeEnvelope(value)
    expect(encoded).toBe(JSON.stringify(value))
    expect(decodeEnvelope(encoded, { now: fixedNow })).toEqual(value)

    expectCode(() => decodeEnvelope(` ${encoded}`, { now: fixedNow }), 'schema-invalid')
    expectCode(() => decodeEnvelope(encoded.replace('{', '{"extra":true,'), { now: fixedNow }), 'schema-invalid')
    expectCode(
      () => decodeEnvelope(encoded.replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1'), { now: fixedNow }),
      'schema-invalid',
    )
  })

  it('rejects invalid UTF-8, a BOM, explicit optional nulls, and padded base64url', () => {
    expectCode(() => decodeEnvelope(new Uint8Array([0xff]), { now: fixedNow }), 'invalid-json')
    expectCode(() => decodeEnvelope(`\uFEFF${encodeEnvelope(envelope())}`, { now: fixedNow }), 'invalid-json')
    const encoded = new TextEncoder().encode(encodeEnvelope(envelope()))
    const bomBytes = new Uint8Array(encoded.byteLength + 3)
    bomBytes.set([0xef, 0xbb, 0xbf])
    bomBytes.set(encoded, 3)
    expectCode(() => decodeEnvelope(bomBytes, { now: fixedNow }), 'invalid-json')
    expectCode(
      () => decodeEnvelope(encodeEnvelope(envelope()).replace('"seq":1', '"taskId":null,"seq":1'), { now: fixedNow }),
      'schema-invalid',
    )
    expectCode(() => encodeEnvelope(envelope({ ciphertext: 'AA==' })), 'schema-invalid')
  })

  it('returns stable version and message-type errors', () => {
    const encoded = encodeEnvelope(envelope())
    expectCode(() => decodeEnvelope(encoded.replace('"protocolVersion":1', '"protocolVersion":2'), { now: fixedNow }), 'unsupported-version')
    expectCode(() => decodeEnvelope(encoded.replace('"messageType":"request"', '"messageType":"rpc"'), { now: fixedNow }), 'unknown-message-type')
  })

  it('rejects invalid identifiers and size limits', () => {
    expectCode(() => encodeEnvelope(envelope({ hostId: 'D:\\secret' })), 'schema-invalid')
    expectCode(() => decodeEnvelope('x'.repeat(MAX_FRAME_BYTES + 1), { now: fixedNow }), 'frame-too-large')
    expectCode(
      () => encodeEnvelope({ ...envelope(), ciphertext: 'A'.repeat(MAX_CIPHERTEXT_CHARACTERS + 1) }),
      'payload-too-large',
    )
  })

  it('rejects expired, future, and excessive-lifetime frames', () => {
    expectCode(
      () => decodeEnvelope(encodeEnvelope(envelope()), { now: Number.NaN }),
      'schema-invalid',
    )
    expectCode(
      () => decodeEnvelope(encodeEnvelope(envelope()), { now: -1 }),
      'schema-invalid',
    )
    expectCode(
      () => decodeEnvelope(encodeEnvelope(envelope({ sentAt: fixedNow - 10_000, expiresAt: fixedNow })), { now: fixedNow }),
      'expired',
    )
    expectCode(
      () => decodeEnvelope(encodeEnvelope(envelope({ sentAt: fixedNow + 30_001, expiresAt: fixedNow + 60_000 })), { now: fixedNow }),
      'future-sent-at',
    )
    expectCode(
      () => decodeEnvelope(encodeEnvelope(envelope({ sentAt: fixedNow, expiresAt: fixedNow + 120_001 })), { now: fixedNow }),
      'ttl-exceeded',
    )
  })

  it('has a fixed AAD byte vector and binds absent task as null', () => {
    const value = envelope()
    const expected = '["codex-plus-envelope-aad-v1",1,7,"device-phone","device-host","host-main","key-7","request-1","task-1",1,0,1799999999000,1800000060000,"request"]'
    expect(Array.from(encodeEnvelopeAad(value))).toEqual(Array.from(new TextEncoder().encode(expected)))

    const withoutTask = { ...value, taskId: undefined }
    expect(new TextDecoder().decode(encodeEnvelopeAad(withoutTask))).toContain(',null,1,0,')
  })

  it('requires task authority for event and snapshot carriers', () => {
    const event = envelope({ messageType: 'event', taskId: undefined })
    expectCode(() => encodeEnvelope(event), 'schema-invalid')
  })

  it('keeps a Relay receipt non-authoritative and strictly shaped', () => {
    const receipt = {
      protocolVersion: 1 as const,
      relayType: 'receipt' as const,
      connectionGeneration: 7,
      requestId: 'request-1',
      seq: 1,
      state: 'relayed' as const,
    }
    expect(decodeRelayReceipt(encodeRelayReceipt(receipt))).toEqual(receipt)
    expect(JSON.stringify(receipt)).not.toContain('accepted')
    expectCode(() => encodeRelayReceipt({ ...receipt, code: 'host-unavailable' }), 'schema-invalid')
    expectCode(
      () => encodeRelayReceipt({ ...receipt, state: 'unavailable', code: 'backpressure' }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayReceipt({ ...receipt, state: 'rejected', code: 'host-unavailable' }),
      'schema-invalid',
    )
  })
})
