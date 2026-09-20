import { describe, expect, it } from 'vitest'

import {
  decodeRelayAuthorizationApplied,
  decodeRelayAuthorizationPut,
  decodeRelayDeviceChallenge,
  decodeRelayDeviceHello,
  decodeRelayDeviceProof,
  decodeRelayDeviceWelcome,
  decodeRelayPairClaim,
  decodeRelayPairClaimed,
  decodeRelayPairClose,
  decodeRelayPairOpen,
  decodeRelayPairOpened,
  decodeRelayR3Control,
  encodeRelayAuthorizationApplied,
  encodeRelayAuthorizationPut,
  encodeRelayDeviceChallenge,
  encodeRelayDeviceHello,
  encodeRelayDeviceProof,
  encodeRelayDeviceProofSignatureInput,
  encodeRelayDeviceWelcome,
  encodeRelayPairClaim,
  encodeRelayPairClaimed,
  encodeRelayPairClose,
  encodeRelayPairOpen,
  encodeRelayPairOpened,
  MAX_FRAME_BYTES,
  MAX_RELAY_R3_CONTROL_BYTES,
  ProtocolViolation,
  validateRelayDeviceChallengeTime,
} from '../src/index.ts'
import {
  base64Bytes,
  fixedNow,
  p256Generator,
} from './helpers.ts'

const relayOrigin = 'https://relay.example'
const bootstrapCredential = base64Bytes(32, 1)
const signingFingerprint = base64Bytes(32, 2)
const challengeBytes = base64Bytes(32, 3)
const signature = base64Bytes(64, 4)

const hostBootstrapHello = {
  protocolVersion: 1 as const,
  relayType: 'device.hello' as const,
  relayOrigin,
  role: 'host' as const,
  authMode: 'bootstrap' as const,
  hostId: 'host-main',
  hostDeviceId: 'device-host',
  deviceId: 'device-host',
  bootstrapCredential,
  hostSigningKey: p256Generator,
  hostSigningFingerprint: signingFingerprint,
}

const hostChallengeHello = {
  protocolVersion: 1 as const,
  relayType: 'device.hello' as const,
  relayOrigin,
  role: 'host' as const,
  authMode: 'challenge' as const,
  hostId: 'host-main',
  hostDeviceId: 'device-host',
  deviceId: 'device-host',
}

const clientChallengeHello = {
  protocolVersion: 1 as const,
  relayType: 'device.hello' as const,
  relayOrigin,
  role: 'client' as const,
  authMode: 'challenge' as const,
  hostId: 'host-main',
  hostDeviceId: 'device-host',
  deviceId: 'device-phone',
  authorizationId: 'authorization-1',
  authorizationEpoch: 7,
}

const bootstrapChallenge = {
  protocolVersion: 1 as const,
  relayType: 'device.challenge' as const,
  relayOrigin,
  role: 'host' as const,
  authMode: 'bootstrap' as const,
  hostId: 'host-main',
  hostDeviceId: 'device-host',
  deviceId: 'device-host',
  hostSigningFingerprint: signingFingerprint,
  challengeId: 'challenge-1',
  challenge: challengeBytes,
  issuedAt: fixedNow,
  expiresAt: fixedNow + 15_000,
}

const hostChallenge = {
  protocolVersion: 1 as const,
  relayType: 'device.challenge' as const,
  relayOrigin,
  role: 'host' as const,
  authMode: 'challenge' as const,
  hostId: 'host-main',
  hostDeviceId: 'device-host',
  deviceId: 'device-host',
  challengeId: 'challenge-2',
  challenge: challengeBytes,
  issuedAt: fixedNow,
  expiresAt: fixedNow + 14_000,
}

const clientChallenge = {
  protocolVersion: 1 as const,
  relayType: 'device.challenge' as const,
  relayOrigin,
  role: 'client' as const,
  authMode: 'challenge' as const,
  hostId: 'host-main',
  hostDeviceId: 'device-host',
  deviceId: 'device-phone',
  authorizationId: 'authorization-1',
  authorizationEpoch: 7,
  challengeId: 'challenge-3',
  challenge: challengeBytes,
  issuedAt: fixedNow,
  expiresAt: fixedNow + 14_000,
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

function withBom(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  const result = new Uint8Array(encoded.byteLength + 3)
  result.set([0xef, 0xbb, 0xbf])
  result.set(encoded, 3)
  return result
}

describe('R3 Relay device challenge wire', () => {
  it('locks all three hello branches and Host bootstrap golden JSON', () => {
    const encoded = encodeRelayDeviceHello(hostBootstrapHello)
    expect(encoded).toBe(JSON.stringify({
      protocolVersion: 1,
      relayType: 'device.hello',
      relayOrigin,
      role: 'host',
      authMode: 'bootstrap',
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      deviceId: 'device-host',
      bootstrapCredential,
      hostSigningKey: p256Generator,
      hostSigningFingerprint: signingFingerprint,
    }))
    expect(decodeRelayDeviceHello(encoded, relayOrigin)).toEqual(hostBootstrapHello)
    expect(decodeRelayDeviceHello(
      encodeRelayDeviceHello(hostChallengeHello),
      relayOrigin,
    )).toEqual(hostChallengeHello)
    expect(decodeRelayDeviceHello(
      encodeRelayDeviceHello(clientChallengeHello),
      relayOrigin,
    )).toEqual(clientChallengeHello)
  })

  it('rejects branch-crossing fields, mismatched Host identity, and origins', () => {
    expectCode(
      () => encodeRelayDeviceHello({ ...hostChallengeHello, authorizationId: 'authorization-1' }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayDeviceHello({ ...clientChallengeHello, bootstrapCredential }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayDeviceHello({ ...hostBootstrapHello, deviceId: 'device-other' }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayDeviceHello({ ...clientChallengeHello, deviceId: 'device-host' }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayDeviceHello({ ...hostBootstrapHello, relayOrigin: 'http://relay.example' }),
      'schema-invalid',
    )
    expectCode(
      () => decodeRelayDeviceHello(encodeRelayDeviceHello(hostChallengeHello), 'https://other.example'),
      'route-mismatch',
    )
    expectCode(
      () => decodeRelayDeviceHello(encodeRelayDeviceHello(hostChallengeHello), `${relayOrigin}/`),
      'schema-invalid',
    )
  })

  it('locks challenge branches, lifetime, expected origin, and safe now', () => {
    for (const challenge of [bootstrapChallenge, hostChallenge, clientChallenge]) {
      expect(decodeRelayDeviceChallenge(
        encodeRelayDeviceChallenge(challenge),
        relayOrigin,
        fixedNow,
      )).toEqual(challenge)
    }
    expectCode(
      () => encodeRelayDeviceChallenge({
        ...bootstrapChallenge,
        expiresAt: bootstrapChallenge.issuedAt + 15_001,
      }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayDeviceChallenge({ ...hostChallenge, authorizationEpoch: 1 }),
      'schema-invalid',
    )
    expectCode(
      () => decodeRelayDeviceChallenge(
        encodeRelayDeviceChallenge(hostChallenge),
        'https://other.example',
        fixedNow,
      ),
      'route-mismatch',
    )
    expectCode(
      () => decodeRelayDeviceChallenge(
        encodeRelayDeviceChallenge(hostChallenge),
        relayOrigin,
        Number.NaN,
      ),
      'schema-invalid',
    )
    expectCode(
      () => decodeRelayDeviceChallenge(
        encodeRelayDeviceChallenge(hostChallenge),
        relayOrigin,
        hostChallenge.expiresAt,
      ),
      'expired',
    )
    const future = {
      ...hostChallenge,
      issuedAt: fixedNow + 30_001,
      expiresAt: fixedNow + 44_001,
    }
    expectCode(
      () => decodeRelayDeviceChallenge(
        encodeRelayDeviceChallenge(future),
        relayOrigin,
        fixedNow,
      ),
      'future-sent-at',
    )
  })

  it('encodes the normative proof input exactly and changes on every bound tamper', () => {
    const encoded = encodeRelayDeviceProofSignatureInput(clientChallenge)
    expect(new TextDecoder().decode(encoded)).toBe(JSON.stringify([
      'codex-plus-relay-device-proof-v1',
      1,
      relayOrigin,
      'client',
      'challenge',
      'host-main',
      'device-host',
      'device-phone',
      'authorization-1',
      7,
      null,
      'challenge-3',
      challengeBytes,
      fixedNow,
      fixedNow + 14_000,
    ]))
    expect(new TextDecoder().decode(
      encodeRelayDeviceProofSignatureInput(bootstrapChallenge),
    )).toBe(JSON.stringify([
      'codex-plus-relay-device-proof-v1',
      1,
      relayOrigin,
      'host',
      'bootstrap',
      'host-main',
      'device-host',
      'device-host',
      null,
      null,
      signingFingerprint,
      'challenge-1',
      challengeBytes,
      fixedNow,
      fixedNow + 15_000,
    ]))
    for (const changed of [
      { ...clientChallenge, relayOrigin: 'https://other.example' },
      { ...clientChallenge, authorizationId: 'authorization-2' },
      { ...clientChallenge, authorizationEpoch: 8 },
      { ...clientChallenge, challengeId: 'challenge-4' },
      { ...clientChallenge, challenge: base64Bytes(32, 9) },
      { ...clientChallenge, expiresAt: fixedNow + 14_001 },
    ]) {
      expect(encodeRelayDeviceProofSignatureInput(changed)).not.toEqual(encoded)
    }
    expectCode(
      () => encodeRelayDeviceProofSignatureInput({ ...clientChallenge, unknown: true }),
      'schema-invalid',
    )
  })

  it('round-trips strict proof and secret-free welcome branches', () => {
    const bootstrapProof = {
      protocolVersion: 1 as const,
      relayType: 'device.proof' as const,
      relayOrigin,
      role: 'host' as const,
      authMode: 'bootstrap' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      deviceId: 'device-host',
      hostSigningFingerprint: signingFingerprint,
      challengeId: 'challenge-1',
      signature,
    }
    const clientProof = {
      protocolVersion: 1 as const,
      relayType: 'device.proof' as const,
      relayOrigin,
      role: 'client' as const,
      authMode: 'challenge' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      deviceId: 'device-phone',
      authorizationId: 'authorization-1',
      authorizationEpoch: 7,
      challengeId: 'challenge-3',
      signature,
    }
    expect(decodeRelayDeviceProof(
      encodeRelayDeviceProof(bootstrapProof),
      relayOrigin,
    )).toEqual(bootstrapProof)
    expect(decodeRelayDeviceProof(
      encodeRelayDeviceProof(clientProof),
      relayOrigin,
    )).toEqual(clientProof)
    expectCode(
      () => encodeRelayDeviceProof({ ...clientProof, hostSigningFingerprint: signingFingerprint }),
      'schema-invalid',
    )

    const hostWelcome = {
      protocolVersion: 1 as const,
      relayType: 'device.welcome' as const,
      relayOrigin,
      role: 'host' as const,
      authMode: 'challenge' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      deviceId: 'device-host',
      heartbeatIntervalMs: 30_000,
      maxFrameBytes: MAX_FRAME_BYTES,
    }
    const clientWelcome = {
      protocolVersion: 1 as const,
      relayType: 'device.welcome' as const,
      relayOrigin,
      role: 'client' as const,
      authMode: 'challenge' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      deviceId: 'device-phone',
      authorizationId: 'authorization-1',
      authorizationEpoch: 7,
      heartbeatIntervalMs: 30_000,
      maxFrameBytes: MAX_FRAME_BYTES,
    }
    expect(decodeRelayDeviceWelcome(
      encodeRelayDeviceWelcome(hostWelcome),
      relayOrigin,
    )).toEqual(hostWelcome)
    expect(decodeRelayDeviceWelcome(
      encodeRelayDeviceWelcome(clientWelcome),
      relayOrigin,
    )).toEqual(clientWelcome)
    expectCode(
      () => encodeRelayDeviceWelcome({ ...clientWelcome, bootstrapCredential }),
      'schema-invalid',
    )
  })

  it('rejects BOM, non-canonical, unknown, and oversized control frames', () => {
    const encoded = encodeRelayDeviceHello(hostChallengeHello)
    expectCode(() => decodeRelayDeviceHello(withBom(encoded), relayOrigin), 'invalid-json')
    expectCode(() => decodeRelayDeviceHello(` ${encoded}`, relayOrigin), 'schema-invalid')
    expectCode(
      () => decodeRelayDeviceHello(encoded.replace('{', '{"unknown":true,'), relayOrigin),
      'schema-invalid',
    )
    expectCode(
      () => decodeRelayR3Control('x'.repeat(MAX_RELAY_R3_CONTROL_BYTES + 1)),
      'frame-too-large',
    )
  })
})

describe('R3 Relay authorization synchronization wire', () => {
  const active = {
    protocolVersion: 1 as const,
    relayType: 'authorization.put' as const,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    clientDeviceId: 'device-phone',
    authorizationId: 'authorization-1',
    authorizationEpoch: 1,
    hostAuthorizationRevision: 1,
    status: 'active' as const,
    clientSigningKey: p256Generator,
    clientSigningFingerprint: signingFingerprint,
  }

  const revoked = {
    protocolVersion: 1 as const,
    relayType: 'authorization.put' as const,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    clientDeviceId: 'device-phone',
    authorizationId: 'authorization-1',
    authorizationEpoch: 2,
    hostAuthorizationRevision: 2,
    status: 'revoked' as const,
  }

  it('locks active/revoked branches and applied receipts', () => {
    expect(decodeRelayAuthorizationPut(encodeRelayAuthorizationPut(active))).toEqual(active)
    expect(decodeRelayAuthorizationPut(encodeRelayAuthorizationPut(revoked))).toEqual(revoked)
    expect(encodeRelayAuthorizationPut(revoked)).toBe(JSON.stringify(revoked))

    for (const update of [active, revoked]) {
      const applied = {
        protocolVersion: 1 as const,
        relayType: 'authorization.applied' as const,
        hostId: update.hostId,
        hostDeviceId: update.hostDeviceId,
        clientDeviceId: update.clientDeviceId,
        authorizationId: update.authorizationId,
        authorizationEpoch: update.authorizationEpoch,
        hostAuthorizationRevision: update.hostAuthorizationRevision,
        status: update.status,
      }
      expect(decodeRelayAuthorizationApplied(
        encodeRelayAuthorizationApplied(applied),
      )).toEqual(applied)
    }
  })

  it('rejects key/status crossing, unsafe counters, device reuse, and unknown fields', () => {
    expectCode(
      () => encodeRelayAuthorizationPut({ ...active, status: 'revoked' }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayAuthorizationPut({
        ...revoked,
        clientSigningKey: p256Generator,
        clientSigningFingerprint: signingFingerprint,
      }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayAuthorizationPut({ ...active, authorizationEpoch: 0 }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayAuthorizationPut({ ...active, hostAuthorizationRevision: Number.NaN }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayAuthorizationPut({ ...active, clientDeviceId: active.hostDeviceId }),
      'schema-invalid',
    )
    expectCode(
      () => encodeRelayAuthorizationPut({ ...active, secret: bootstrapCredential }),
      'schema-invalid',
    )
  })
})

describe('R3 Relay pair carrier control wire', () => {
  const pairOpen = {
    protocolVersion: 1 as const,
    relayType: 'pair.open' as const,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    pairSessionId: 'pair-session-1',
    expiresAt: fixedNow + 300_000,
  }

  it('round-trips pair.open/opened and enforces the 300-second window', () => {
    const encoded = encodeRelayPairOpen(pairOpen)
    expect(encoded).toBe(JSON.stringify(pairOpen))
    expect(decodeRelayPairOpen(encoded, fixedNow)).toEqual(pairOpen)
    const opened = { ...pairOpen, relayType: 'pair.opened' as const }
    expect(decodeRelayPairOpened(encodeRelayPairOpened(opened), fixedNow)).toEqual(opened)
    expectCode(
      () => decodeRelayPairOpen(
        encodeRelayPairOpen({ ...pairOpen, expiresAt: fixedNow + 300_001 }),
        fixedNow,
      ),
      'ttl-exceeded',
    )
    expectCode(
      () => decodeRelayPairOpen(
        encodeRelayPairOpen({ ...pairOpen, expiresAt: fixedNow }),
        fixedNow,
      ),
      'pair-session-unavailable',
    )
    expectCode(() => decodeRelayPairOpen(encoded, Number.NaN), 'schema-invalid')
    expectCode(() => encodeRelayPairOpen({ ...pairOpen, expiresAt: -1 }), 'schema-invalid')
  })

  it('locks claim/claimed identities and close reasons', () => {
    const claim = {
      protocolVersion: 1 as const,
      relayType: 'pair.claim' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      pairSessionId: 'pair-session-1',
      joinId: 'join-1',
    }
    const claimed = { ...claim, relayType: 'pair.claimed' as const }
    expect(decodeRelayPairClaim(encodeRelayPairClaim(claim))).toEqual(claim)
    expect(decodeRelayPairClaimed(encodeRelayPairClaimed(claimed))).toEqual(claimed)
    for (const reason of [
      'approved',
      'denied',
      'expired',
      'attempt-limit',
      'cancelled',
    ] as const) {
      const close = {
        protocolVersion: 1 as const,
        relayType: 'pair.close' as const,
        hostId: 'host-main',
        hostDeviceId: 'device-host',
        pairSessionId: 'pair-session-1',
        reason,
      }
      expect(decodeRelayPairClose(encodeRelayPairClose(close))).toEqual(close)
    }
    expectCode(
      () => encodeRelayPairClose({
        protocolVersion: 1,
        relayType: 'pair.close',
        hostId: 'host-main',
        hostDeviceId: 'device-host',
        pairSessionId: 'pair-session-1',
        reason: 'success',
      }),
      'schema-invalid',
    )
    expectCode(() => encodeRelayPairClaim({ ...claim, reason: 'approved' }), 'schema-invalid')
  })

  it('keeps standalone challenge validation fail-closed for malformed TTL', () => {
    expectCode(
      () => validateRelayDeviceChallengeTime({
        ...hostChallenge,
        expiresAt: hostChallenge.issuedAt + 15_001,
      } as typeof hostChallenge, fixedNow),
      'ttl-exceeded',
    )
  })
})
