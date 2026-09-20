import {
  P256PublicJwkSchema,
  type P256PublicJwk,
} from '@codex-plus/protocol'

import { E2eeError, failE2ee, getWebCrypto } from './runtime.ts'

type EcKeyAlgorithm = KeyAlgorithm & { readonly namedCurve?: string }

function hasExactUsages(key: CryptoKey, expected: readonly KeyUsage[]): boolean {
  return key.usages.length === expected.length
    && expected.every(usage => key.usages.includes(usage))
}

function isP256Key(key: CryptoKey, algorithmName: 'ECDH' | 'ECDSA'): boolean {
  const algorithm = key.algorithm as EcKeyAlgorithm
  return algorithm.name === algorithmName && algorithm.namedCurve === 'P-256'
}

function parsePublicJwk(value: unknown): P256PublicJwk {
  try {
    const result = P256PublicJwkSchema.safeParse(value)
    if (!result.success) return failE2ee('invalid-key')
    return result.data
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('invalid-key')
  }
}

function assertGeneratedPair(
  value: CryptoKeyPair | CryptoKey,
  algorithmName: 'ECDH' | 'ECDSA',
  privateUsage: 'deriveBits' | 'sign',
  publicUsages: readonly KeyUsage[],
): CryptoKeyPair {
  if (!('privateKey' in value) || !('publicKey' in value)) {
    return failE2ee('crypto-operation-failed')
  }
  if (
    value.privateKey.type !== 'private'
    || value.privateKey.extractable
    || !isP256Key(value.privateKey, algorithmName)
    || !hasExactUsages(value.privateKey, [privateUsage])
    || value.publicKey.type !== 'public'
    || !value.publicKey.extractable
    || !isP256Key(value.publicKey, algorithmName)
    || !hasExactUsages(value.publicKey, publicUsages)
  ) {
    return failE2ee('crypto-operation-failed')
  }
  return value
}

export async function generateAgreementKeyPair(): Promise<CryptoKeyPair> {
  try {
    const pair = await getWebCrypto().subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )
    return assertGeneratedPair(pair, 'ECDH', 'deriveBits', [])
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  }
}

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  try {
    const pair = await getWebCrypto().subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    return assertGeneratedPair(pair, 'ECDSA', 'sign', ['verify'])
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('crypto-operation-failed')
  }
}

async function importPublicKey(
  value: unknown,
  algorithmName: 'ECDH' | 'ECDSA',
): Promise<CryptoKey> {
  const jwk = parsePublicJwk(value)
  const usages: KeyUsage[] = algorithmName === 'ECDSA' ? ['verify'] : []
  try {
    const key = await getWebCrypto().subtle.importKey(
      'jwk',
      jwk,
      { name: algorithmName, namedCurve: 'P-256' },
      true,
      usages,
    )
    if (
      key.type !== 'public'
      || !key.extractable
      || !isP256Key(key, algorithmName)
      || !hasExactUsages(key, usages)
    ) {
      return failE2ee('invalid-key')
    }
    return key
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('invalid-key')
  }
}

export function importAgreementPublicKey(value: unknown): Promise<CryptoKey> {
  return importPublicKey(value, 'ECDH')
}

export function importSigningPublicKey(value: unknown): Promise<CryptoKey> {
  return importPublicKey(value, 'ECDSA')
}

export async function exportPublicJwk(key: CryptoKey): Promise<P256PublicJwk> {
  if (
    key.type !== 'public'
    || !key.extractable
    || (!isP256Key(key, 'ECDH') && !isP256Key(key, 'ECDSA'))
  ) {
    return failE2ee('invalid-key')
  }
  try {
    const exported = await getWebCrypto().subtle.exportKey('jwk', key)
    return parsePublicJwk({
      kty: exported.kty,
      crv: exported.crv,
      x: exported.x,
      y: exported.y,
    })
  } catch (error) {
    if (error instanceof E2eeError) throw error
    return failE2ee('invalid-key')
  }
}

export function assertAgreementPrivateKey(key: CryptoKey): void {
  if (
    key.type !== 'private'
    || key.extractable
    || !isP256Key(key, 'ECDH')
    || !hasExactUsages(key, ['deriveBits'])
  ) {
    failE2ee('invalid-key')
  }
}

export function assertAgreementPublicKey(key: CryptoKey): void {
  if (
    key.type !== 'public'
    || !isP256Key(key, 'ECDH')
    || !hasExactUsages(key, [])
  ) {
    failE2ee('invalid-key')
  }
}

export function assertSigningPrivateKey(key: CryptoKey): void {
  if (
    key.type !== 'private'
    || key.extractable
    || !isP256Key(key, 'ECDSA')
    || !hasExactUsages(key, ['sign'])
  ) {
    failE2ee('invalid-key')
  }
}

export function assertSigningPublicKey(key: CryptoKey): void {
  if (
    key.type !== 'public'
    || !isP256Key(key, 'ECDSA')
    || !hasExactUsages(key, ['verify'])
  ) {
    failE2ee('invalid-key')
  }
}
