import {
  encodeBase64Url,
  encodeP256JwkThumbprintInput,
  type P256PublicJwk,
} from '@codex-plus/protocol'

import { exportPublicJwk, importSigningPublicKey } from './keys.ts'
import { sha256 } from './primitives.ts'

export async function fingerprintP256PublicJwk(value: unknown): Promise<string> {
  // Importing first makes WebCrypto validate that x/y identify a real P-256 point.
  const key = await importSigningPublicKey(value)
  const normalized = await exportPublicJwk(key)
  const input = encodeP256JwkThumbprintInput(normalized)
  return encodeBase64Url(await sha256(input))
}

export async function fingerprintP256PublicKey(key: CryptoKey): Promise<string> {
  const jwk: P256PublicJwk = await exportPublicJwk(key)
  return fingerprintP256PublicJwk(jwk)
}
