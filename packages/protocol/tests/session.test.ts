import { describe, expect, it } from 'vitest'

import {
  ProtocolViolation,
  decodeApplicationMessage,
  decodeSessionAccept,
  decodeSessionInit,
  encodeApplicationMessage,
  encodeSessionAccept,
  encodeSessionAcceptSignatureInput,
  encodeSessionConnectionSaltInput,
  encodeSessionInit,
  encodeSessionInitHashInput,
  encodeSessionInitSignatureInput,
  encodeSessionKdfInfo,
  encodeSessionTranscript,
  type SessionAccept,
  type SessionInit,
} from '../src/index.ts'
import {
  base64Bytes,
  fixedNow,
  p256Point3,
  p256Point4,
} from './helpers.ts'

const relayOrigin = 'https://codex.example.test'
const clientNonce = base64Bytes(32, 41)
const hostNonce = base64Bytes(32, 42)
const clientSignature = base64Bytes(64, 43)
const hostSignature = base64Bytes(64, 44)
const sessionInitHash = base64Bytes(32, 45)
const grantClaimsHash = base64Bytes(32, 46)
const sessionTranscriptHash = base64Bytes(32, 47)

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

function sessionInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    protocolVersion: 1,
    relayType: 'session.init',
    relayOrigin,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    clientDeviceId: 'device-client',
    authorizationId: 'authorization-1',
    authorizationEpoch: 1,
    handshakeId: 'handshake-1',
    clientNonce,
    clientEphemeralAgreementKey: p256Point3,
    issuedAt: fixedNow,
    expiresAt: fixedNow + 30_000,
    clientSignature,
    ...overrides,
  }
}

function sessionAccept(overrides: Partial<SessionAccept> = {}): SessionAccept {
  return {
    protocolVersion: 1,
    relayType: 'session.accept',
    relayOrigin,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    clientDeviceId: 'device-client',
    authorizationId: 'authorization-1',
    authorizationEpoch: 1,
    handshakeId: 'handshake-1',
    connectionGeneration: 7,
    clientToHostKeyId: 'key-client-to-host',
    hostToClientKeyId: 'key-host-to-client',
    sessionInitHash,
    hostNonce,
    hostEphemeralAgreementKey: p256Point4,
    issuedAt: fixedNow + 1_000,
    expiresAt: fixedNow + 30_000,
    hostSignature,
    ...overrides,
  }
}

describe('daily E2EE session handshake wire', () => {
  it('round-trips strict canonical init/accept frames for the expected origin', () => {
    const init = sessionInit()
    const accept = sessionAccept()
    expect(decodeSessionInit(encodeSessionInit(init), {
      expectedRelayOrigin: relayOrigin,
      now: fixedNow + 1,
    })).toEqual(init)
    expectCode(
      () => decodeSessionInit(encodeSessionInit(init), {
        expectedRelayOrigin: relayOrigin,
        now: Number.NaN,
      }),
      'schema-invalid',
    )
    expect(decodeSessionAccept(encodeSessionAccept(accept), {
      expectedRelayOrigin: relayOrigin,
      now: fixedNow + 1_001,
    })).toEqual(accept)
    expectCode(
      () => decodeSessionInit(encodeSessionInit(init), {
        expectedRelayOrigin: 'https://other.example.test',
        now: fixedNow + 1,
      }),
      'route-mismatch',
    )
  })

  it('locks session signatures and the canonical session.init hash input', () => {
    const init = sessionInit()
    expect(new TextDecoder().decode(encodeSessionInitSignatureInput(init))).toBe(JSON.stringify([
      'codex-plus-session-init-signature-v1',
      1,
      'session.init',
      relayOrigin,
      'host-main',
      'device-host',
      'device-client',
      'authorization-1',
      1,
      'handshake-1',
      clientNonce,
      ['EC', 'P-256', p256Point3.x, p256Point3.y],
      fixedNow,
      fixedNow + 30_000,
    ]))
    expect(new TextDecoder().decode(encodeSessionInitHashInput(init))).toBe(encodeSessionInit(init))

    const accept = sessionAccept()
    expect(new TextDecoder().decode(encodeSessionAcceptSignatureInput({
      sessionAccept: accept,
      grantClaimsHash,
    }))).toBe(JSON.stringify([
      'codex-plus-session-accept-signature-v1',
      1,
      'session.accept',
      relayOrigin,
      'host-main',
      'device-host',
      'device-client',
      'authorization-1',
      1,
      'handshake-1',
      7,
      'key-client-to-host',
      'key-host-to-client',
      sessionInitHash,
      hostNonce,
      ['EC', 'P-256', p256Point4.x, p256Point4.y],
      fixedNow + 1_000,
      fixedNow + 30_000,
      grantClaimsHash,
    ]))
    expect(encodeSessionAcceptSignatureInput({
      sessionAccept: sessionAccept({ connectionGeneration: 8 }),
      grantClaimsHash,
    })).not.toEqual(encodeSessionAcceptSignatureInput({ sessionAccept: accept, grantClaimsHash }))
  })

  it('locks the full signed transcript, connection-salt input, and directional KDF context', () => {
    const init = sessionInit()
    const accept = sessionAccept()
    const transcriptContext = { sessionInit: init, sessionAccept: accept, grantClaimsHash }
    const expectedTranscript = JSON.stringify([
      'codex-plus-session-transcript-v1',
      [
        1,
        'session.init',
        relayOrigin,
        'host-main',
        'device-host',
        'device-client',
        'authorization-1',
        1,
        'handshake-1',
        clientNonce,
        ['EC', 'P-256', p256Point3.x, p256Point3.y],
        fixedNow,
        fixedNow + 30_000,
        clientSignature,
      ],
      [
        1,
        'session.accept',
        relayOrigin,
        'host-main',
        'device-host',
        'device-client',
        'authorization-1',
        1,
        'handshake-1',
        7,
        'key-client-to-host',
        'key-host-to-client',
        sessionInitHash,
        hostNonce,
        ['EC', 'P-256', p256Point4.x, p256Point4.y],
        fixedNow + 1_000,
        fixedNow + 30_000,
        hostSignature,
      ],
      grantClaimsHash,
    ])
    expect(new TextDecoder().decode(encodeSessionTranscript(transcriptContext))).toBe(expectedTranscript)
    expect(encodeSessionConnectionSaltInput(transcriptContext)).toEqual(encodeSessionTranscript(transcriptContext))

    const kdfContext = {
      sessionTranscriptHash,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      clientDeviceId: 'device-client',
      authorizationId: 'authorization-1',
      authorizationEpoch: 1,
      connectionGeneration: 7,
      direction: 'client-to-host',
      keyId: 'key-client-to-host',
      purpose: 'aes-key',
    }
    expect(new TextDecoder().decode(encodeSessionKdfInfo(kdfContext))).toBe(JSON.stringify([
      'codex-plus-session-kdf-v1',
      sessionTranscriptHash,
      'host-main',
      'device-host',
      'device-client',
      'authorization-1',
      1,
      7,
      'client-to-host',
      'key-client-to-host',
      'aes-key',
    ]))
    expect(encodeSessionKdfInfo({ ...kdfContext, direction: 'host-to-client' }))
      .not.toEqual(encodeSessionKdfInfo(kdfContext))
  })

  it('fails closed on key-id reuse, time/length errors, canonical/BOM drift, and authority mismatch', () => {
    expectCode(
      () => encodeSessionAccept(sessionAccept({ hostToClientKeyId: 'key-client-to-host' })),
      'schema-invalid',
    )
    expectCode(
      () => encodeSessionInit(sessionInit({ clientNonce: base64Bytes(31, 41) })),
      'schema-invalid',
    )
    expectCode(
      () => encodeSessionAccept(sessionAccept({ hostSignature: base64Bytes(63, 44) })),
      'schema-invalid',
    )
    expectCode(
      () => encodeSessionInit(sessionInit({ expiresAt: fixedNow + 30_001 })),
      'schema-invalid',
    )

    const canonical = encodeSessionInit(sessionInit())
    expectCode(
      () => decodeSessionInit(` ${canonical}`, { expectedRelayOrigin: relayOrigin, now: fixedNow + 1 }),
      'schema-invalid',
    )
    expectCode(
      () => decodeSessionInit(
        Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(canonical)]),
        { expectedRelayOrigin: relayOrigin, now: fixedNow + 1 },
      ),
      'invalid-json',
    )
    expectCode(
      () => encodeSessionTranscript({
        sessionInit: sessionInit(),
        sessionAccept: sessionAccept({ clientDeviceId: 'device-tampered' }),
        grantClaimsHash,
      }),
      'stale-authority',
    )
  })
})

describe('session key-confirm application controls', () => {
  it('round-trips confirm/ready and binds transcript authority and sender role', () => {
    const confirm = {
      kind: 'control' as const,
      operation: 'session.confirm' as const,
      sessionTranscriptHash,
      authorizationId: 'authorization-1',
      authorizationEpoch: 1,
      connectionGeneration: 7,
      senderRole: 'client' as const,
    }
    const ready = {
      ...confirm,
      operation: 'session.ready' as const,
      senderRole: 'host' as const,
    }
    expect(decodeApplicationMessage(encodeApplicationMessage(confirm), 'control')).toEqual(confirm)
    expect(decodeApplicationMessage(encodeApplicationMessage(ready), 'control')).toEqual(ready)
    expectCode(
      () => encodeApplicationMessage({ ...confirm, senderRole: 'host' }),
      'schema-invalid',
    )
    expectCode(
      () => encodeApplicationMessage({ ...ready, sessionTranscriptHash: base64Bytes(31, 47) }),
      'schema-invalid',
    )
  })
})
