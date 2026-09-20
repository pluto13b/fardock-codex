import { randomBytes as randomBytesCallback } from 'node:crypto'

import { decodePairingInvitationFragment } from '@codex-plus/protocol'

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const MAX_CODES = 8
const MAX_TTL_MS = 5 * 60 * 1_000

export interface RegisteredPairingCode {
  readonly code: string
  readonly expiresAt: number
}

export interface RedeemedPairingCode {
  readonly invitationFragment: string
  readonly expiresAt: number
}

function normalizeCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32) return undefined
  const code = value.trim().toUpperCase()
    .replace(/[IL]/gu, '1')
    .replace(/O/gu, '0')
    .replace(/[\s-]/gu, '')
  return code.length === CODE_LENGTH && [...code].every(character => CODE_ALPHABET.includes(character))
    ? code
    : undefined
}

export class PairingCodeAuthority {
  readonly #publicOrigin: string
  readonly #now: () => number
  readonly #randomBytes: (length: number) => Buffer
  readonly #codes = new Map<string, { invitation: RedeemedPairingCode; pairSessionId: string }>()

  constructor(input: Readonly<{
    publicOrigin: string
    now?: () => number
    randomBytes?: (length: number) => Buffer
  }>) {
    this.#publicOrigin = input.publicOrigin
    this.#now = input.now ?? Date.now
    this.#randomBytes = input.randomBytes ?? randomBytesCallback
  }

  register(invitationFragment: unknown, suppliedExpiresAt: unknown): RegisteredPairingCode {
    const now = this.#safeNow()
    this.#sweep(now)
    if (this.#codes.size >= MAX_CODES) throw new Error('pairing-code:capacity')
    if (typeof invitationFragment !== 'string' || invitationFragment.length > 16 * 1_024) {
      throw new Error('pairing-code:invalid')
    }
    let invitation
    try {
      invitation = decodePairingInvitationFragment(invitationFragment, this.#publicOrigin, now)
    } catch {
      throw new Error('pairing-code:invalid')
    }
    if (
      !Number.isSafeInteger(suppliedExpiresAt)
      || suppliedExpiresAt !== invitation.expiresAt
      || invitation.expiresAt <= now
      || invitation.expiresAt > now + MAX_TTL_MS
    ) throw new Error('pairing-code:invalid')

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.#randomBytes(CODE_LENGTH)
      if (!Buffer.isBuffer(bytes) || bytes.byteLength !== CODE_LENGTH) throw new Error('pairing-code:random')
      let code = ''
      for (const byte of bytes) code += CODE_ALPHABET[byte & 31]!
      bytes.fill(0)
      if (this.#codes.has(code)) continue
      this.#codes.set(code, {
        invitation: Object.freeze({ invitationFragment, expiresAt: invitation.expiresAt }),
        pairSessionId: invitation.pairSessionId,
      })
      return Object.freeze({ code, expiresAt: invitation.expiresAt })
    }
    throw new Error('pairing-code:collision')
  }

  redeem(value: unknown): RedeemedPairingCode | undefined {
    const now = this.#safeNow()
    this.#sweep(now)
    const code = normalizeCode(value)
    if (code === undefined) return undefined
    const invitation = this.#codes.get(code)
    if (invitation !== undefined) this.#codes.delete(code)
    return invitation?.invitation
  }

  revoke(pairSessionId: string): void {
    for (const [code, entry] of this.#codes) {
      if (entry.pairSessionId === pairSessionId) this.#codes.delete(code)
    }
  }

  close(): void {
    this.#codes.clear()
  }

  #safeNow(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('pairing-code:clock')
    return value
  }

  #sweep(now: number): void {
    for (const [code, invitation] of this.#codes) {
      if (invitation.invitation.expiresAt <= now) this.#codes.delete(code)
    }
  }
}
