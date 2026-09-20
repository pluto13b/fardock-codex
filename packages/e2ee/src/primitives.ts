import {
  AES_GCM_TAG_BYTES,
  MAX_APPLICATION_BYTES,
  MAX_CIPHERTEXT_BYTES,
  encodeAgreementProofInfo,
  encodeBase64Url,
  encodePairingKdfInfo,
  encodeSessionKdfInfo,
  type PairingKdfPurpose as ProtocolPairingKdfPurpose,
  type SessionDirection,
  type SessionKdfPurpose as ProtocolSessionKdfPurpose,
} from '@codex-plus/protocol'

import {
  assertAgreementPrivateKey,
  assertAgreementPublicKey,
  assertSigningPrivateKey,
  assertSigningPublicKey,
} from './keys.ts'
import { E2eeError, failE2ee, getWebCrypto } from './runtime.ts'

const MAX_PROTOCOL_SEQUENCE = BigInt(Number.MAX_SAFE_INTEGER)

export const MAX_AES_GCM_PLAINTEXT_BYTES = MAX_APPLICATION_BYTES
export const MAX_AES_GCM_CIPHERTEXT_BYTES = MAX_CIPHERTEXT_BYTES

export type PairingKdfPurpose = ProtocolPairingKdfPurpose

export interface SessionKdfContext {
  readonly transcriptHash32: Uint8Array
  readonly hostId: string
  readonly hostDeviceId: string
  readonly clientDeviceId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly generation: number
  readonly direction: SessionDirection
  readonly directionalKeyId: string
}

export type SessionKdfPurpose = ProtocolSessionKdfPurpose

function byteView(value: Uint8Array): Uint8Array<ArrayBuffer> {
  try {
    if (
      !ArrayBuffer.isView(value)
      || Object.prototype.toString.call(value) !== '[object Uint8Array]'
      || Object.prototype.toString.call(value.buffer) === '[object SharedArrayBuffer]'
    ) {
      return failE2ee('invalid-length')
    }
    return new Uint8Array(
      value.buffer as ArrayBuffer,
      value.byteOffset,
      value.byteLength,
    )
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('invalid-length')
  }
}

function snapshotBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const source = byteView(value)
  const snapshot = new Uint8Array(source.byteLength)
  snapshot.set(source)
  return snapshot
}

function requireLength(value: Uint8Array, length: number): Uint8Array<ArrayBuffer> {
  const bytes = byteView(value)
  if (bytes.byteLength !== length) {
    return failE2ee('invalid-length')
  }
  return bytes
}

export async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = byteView(value)
  try {
    return new Uint8Array(await getWebCrypto().subtle.digest('SHA-256', input))
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  }
}

export async function deriveEcdhSecret(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  assertAgreementPrivateKey(privateKey)
  assertAgreementPublicKey(publicKey)
  try {
    const bits = await getWebCrypto().subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256,
    )
    const secret = new Uint8Array(bits)
    if (secret.byteLength !== 32) return failE2ee('crypto-operation-failed')
    return secret
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  }
}

export async function signP256(
  privateKey: CryptoKey,
  value: Uint8Array,
): Promise<Uint8Array> {
  assertSigningPrivateKey(privateKey)
  try {
    const signature = new Uint8Array(await getWebCrypto().subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      byteView(value),
    ))
    if (signature.byteLength !== 64) return failE2ee('crypto-operation-failed')
    return signature
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  }
}

export async function verifyP256(
  publicKey: CryptoKey,
  value: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  assertSigningPublicKey(publicKey)
  let signatureBytes: Uint8Array<ArrayBuffer>
  try {
    signatureBytes = byteView(signature)
  } catch {
    return false
  }
  if (signatureBytes.byteLength !== 64) return false
  try {
    return await getWebCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signatureBytes,
      byteView(value),
    )
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return false
  }
}

async function deriveHkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  byteLength: number,
): Promise<Uint8Array> {
  const ikmSnapshot = snapshotBytes(ikm)
  const saltSnapshot = snapshotBytes(salt)
  const infoSnapshot = snapshotBytes(info)
  try {
    const key = await getWebCrypto().subtle.importKey(
      'raw',
      ikmSnapshot,
      'HKDF',
      false,
      ['deriveBits'],
    )
    const bits = await getWebCrypto().subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: saltSnapshot, info: infoSnapshot },
      key,
      byteLength * 8,
    )
    const output = new Uint8Array(bits)
    if (output.byteLength !== byteLength) return failE2ee('crypto-operation-failed')
    return output
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  } finally {
    ikmSnapshot.fill(0)
    saltSnapshot.fill(0)
    infoSnapshot.fill(0)
  }
}

export function derivePairingMaterial(
  sharedSecret: Uint8Array,
  rendezvousSecret: Uint8Array,
  pairingTranscriptHash: Uint8Array,
  purpose: PairingKdfPurpose,
): Promise<Uint8Array> {
  const ikm = requireLength(sharedSecret, 32)
  const salt = requireLength(rendezvousSecret, 32)
  const transcriptHash = requireLength(pairingTranscriptHash, 32)
  let byteLength: 4 | 32
  switch (purpose) {
    case 'client-to-host-key':
    case 'host-to-client-key':
    case 'sas-key':
      byteLength = 32
      break
    case 'client-to-host-nonce-prefix':
    case 'host-to-client-nonce-prefix':
      byteLength = 4
      break
    default:
      return failE2ee('invalid-length')
  }
  let info: Uint8Array
  try {
    info = encodePairingKdfInfo({
      pairingTranscriptHash: encodeBase64Url(transcriptHash),
      purpose,
    })
  } catch {
    return failE2ee('invalid-length')
  }
  return deriveHkdf(ikm, salt, info, byteLength)
}

export function deriveAgreementProofKey(
  sharedSecret: Uint8Array,
  rendezvousSecret: Uint8Array,
  pairingTranscriptHash: Uint8Array,
  joinClaimsHash: Uint8Array,
): Promise<Uint8Array> {
  const ikm = requireLength(sharedSecret, 32)
  const salt = requireLength(rendezvousSecret, 32)
  const transcriptHash = requireLength(pairingTranscriptHash, 32)
  const claimsHash = requireLength(joinClaimsHash, 32)
  let info: Uint8Array
  try {
    info = encodeAgreementProofInfo({
      pairingTranscriptHash: encodeBase64Url(transcriptHash),
      joinClaimsHash: encodeBase64Url(claimsHash),
    })
  } catch {
    return failE2ee('invalid-length')
  }
  return deriveHkdf(ikm, salt, info, 32)
}

export function deriveSessionMaterial(
  connectionIkm64: Uint8Array,
  context: SessionKdfContext,
  purpose: SessionKdfPurpose,
): Promise<Uint8Array> {
  if (context === null || typeof context !== 'object') return failE2ee('invalid-length')
  const ikm = requireLength(connectionIkm64, 64)
  const transcriptHash = requireLength(context.transcriptHash32, 32)
  let info: Uint8Array
  try {
    info = encodeSessionKdfInfo({
      sessionTranscriptHash: encodeBase64Url(transcriptHash),
      hostId: context.hostId,
      hostDeviceId: context.hostDeviceId,
      clientDeviceId: context.clientDeviceId,
      authorizationId: context.authorizationId,
      authorizationEpoch: context.authorizationEpoch,
      connectionGeneration: context.generation,
      direction: context.direction,
      keyId: context.directionalKeyId,
      purpose,
    })
  } catch {
    return failE2ee('invalid-length')
  }
  return deriveHkdf(
    ikm,
    transcriptHash,
    info,
    purpose === 'nonce-prefix' ? 4 : 32,
  )
}

export async function hmacSha256(
  keyBytes: Uint8Array,
  value: Uint8Array,
): Promise<Uint8Array> {
  const rawKey = snapshotBytes(requireLength(keyBytes, 32))
  const message = snapshotBytes(value)
  try {
    const key = await getWebCrypto().subtle.importKey(
      'raw',
      rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    const mac = new Uint8Array(await getWebCrypto().subtle.sign(
      'HMAC',
      key,
      message,
    )).slice()
    if (mac.byteLength !== 32) return failE2ee('crypto-operation-failed')
    return mac
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  } finally {
    rawKey.fill(0)
    message.fill(0)
  }
}

export async function verifyHmacSha256(
  keyBytes: Uint8Array,
  value: Uint8Array,
  mac: Uint8Array,
): Promise<boolean> {
  const rawKey = snapshotBytes(requireLength(keyBytes, 32))
  let expectedMac: Uint8Array<ArrayBuffer>
  try {
    expectedMac = snapshotBytes(mac)
  } catch {
    rawKey.fill(0)
    return false
  }
  if (expectedMac.byteLength !== 32) {
    rawKey.fill(0)
    expectedMac.fill(0)
    return false
  }
  let message: Uint8Array<ArrayBuffer>
  try {
    message = snapshotBytes(value)
  } catch {
    rawKey.fill(0)
    expectedMac.fill(0)
    return false
  }
  try {
    const key = await getWebCrypto().subtle.importKey(
      'raw',
      rawKey,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return await getWebCrypto().subtle.verify(
      'HMAC',
      key,
      expectedMac,
      message,
    )
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return false
  } finally {
    rawKey.fill(0)
    expectedMac.fill(0)
    message.fill(0)
  }
}

export async function importAes256GcmKey(
  raw: Uint8Array,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> {
  const bytes = requireLength(raw, 32)
  if (usage !== 'encrypt' && usage !== 'decrypt') return failE2ee('invalid-key')
  try {
    const key = await getWebCrypto().subtle.importKey(
      'raw',
      bytes,
      'AES-GCM',
      false,
      [usage],
    )
    if (
      key.type !== 'secret'
      || key.extractable
      || key.algorithm.name !== 'AES-GCM'
      || key.usages.length !== 1
      || key.usages[0] !== usage
    ) {
      return failE2ee('crypto-operation-failed')
    }
    return key
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('invalid-key')
  }
}

function assertAesGcmKey(key: CryptoKey, usage: 'encrypt' | 'decrypt'): void {
  const algorithm = key.algorithm as AesKeyAlgorithm
  if (
    key.type !== 'secret'
    || key.extractable
    || algorithm.name !== 'AES-GCM'
    || algorithm.length !== 256
    || key.usages.length !== 1
    || key.usages[0] !== usage
  ) {
    failE2ee('invalid-key')
  }
}

export function buildAesGcmIv(
  noncePrefix: Uint8Array,
  sequence: bigint,
): Uint8Array<ArrayBuffer> {
  const prefix = requireLength(noncePrefix, 4)
  if (
    typeof sequence !== 'bigint'
    || sequence < 1n
    || sequence > MAX_PROTOCOL_SEQUENCE
  ) {
    return failE2ee('sequence-out-of-range')
  }
  const iv = new Uint8Array(12)
  iv.set(prefix, 0)
  new DataView(iv.buffer).setBigUint64(4, sequence, false)
  return iv
}

export async function encryptAes256Gcm(
  key: CryptoKey,
  noncePrefix: Uint8Array,
  sequence: bigint,
  additionalData: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  assertAesGcmKey(key, 'encrypt')
  const plaintextBytes = byteView(plaintext)
  const additionalDataBytes = byteView(additionalData)
  if (plaintextBytes.byteLength > MAX_AES_GCM_PLAINTEXT_BYTES) return failE2ee('invalid-length')
  const iv = buildAesGcmIv(noncePrefix, sequence)
  try {
    const result = new Uint8Array(await getWebCrypto().subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalDataBytes, tagLength: 128 },
      key,
      plaintextBytes,
    ))
    if (result.byteLength !== plaintextBytes.byteLength + AES_GCM_TAG_BYTES) {
      return failE2ee('crypto-operation-failed')
    }
    return result
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  }
}

export async function decryptAes256Gcm(
  key: CryptoKey,
  noncePrefix: Uint8Array,
  sequence: bigint,
  additionalData: Uint8Array,
  ciphertextAndTag: Uint8Array,
): Promise<Uint8Array> {
  assertAesGcmKey(key, 'decrypt')
  const ciphertextBytes = byteView(ciphertextAndTag)
  const additionalDataBytes = byteView(additionalData)
  if (
    ciphertextBytes.byteLength < AES_GCM_TAG_BYTES
    || ciphertextBytes.byteLength > MAX_AES_GCM_CIPHERTEXT_BYTES
  ) {
    return failE2ee('invalid-length')
  }
  const iv = buildAesGcmIv(noncePrefix, sequence)
  try {
    return new Uint8Array(await getWebCrypto().subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalDataBytes, tagLength: 128 },
      key,
      ciphertextBytes,
    ))
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('authentication-failed')
  }
}
