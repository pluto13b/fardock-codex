import { describe, expect, it } from 'vitest'

import {
  decodePairingInvitationFragment,
  encodeBase64Url,
  encodeInvitationSignatureInput,
  encodeP256JwkThumbprintInput,
  encodePairingInvitationFragment,
  encodePairingTranscript,
  ProtocolViolation,
  type PairingInvitation,
} from '../src/index.ts'
import {
  base64Bytes,
  fixedNow,
  p256Generator,
  p256Point2,
  p256Point3,
  p256Point4,
  p256Point5,
} from './helpers.ts'

const relayOrigin = 'https://codex.example.test'
const secret = base64Bytes(32, 7)
const fingerprint = base64Bytes(32, 9)
const signature = base64Bytes(64, 11)

function invitation(overrides: Record<string, unknown> = {}): PairingInvitation {
  return {
    protocolVersion: 1,
    relayOrigin,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    pairSessionId: 'pair-session-1',
    issuedAt: fixedNow,
    expiresAt: fixedNow + 300_000,
    rendezvousSecret: secret,
    hostEphemeralAgreementKey: p256Generator,
    hostSigningKey: p256Point2,
    hostKeyFingerprint: fingerprint,
    invitationSignature: signature,
    ...overrides,
  } as PairingInvitation
}

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

describe('signed pairing invitation DTO', () => {
  it('round-trips a canonical fragment only for the expected deployment origin', () => {
    const fragment = encodePairingInvitationFragment(invitation())
    expect(fragment).not.toContain('=')
    expect(decodePairingInvitationFragment(`#${fragment}`, relayOrigin, fixedNow + 1)).toEqual(invitation())
    expectCode(
      () => decodePairingInvitationFragment(fragment, relayOrigin, Number.NaN),
      'schema-invalid',
    )
    expectCode(
      () => decodePairingInvitationFragment(fragment, 'https://other.example.test', fixedNow + 1),
      'route-mismatch',
    )
  })

  it('enforces five-minute lifetime, expiry, strict fields, secure origins, and distinct host keys', () => {
    expectCode(
      () => encodePairingInvitationFragment(invitation({ expiresAt: fixedNow + 300_001 })),
      'schema-invalid',
    )
    const expired = encodePairingInvitationFragment(invitation({
      issuedAt: fixedNow - 300_000,
      expiresAt: fixedNow,
    }))
    expectCode(
      () => decodePairingInvitationFragment(expired, relayOrigin, fixedNow),
      'pair-session-unavailable',
    )
    expectCode(
      () => encodePairingInvitationFragment(invitation({ relayOrigin: 'http://example.test' })),
      'schema-invalid',
    )
    expect(() => encodePairingInvitationFragment(invitation({ relayOrigin: 'http://127.0.0.1:8787' })))
      .not.toThrow()
    expectCode(() => encodePairingInvitationFragment(invitation({ unknown: true })), 'schema-invalid')
    expectCode(
      () => encodePairingInvitationFragment(invitation({ hostSigningKey: p256Generator })),
      'schema-invalid',
    )
  })

  it('locks invitation signature, transcript, and RFC 7638 thumbprint bytes', () => {
    const signatureInput = new TextDecoder().decode(encodeInvitationSignatureInput(invitation()))
    expect(signatureInput).toBe(JSON.stringify([
      'codex-plus-invitation-signature-v1',
      1,
      relayOrigin,
      'host-main',
      'device-host',
      'pair-session-1',
      fixedNow,
      fixedNow + 300_000,
      secret,
      ['EC', 'P-256', p256Generator.x, p256Generator.y],
      ['EC', 'P-256', p256Point2.x, p256Point2.y],
      fingerprint,
    ]))

    const transcript = new TextDecoder().decode(encodePairingTranscript(invitation(), p256Point3))
    expect(transcript).toBe(JSON.stringify([
      'codex-plus-pairing-transcript-v1',
      1,
      relayOrigin,
      'host-main',
      'device-host',
      'pair-session-1',
      fixedNow,
      fixedNow + 300_000,
      ['EC', 'P-256', p256Generator.x, p256Generator.y],
      ['EC', 'P-256', p256Point2.x, p256Point2.y],
      fingerprint,
      signature,
      ['EC', 'P-256', p256Point3.x, p256Point3.y],
    ]))
    expect(new TextDecoder().decode(encodeP256JwkThumbprintInput(p256Generator))).toBe(
      `{"crv":"P-256","kty":"EC","x":"${p256Generator.x}","y":"${p256Generator.y}"}`,
    )

    expect(encodeInvitationSignatureInput(invitation({ hostDeviceId: 'device-host-tampered' })))
      .not.toEqual(encodeInvitationSignatureInput(invitation()))
  })

  it('rejects non-canonical fragments, UTF-8 BOM, malformed signatures, coordinates, and secrets', () => {
    const value = invitation()
    const { relayOrigin: reorderedOrigin, protocolVersion, ...remainingFields } = value
    const reorderedJson = JSON.stringify({ relayOrigin: reorderedOrigin, protocolVersion, ...remainingFields })
    expectCode(
      () => decodePairingInvitationFragment(
        encodeBase64Url(new TextEncoder().encode(reorderedJson)),
        relayOrigin,
        fixedNow + 1,
      ),
      'schema-invalid',
    )

    const jsonBytes = new TextEncoder().encode(JSON.stringify(value))
    const bomBytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...jsonBytes])
    expectCode(
      () => decodePairingInvitationFragment(encodeBase64Url(bomBytes), relayOrigin, fixedNow + 1),
      'invalid-json',
    )

    expectCode(
      () => encodePairingInvitationFragment(invitation({ rendezvousSecret: base64Bytes(31, 7) })),
      'schema-invalid',
    )
    expectCode(
      () => encodePairingInvitationFragment(invitation({ invitationSignature: base64Bytes(63, 11) })),
      'schema-invalid',
    )
    expectCode(
      () => encodePairingInvitationFragment(invitation({ hostSigningKey: { ...p256Point2, crv: 'P-384' } })),
      'schema-invalid',
    )
    expectCode(() => encodePairingTranscript(invitation(), { ...p256Point3, extra: true }), 'schema-invalid')
    expectCode(() => encodeP256JwkThumbprintInput({ ...p256Generator, kty: 'RSA' }), 'schema-invalid')
  })

  it('uses static public JWK vectors that WebCrypto accepts as real P-256 points', async () => {
    await expect(crypto.subtle.importKey(
      'jwk',
      p256Generator,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )).resolves.toBeDefined()
    await expect(crypto.subtle.importKey(
      'jwk',
      p256Point2,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )).resolves.toBeDefined()
    await expect(crypto.subtle.importKey(
      'jwk',
      p256Point3,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )).resolves.toBeDefined()
    await expect(crypto.subtle.importKey(
      'jwk',
      p256Point4,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )).resolves.toBeDefined()
    await expect(crypto.subtle.importKey(
      'jwk',
      p256Point5,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )).resolves.toBeDefined()
  })
})
