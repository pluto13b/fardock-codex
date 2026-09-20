import { describe, expect, it } from 'vitest'

import { encodeBase64Url } from '@codex-plus/protocol'

import {
  MAX_AES_GCM_PLAINTEXT_BYTES,
  buildAesGcmIv,
  decryptAes256Gcm,
  deriveEcdhSecret,
  derivePairingMaterial,
  deriveSessionMaterial,
  encryptAes256Gcm,
  hmacSha256,
  importAes256GcmKey,
  sha256,
  signP256,
  verifyHmacSha256,
  verifyP256,
} from '../src/primitives.ts'
import { fingerprintP256PublicJwk } from '../src/fingerprint.ts'
import {
  exportPublicJwk,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  importAgreementPublicKey,
} from '../src/keys.ts'
import { E2eeError, randomBytes16, randomBytes32 } from '../src/runtime.ts'

const encoder = new TextEncoder()

describe('P-256 keys', () => {
  it('generates non-extractable, purpose-limited private keys', async () => {
    const agreement = await generateAgreementKeyPair()
    expect(agreement.privateKey).toMatchObject({
      type: 'private',
      extractable: false,
      usages: ['deriveBits'],
    })
    expect(agreement.publicKey).toMatchObject({
      type: 'public',
      extractable: true,
      usages: [],
    })

    const signing = await generateSigningKeyPair()
    expect(signing.privateKey).toMatchObject({
      type: 'private',
      extractable: false,
      usages: ['sign'],
    })
    expect(signing.publicKey).toMatchObject({
      type: 'public',
      extractable: true,
      usages: ['verify'],
    })
    await expect(globalThis.crypto.subtle.exportKey('jwk', signing.privateKey)).rejects.toBeDefined()
  })

  it('validates imported curve points and derives the same owned ECDH secret', async () => {
    const alice = await generateAgreementKeyPair()
    const bob = await generateAgreementKeyPair()
    const alicePublic = await importAgreementPublicKey(await exportPublicJwk(alice.publicKey))
    const bobPublic = await importAgreementPublicKey(await exportPublicJwk(bob.publicKey))
    const aliceSecret = await deriveEcdhSecret(alice.privateKey, bobPublic)
    const bobSecret = await deriveEcdhSecret(bob.privateKey, alicePublic)
    expect(aliceSecret).toEqual(bobSecret)
    expect(aliceSecret).not.toBe(bobSecret)
    bobSecret[0] ^= 0xff
    expect(aliceSecret).not.toEqual(bobSecret)

    const zero = encodeBase64Url(new Uint8Array(32))
    await expect(importAgreementPublicKey({
      kty: 'EC',
      crv: 'P-256',
      x: zero,
      y: zero,
    })).rejects.toEqual(new E2eeError('invalid-key'))
  })

  it('uses RFC 7638 fingerprint bytes and raw 64-byte signatures', async () => {
    const signing = await generateSigningKeyPair()
    const jwk = await exportPublicJwk(signing.publicKey)
    const fingerprint = await fingerprintP256PublicJwk(jwk)
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await fingerprintP256PublicJwk({ y: jwk.y, x: jwk.x, crv: jwk.crv, kty: jwk.kty })).toBe(fingerprint)

    const message = encoder.encode('signed transcript')
    const signature = await signP256(signing.privateKey, message)
    expect(signature).toHaveLength(64)
    expect(await verifyP256(signing.publicKey, message, signature)).toBe(true)
    signature[0] ^= 0x01
    expect(await verifyP256(signing.publicKey, message, signature)).toBe(false)
    expect(await verifyP256(signing.publicKey, message, signature.subarray(0, 63))).toBe(false)
  })
})

describe('fixed-purpose derivation', () => {
  it('maps detached or shared byte storage to a fixed validation error', async () => {
    const detached = new Uint8Array(32)
    structuredClone(detached.buffer, { transfer: [detached.buffer] })
    await expect(sha256(detached)).rejects.toEqual(new E2eeError('invalid-length'))

    const shared = new Uint8Array(new SharedArrayBuffer(32))
    await expect(sha256(shared)).rejects.toEqual(new E2eeError('invalid-length'))
  })

  it('separates pairing directions and output purposes', async () => {
    const shared = new Uint8Array(32).fill(1)
    const secret = new Uint8Array(32).fill(2)
    const transcriptHash = await sha256(encoder.encode('pair transcript'))
    const clientKey = await derivePairingMaterial(shared, secret, transcriptHash, 'client-to-host-key')
    const hostKey = await derivePairingMaterial(shared, secret, transcriptHash, 'host-to-client-key')
    const prefix = await derivePairingMaterial(shared, secret, transcriptHash, 'client-to-host-nonce-prefix')
    expect(clientKey).toHaveLength(32)
    expect(hostKey).toHaveLength(32)
    expect(prefix).toHaveLength(4)
    expect(clientKey).not.toEqual(hostKey)
  })

  it('binds session material to the full fixed context', async () => {
    const ikm = new Uint8Array(64).fill(3)
    const context = {
      transcriptHash32: new Uint8Array(32).fill(5),
      hostId: 'host-1',
      hostDeviceId: 'host-device-1',
      clientDeviceId: 'client-device-1',
      authorizationId: 'authorization-1',
      authorizationEpoch: 1,
      generation: 7,
      direction: 'client-to-host' as const,
      directionalKeyId: 'key-1',
    }
    const key = await deriveSessionMaterial(ikm, context, 'aes-key')
    const prefix = await deriveSessionMaterial(ikm, context, 'nonce-prefix')
    const attachmentKey = await deriveSessionMaterial(ikm, context, 'attachment-key')
    const oppositeDirection = await deriveSessionMaterial(
      ikm,
      { ...context, direction: 'host-to-client' },
      'aes-key',
    )
    const nextGeneration = await deriveSessionMaterial(
      ikm,
      { ...context, generation: 8 },
      'aes-key',
    )
    expect(key).toHaveLength(32)
    expect(prefix).toHaveLength(4)
    expect(attachmentKey).toHaveLength(32)
    expect(oppositeDirection).not.toEqual(key)
    expect(nextGeneration).not.toEqual(key)
  })

  it('computes and verifies 32-byte HMAC without exporting a key handle', async () => {
    const key = randomBytes32()
    const message = encoder.encode('join claims')
    const mac = await hmacSha256(key, message)
    expect(mac).toHaveLength(32)
    expect(await verifyHmacSha256(key, message, mac)).toBe(true)
    mac[31] ^= 1
    expect(await verifyHmacSha256(key, message, mac)).toBe(false)
  })
})

describe('AES-256-GCM', () => {
  it('builds a 4-byte prefix plus uint64be positive safe sequence', () => {
    const prefix = Uint8Array.of(0x01, 0x23, 0x45, 0x67)
    expect(buildAesGcmIv(prefix, 1n)).toEqual(Uint8Array.of(
      0x01, 0x23, 0x45, 0x67,
      0, 0, 0, 0, 0, 0, 0, 1,
    ))
    expect(buildAesGcmIv(prefix, BigInt(Number.MAX_SAFE_INTEGER))).toEqual(Uint8Array.of(
      0x01, 0x23, 0x45, 0x67,
      0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ))
    expect(() => buildAesGcmIv(prefix, 0n)).toThrowError(new E2eeError('sequence-out-of-range'))
    expect(() => buildAesGcmIv(prefix, -1n)).toThrowError(new E2eeError('sequence-out-of-range'))
    expect(() => buildAesGcmIv(prefix, BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrowError(new E2eeError('sequence-out-of-range'))
  })

  it('uses a 128-bit tag and fails with a fixed error after tampering', async () => {
    const rawKey = randomBytes32()
    const encryptKey = await importAes256GcmKey(rawKey, 'encrypt')
    const decryptKey = await importAes256GcmKey(rawKey, 'decrypt')
    rawKey.fill(0)
    expect(encryptKey).toMatchObject({
      type: 'secret',
      extractable: false,
      usages: ['encrypt'],
    })
    const prefix = Uint8Array.of(1, 2, 3, 4)
    const aad = encoder.encode('fixed aad')
    const plaintext = encoder.encode('private payload')
    const ciphertext = await encryptAes256Gcm(encryptKey, prefix, 1n, aad, plaintext)
    expect(ciphertext.byteLength).toBe(plaintext.byteLength + 16)
    expect(await decryptAes256Gcm(decryptKey, prefix, 1n, aad, ciphertext)).toEqual(plaintext)

    ciphertext[ciphertext.length - 1] ^= 1
    const rejection = await decryptAes256Gcm(decryptKey, prefix, 1n, aad, ciphertext).catch(error => error)
    expect(rejection).toEqual(new E2eeError('authentication-failed'))
    expect(rejection).not.toHaveProperty('cause')
  })

  it('accepts the routed plaintext maximum and rejects one byte more', async () => {
    const key = await importAes256GcmKey(randomBytes32(), 'encrypt')
    const prefix = randomBytes16().subarray(0, 4)
    const maximum = new Uint8Array(MAX_AES_GCM_PLAINTEXT_BYTES)
    const ciphertext = await encryptAes256Gcm(key, prefix, 2n, new Uint8Array(), maximum)
    expect(ciphertext).toHaveLength(MAX_AES_GCM_PLAINTEXT_BYTES + 16)
    await expect(
      encryptAes256Gcm(key, prefix, 3n, new Uint8Array(), new Uint8Array(MAX_AES_GCM_PLAINTEXT_BYTES + 1)),
    ).rejects.toEqual(new E2eeError('invalid-length'))
  })
})
