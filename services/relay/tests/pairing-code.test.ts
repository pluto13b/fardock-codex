import {
  encodePairingInvitationFragment,
  PROTOCOL_VERSION,
  type P256PublicJwk,
} from '@codex-plus/protocol'
import { describe, expect, it } from 'vitest'

import { PairingCodeAuthority } from '../src/pairing-code.ts'

const ORIGIN = 'https://gateway.example.test'
const NOW = 1_900_000_000_000

function key(seed: number): P256PublicJwk {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.alloc(32, seed).toString('base64url'),
    y: Buffer.alloc(32, seed + 1).toString('base64url'),
  }
}

function invitation(expiresAt = NOW + 120_000, relayOrigin = ORIGIN): string {
  return encodePairingInvitationFragment({
    protocolVersion: PROTOCOL_VERSION,
    relayOrigin,
    hostId: 'host.pairing-code',
    hostDeviceId: 'device.windows',
    pairSessionId: 'pair.once',
    issuedAt: NOW - 1_000,
    expiresAt,
    rendezvousSecret: Buffer.alloc(32, 5).toString('base64url'),
    hostEphemeralAgreementKey: key(7),
    hostSigningKey: key(11),
    hostKeyFingerprint: Buffer.alloc(32, 13).toString('base64url'),
    invitationSignature: Buffer.alloc(64, 17).toString('base64url'),
  })
}

describe('pairing code authority', () => {
  it('removes a code when the owning invitation is closed', () => {
    const authority = new PairingCodeAuthority({ publicOrigin: ORIGIN, now: () => NOW })
    const { code } = authority.register(invitation(), NOW + 120_000)
    authority.revoke('pair.once')
    expect(authority.redeem(code)).toBeUndefined()
  })
  it('registers an eight-character code and redeems it exactly once', () => {
    const authority = new PairingCodeAuthority({
      publicOrigin: ORIGIN,
      now: () => NOW,
      randomBytes: () => Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
    })
    const fragment = invitation()
    expect(authority.register(fragment, NOW + 120_000)).toEqual({
      code: '01234567',
      expiresAt: NOW + 120_000,
    })
    expect(authority.redeem('0123-4567')).toEqual({
      invitationFragment: fragment,
      expiresAt: NOW + 120_000,
    })
    expect(authority.redeem('01234567')).toBeUndefined()
  })

  it('rejects wrong-origin, expired, and mismatched-expiry invitations', () => {
    const authority = new PairingCodeAuthority({
      publicOrigin: ORIGIN,
      now: () => NOW,
      randomBytes: length => Buffer.alloc(length, 1),
    })
    expect(() => authority.register(invitation(NOW + 120_000, 'https://other.example.test'), NOW + 120_000))
      .toThrow('pairing-code:invalid')
    expect(() => authority.register(invitation(NOW), NOW)).toThrow()
    expect(() => authority.register(invitation(), NOW + 119_999)).toThrow('pairing-code:invalid')
  })
})
