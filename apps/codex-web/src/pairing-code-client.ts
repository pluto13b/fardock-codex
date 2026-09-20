const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8

export interface PairingCodeRegistration {
  readonly code: string
  readonly expiresAt: number
}

export interface RedeemedPairingInvitation {
  readonly invitationFragment: string
  readonly expiresAt: number
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function normalizePairingCode(value: string): string {
  return value
    .toUpperCase()
    .replace(/[IL]/gu, '1')
    .replace(/O/gu, '0')
    .replace(/[^0-9A-HJKMNP-TV-Z]/gu, '')
    .slice(0, CODE_LENGTH)
}

function isPairingCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length === CODE_LENGTH
    && [...value].every(character => CODE_ALPHABET.includes(character))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function registration(value: unknown): PairingCodeRegistration | undefined {
  const parsed = record(value)
  if (parsed === undefined || Object.keys(parsed).sort().join(',') !== 'code,expiresAt,ok') return undefined
  return parsed.ok === true
    && isPairingCode(parsed.code)
    && Number.isSafeInteger(parsed.expiresAt)
    ? Object.freeze({ code: parsed.code, expiresAt: parsed.expiresAt as number })
    : undefined
}

function invitation(value: unknown): RedeemedPairingInvitation | undefined {
  const parsed = record(value)
  if (
    parsed === undefined
    || Object.keys(parsed).sort().join(',') !== 'expiresAt,invitationFragment,ok'
  ) return undefined
  return parsed.ok === true
    && typeof parsed.invitationFragment === 'string'
    && parsed.invitationFragment.length > 0
    && parsed.invitationFragment.length <= 16 * 1_024
    && Number.isSafeInteger(parsed.expiresAt)
    ? Object.freeze({
        invitationFragment: parsed.invitationFragment,
        expiresAt: parsed.expiresAt as number,
      })
    : undefined
}

export async function registerPairingCode(
  input: Readonly<{ invitationFragment: string; expiresAt: number }>,
  fetcher: Fetcher = fetch,
): Promise<PairingCodeRegistration> {
  const response = await fetcher('/api/pairing-code/register', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const parsed = registration(await response.json().catch(() => undefined))
  if (!response.ok || parsed === undefined) throw new Error('pairing-code-register-failed')
  return parsed
}

export async function redeemPairingCode(
  code: string,
  fetcher: Fetcher = fetch,
): Promise<RedeemedPairingInvitation | undefined> {
  const response = await fetcher('/api/pairing-code/redeem', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: normalizePairingCode(code) }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (response.status === 404) return undefined
  const parsed = invitation(value)
  if (!response.ok || parsed === undefined) throw new Error('pairing-code-redeem-failed')
  return parsed
}
