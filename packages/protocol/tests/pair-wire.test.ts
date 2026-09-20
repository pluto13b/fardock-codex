import { describe, expect, it } from 'vitest'

import {
  MAX_PAIRING_CIPHERTEXT_BYTES,
  ProtocolViolation,
  decodeGrantClaims,
  decodePairJoinDetails,
  decodePairJoinFrame,
  decodePairResultFrame,
  decodePairResultPayload,
  encodeAgreementProofInfo,
  encodeBase64Url,
  encodeGrantClaims,
  encodeGrantSignatureInput,
  encodePairJoinAad,
  encodePairJoinClaims,
  encodePairJoinDetails,
  encodePairJoinFrame,
  encodePairResultAad,
  encodePairResultFrame,
  encodePairResultPayload,
  encodePairSasInput,
  encodePairingKdfInfo,
  pairJoinHeader,
  pairResultHeader,
  type GrantClaims,
  type PairJoinDetails,
  type PairJoinFrame,
  type PairResultFrame,
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
const transcriptHash = base64Bytes(32, 31)
const joinClaimsHash = base64Bytes(32, 32)
const signature = base64Bytes(64, 33)
const proof = base64Bytes(32, 34)
const ciphertext = base64Bytes(128, 35)

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

function joinFrame(overrides: Partial<PairJoinFrame> = {}): PairJoinFrame {
  return {
    protocolVersion: 1,
    relayType: 'pair.join',
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    pairSessionId: 'pair-session-1',
    joinId: 'join-1',
    clientEphemeralAgreementKey: p256Point3,
    seq: 1,
    sentAt: fixedNow,
    expiresAt: fixedNow + 30_000,
    ciphertext,
    ...overrides,
  }
}

function joinDetails(overrides: Partial<PairJoinDetails> = {}): PairJoinDetails {
  return {
    pairType: 'join-details',
    pairingTranscriptHash: transcriptHash,
    clientDeviceId: 'device-client',
    deviceDisplayName: 'Alice Phone',
    clientChallenge: base64Bytes(32, 36),
    clientAgreementKey: p256Point4,
    clientSigningKey: p256Point5,
    clientJoinSignature: signature,
    clientAgreementProof: proof,
    ...overrides,
  }
}

function grantClaims(overrides: Partial<GrantClaims> = {}): GrantClaims {
  return {
    protocolVersion: 1,
    relayOrigin,
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    clientDeviceId: 'device-client',
    authorizationId: 'authorization-1',
    authorizationEpoch: 1,
    issuedAt: fixedNow + 10_000,
    pairingTranscriptHash: transcriptHash,
    joinClaimsHash,
    clientChallenge: base64Bytes(32, 36),
    hostChallenge: base64Bytes(32, 37),
    hostAgreementKey: p256Generator,
    hostSigningKey: p256Point2,
    hostSigningFingerprint: base64Bytes(32, 38),
    clientAgreementKey: p256Point4,
    clientSigningKey: p256Point5,
    clientSigningFingerprint: base64Bytes(32, 39),
    remotePermissionModes: ['ask', 'read-only'],
    approvalDecisions: ['approve-once', 'deny'],
    ...overrides,
  }
}

function resultFrame(overrides: Partial<PairResultFrame> = {}): PairResultFrame {
  return {
    protocolVersion: 1,
    relayType: 'pair.result',
    hostId: 'host-main',
    hostDeviceId: 'device-host',
    pairSessionId: 'pair-session-1',
    joinId: 'join-1',
    seq: 1,
    sentAt: fixedNow + 10_000,
    expiresAt: fixedNow + 30_000,
    ciphertext,
    ...overrides,
  }
}

describe('pair.join wire and provisional plaintext', () => {
  it('round-trips canonical frames and locks every visible field into AAD', () => {
    const frame = joinFrame()
    const encoded = encodePairJoinFrame(frame)
    expect(decodePairJoinFrame(encoded, {
      now: fixedNow + 1,
      invitationExpiresAt: fixedNow + 120_000,
    })).toEqual(frame)

    expect(new TextDecoder().decode(encodePairJoinAad(pairJoinHeader(frame)))).toBe(JSON.stringify([
      'codex-plus-pair-join-aad-v1',
      1,
      'host-main',
      'device-host',
      'pair-session-1',
      'join-1',
      ['EC', 'P-256', p256Point3.x, p256Point3.y],
      1,
      fixedNow,
      fixedNow + 30_000,
    ]))
    expect(encodePairJoinAad(pairJoinHeader(joinFrame({ hostDeviceId: 'device-host-tampered' }))))
      .not.toEqual(encodePairJoinAad(pairJoinHeader(frame)))
  })

  it('locks join claims, agreement proof, SAS, and pairing KDF byte encodings', () => {
    const details = joinDetails()
    expect(decodePairJoinDetails(encodePairJoinDetails(details))).toEqual(details)
    expect(new TextDecoder().decode(encodePairJoinClaims(details))).toBe(JSON.stringify([
      'codex-plus-pair-join-signature-v1',
      transcriptHash,
      'device-client',
      'Alice Phone',
      base64Bytes(32, 36),
      ['EC', 'P-256', p256Point4.x, p256Point4.y],
      ['EC', 'P-256', p256Point5.x, p256Point5.y],
    ]))
    expect(new TextDecoder().decode(encodeAgreementProofInfo({
      pairingTranscriptHash: transcriptHash,
      joinClaimsHash,
    }))).toBe(JSON.stringify([
      'codex-plus-pair-agreement-pop-v1',
      transcriptHash,
      joinClaimsHash,
    ]))
    expect(new TextDecoder().decode(encodePairSasInput({
      pairingTranscriptHash: transcriptHash,
      joinClaimsHash,
    }))).toBe(JSON.stringify([
      'codex-plus-pair-sas-v1',
      transcriptHash,
      joinClaimsHash,
    ]))
    expect(new TextDecoder().decode(encodePairingKdfInfo({
      pairingTranscriptHash: transcriptHash,
      purpose: 'client-to-host-key',
    }))).toBe(JSON.stringify([
      'codex-plus-pairing-kdf-v1',
      transcriptHash,
      'client-to-host-key',
    ]))
  })

  it('rejects non-canonical/BOM plaintext, unsafe names, invalid lengths, time, and oversized pair ciphertext', () => {
    const canonical = encodePairJoinDetails(joinDetails())
    expectCode(() => decodePairJoinDetails(` ${canonical}`), 'schema-invalid')
    expectCode(
      () => decodePairJoinDetails(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(canonical)])),
      'invalid-json',
    )
    for (const deviceDisplayName of [' Alice', 'Alice\nPhone', 'Alice\u202ePhone', '\ud800']) {
      expectCode(() => encodePairJoinDetails(joinDetails({ deviceDisplayName })), 'schema-invalid')
    }
    expectCode(
      () => encodePairJoinDetails(joinDetails({ clientJoinSignature: base64Bytes(63, 33) })),
      'schema-invalid',
    )
    expectCode(
      () => encodePairJoinDetails(joinDetails({ pairingTranscriptHash: base64Bytes(31, 31) })),
      'schema-invalid',
    )
    expectCode(
      () => encodePairJoinFrame(joinFrame({ expiresAt: fixedNow + 30_001 })),
      'schema-invalid',
    )
    expectCode(
      () => decodePairJoinFrame(encodePairJoinFrame(joinFrame()), {
        now: fixedNow + 1,
        invitationExpiresAt: fixedNow + 29_999,
      }),
      'ttl-exceeded',
    )

    expect(() => encodePairJoinFrame(joinFrame({
      ciphertext: encodeBase64Url(new Uint8Array(MAX_PAIRING_CIPHERTEXT_BYTES)),
    }))).not.toThrow()
    expectCode(() => encodePairJoinFrame(joinFrame({
      ciphertext: encodeBase64Url(new Uint8Array(MAX_PAIRING_CIPHERTEXT_BYTES + 1)),
    })), 'payload-too-large')
  })
})

describe('pair.result grants and denial', () => {
  it('round-trips fixed grant claims and locks every claim into the host signature', () => {
    const claims = grantClaims()
    expect(decodeGrantClaims(encodeGrantClaims(claims))).toEqual(claims)
    expect(new TextDecoder().decode(encodeGrantSignatureInput(claims))).toBe(JSON.stringify([
      'codex-plus-pair-grant-signature-v1',
      1,
      relayOrigin,
      'host-main',
      'device-host',
      'device-client',
      'authorization-1',
      1,
      fixedNow + 10_000,
      transcriptHash,
      joinClaimsHash,
      base64Bytes(32, 36),
      base64Bytes(32, 37),
      ['EC', 'P-256', p256Generator.x, p256Generator.y],
      ['EC', 'P-256', p256Point2.x, p256Point2.y],
      base64Bytes(32, 38),
      ['EC', 'P-256', p256Point4.x, p256Point4.y],
      ['EC', 'P-256', p256Point5.x, p256Point5.y],
      base64Bytes(32, 39),
      ['ask', 'read-only'],
      ['approve-once', 'deny'],
    ]))
    expect(encodeGrantSignatureInput(grantClaims({ authorizationId: 'authorization-tampered' })))
      .not.toEqual(encodeGrantSignatureInput(claims))
  })

  it('uses a strict result union and canonical visible result AAD', () => {
    const approved = {
      pairType: 'pair-result' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      pairSessionId: 'pair-session-1',
      joinId: 'join-1',
      decidedAt: fixedNow + 10_000,
      outcome: 'approved' as const,
      grantClaims: grantClaims(),
      hostGrantSignature: signature,
    }
    expect(decodePairResultPayload(encodePairResultPayload(approved))).toEqual(approved)
    const denied = {
      pairType: 'pair-result' as const,
      hostId: 'host-main',
      hostDeviceId: 'device-host',
      pairSessionId: 'pair-session-1',
      joinId: 'join-1',
      decidedAt: fixedNow + 10_000,
      outcome: 'denied' as const,
    }
    expect(decodePairResultPayload(encodePairResultPayload(denied))).toEqual(denied)
    expectCode(() => encodePairResultPayload({ ...denied, grantClaims: grantClaims() }), 'schema-invalid')

    const frame = resultFrame()
    expect(decodePairResultFrame(encodePairResultFrame(frame), { now: fixedNow + 10_001 })).toEqual(frame)
    expect(new TextDecoder().decode(encodePairResultAad(pairResultHeader(frame)))).toBe(JSON.stringify([
      'codex-plus-pair-result-aad-v1',
      1,
      'host-main',
      'device-host',
      'pair-session-1',
      'join-1',
      1,
      fixedNow + 10_000,
      fixedNow + 30_000,
    ]))
    expect(encodePairResultAad(pairResultHeader(resultFrame({ joinId: 'join-tampered' }))))
      .not.toEqual(encodePairResultAad(pairResultHeader(frame)))
  })

  it('rejects capability widening, key reuse, malformed proof lengths, and unknown grant fields', () => {
    const demoClaims = { ...grantClaims(), remotePermissionModes: ['ask', 'read-only', 'full-access'] as const }
    expect(decodeGrantClaims(encodeGrantClaims(demoClaims))).toEqual(demoClaims)
    expectCode(
      () => encodeGrantClaims({ ...grantClaims(), remotePermissionModes: ['ask', 'read-only', 'full'] }),
      'schema-invalid',
    )
    expectCode(
      () => encodeGrantClaims(grantClaims({ hostSigningKey: p256Generator })),
      'schema-invalid',
    )
    expectCode(
      () => encodeGrantClaims({ ...grantClaims(), clientSigningFingerprint: base64Bytes(31, 39) }),
      'schema-invalid',
    )
    expectCode(() => encodeGrantClaims({ ...grantClaims(), workspacePath: 'D:/secret' }), 'schema-invalid')
  })
})
