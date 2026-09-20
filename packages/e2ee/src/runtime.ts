export type E2eeErrorCode =
  | 'authentication-failed'
  | 'crypto-operation-failed'
  | 'crypto-unavailable'
  | 'invalid-key'
  | 'invalid-length'
  | 'sequence-out-of-range'

const errorMessages: Readonly<Record<E2eeErrorCode, string>> = {
  'authentication-failed': 'Cryptographic authentication failed.',
  'crypto-operation-failed': 'Cryptographic operation failed.',
  'crypto-unavailable': 'Web Crypto is unavailable.',
  'invalid-key': 'Invalid cryptographic key.',
  'invalid-length': 'Invalid cryptographic input length.',
  'sequence-out-of-range': 'Sequence is outside the uint64 range.',
}

export class E2eeError extends Error {
  readonly code: E2eeErrorCode

  constructor(code: E2eeErrorCode) {
    super(errorMessages[code])
    this.name = 'E2eeError'
    this.code = code
  }
}

export function failE2ee(code: E2eeErrorCode): never {
  throw new E2eeError(code)
}

export function getWebCrypto(): Crypto {
  const crypto = globalThis.crypto
  if (
    crypto === undefined
    || crypto.subtle === undefined
    || typeof crypto.getRandomValues !== 'function'
  ) {
    return failE2ee('crypto-unavailable')
  }
  return crypto
}

function randomBytes(length: 16 | 32): Uint8Array {
  const output = new Uint8Array(length)
  try {
    getWebCrypto().getRandomValues(output)
    return output
  } catch {
    return failE2ee('crypto-operation-failed')
  }
}

export function randomBytes16(): Uint8Array {
  return randomBytes(16)
}

export function randomBytes32(): Uint8Array {
  return randomBytes(32)
}
