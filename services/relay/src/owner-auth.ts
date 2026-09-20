import {
  randomBytes as randomBytesCallback,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'

const USERNAME_MAX_BYTES = 128
const PASSWORD_MIN_BYTES = 8
const PASSWORD_MAX_BYTES = 1_024
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const MAX_SESSIONS = 8
const FAILURE_WINDOW_MS = 60_000
const MAX_FAILURES = 5
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 32 * 1_024 * 1_024 })
const BASE64URL_16 = /^[A-Za-z0-9_-]{22}$/
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/

export const OWNER_SESSION_COOKIE = '__Host-codex_plus_owner'

export interface OwnerPasswordVerifier {
  readonly version: 1
  readonly username: string
  readonly kdf: 'scrypt'
  readonly salt: string
  readonly derivedKey: string
}

export type OwnerLoginResult =
  | Readonly<{ state: 'authenticated'; username: string; setCookie: string }>
  | Readonly<{ state: 'invalid' }>
  | Readonly<{ state: 'rate-limited' }>

export class OwnerAuthError extends Error {
  constructor(readonly code: 'invalid-verifier' | 'invalid-credentials') {
    super(`owner-auth:${code}`)
    this.name = 'OwnerAuthError'
  }
}

function fail(code: OwnerAuthError['code']): never {
  throw new OwnerAuthError(code)
}

function boundedText(value: unknown, minimumBytes: number, maximumBytes: number): string {
  if (
    typeof value !== 'string'
    || value.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) fail('invalid-credentials')
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < minimumBytes || bytes > maximumBytes) fail('invalid-credentials')
  return value
}

function username(value: unknown): string {
  return boundedText(value, 1, USERNAME_MAX_BYTES)
}

function password(value: unknown): string {
  return boundedText(value, PASSWORD_MIN_BYTES, PASSWORD_MAX_BYTES)
}

function exactBase64Url(value: unknown, pattern: RegExp, bytes: number): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail('invalid-verifier')
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.byteLength !== bytes || decoded.toString('base64url') !== value) fail('invalid-verifier')
  return value
}

export function parseOwnerPasswordVerifier(value: unknown): OwnerPasswordVerifier {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid-verifier')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 5
    || keys[0] !== 'derivedKey'
    || keys[1] !== 'kdf'
    || keys[2] !== 'salt'
    || keys[3] !== 'username'
    || keys[4] !== 'version'
    || record.version !== 1
    || record.kdf !== 'scrypt'
  ) fail('invalid-verifier')
  let parsedUsername: string
  try {
    parsedUsername = username(record.username)
  } catch {
    return fail('invalid-verifier')
  }
  return Object.freeze({
    version: 1,
    username: parsedUsername,
    kdf: 'scrypt',
    salt: exactBase64Url(record.salt, BASE64URL_16, 16),
    derivedKey: exactBase64Url(record.derivedKey, BASE64URL_32, 32),
  })
}

async function derive(passwordText: string, salt: Buffer): Promise<Buffer> {
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scryptCallback(passwordText, salt, 32, SCRYPT_OPTIONS, (error, derivedKey) => {
        if (error !== null) reject(error)
        else resolve(Buffer.from(derivedKey))
      })
    })
  } catch {
    return fail('invalid-credentials')
  }
}

export async function createOwnerPasswordVerifier(
  input: Readonly<{ username: string; password: string }>,
  randomBytes: (length: number) => Buffer = randomBytesCallback,
): Promise<OwnerPasswordVerifier> {
  const selectedUsername = username(input.username)
  const selectedPassword = password(input.password)
  const salt = randomBytes(16)
  if (!Buffer.isBuffer(salt) || salt.byteLength !== 16) fail('invalid-credentials')
  const derivedKey = await derive(selectedPassword, salt)
  try {
    return Object.freeze({
      version: 1,
      username: selectedUsername,
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      derivedKey: derivedKey.toString('base64url'),
    })
  } finally {
    salt.fill(0)
    derivedKey.fill(0)
  }
}

async function verifyCredentials(
  verifier: OwnerPasswordVerifier,
  suppliedUsername: unknown,
  suppliedPassword: unknown,
): Promise<boolean> {
  let checkedPassword: string
  let checkedUsername: string
  try {
    checkedUsername = username(suppliedUsername)
    checkedPassword = password(suppliedPassword)
  } catch {
    return false
  }
  const expected = Buffer.from(verifier.derivedKey, 'base64url')
  const salt = Buffer.from(verifier.salt, 'base64url')
  const actual = await derive(checkedPassword, salt).catch(() => Buffer.alloc(32))
  try {
    return timingSafeEqual(actual, expected) && checkedUsername === verifier.username
  } finally {
    expected.fill(0)
    salt.fill(0)
    actual.fill(0)
  }
}

function cookieToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined || cookieHeader.length > 4_096) return undefined
  const matches: string[] = []
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    const name = part.slice(0, separator).trim()
    if (name !== OWNER_SESSION_COOKIE) continue
    matches.push(part.slice(separator + 1).trim())
  }
  if (matches.length !== 1 || !BASE64URL_32.test(matches[0]!)) return undefined
  return matches[0]
}

export class OwnerSessionAuthority {
  readonly #verifier: OwnerPasswordVerifier
  readonly #now: () => number
  readonly #randomBytes: (length: number) => Buffer
  readonly #sessions = new Map<string, Readonly<{ username: string; createdAt: number; expiresAt: number }>>()
  readonly #failures: number[] = []

  constructor(input: Readonly<{
    verifier: OwnerPasswordVerifier
    now?: () => number
    randomBytes?: (length: number) => Buffer
  }>) {
    this.#verifier = parseOwnerPasswordVerifier(input.verifier)
    this.#now = input.now ?? Date.now
    this.#randomBytes = input.randomBytes ?? randomBytesCallback
  }

  async login(suppliedUsername: unknown, suppliedPassword: unknown): Promise<OwnerLoginResult> {
    const now = this.#safeNow()
    this.#sweep(now)
    while (this.#failures.length > 0 && this.#failures[0]! <= now - FAILURE_WINDOW_MS) {
      this.#failures.shift()
    }
    if (this.#failures.length >= MAX_FAILURES) return Object.freeze({ state: 'rate-limited' })
    if (!await verifyCredentials(this.#verifier, suppliedUsername, suppliedPassword)) {
      this.#failures.push(now)
      return Object.freeze({ state: 'invalid' })
    }
    this.#failures.length = 0
    const tokenBytes = this.#randomBytes(32)
    if (!Buffer.isBuffer(tokenBytes) || tokenBytes.byteLength !== 32) fail('invalid-credentials')
    const token = tokenBytes.toString('base64url')
    tokenBytes.fill(0)
    if (!BASE64URL_32.test(token) || this.#sessions.has(token)) fail('invalid-credentials')
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.#sessions.entries()]
        .sort((left, right) => left[1].createdAt - right[1].createdAt)[0]
      if (oldest === undefined) break
      this.#sessions.delete(oldest[0])
    }
    this.#sessions.set(token, Object.freeze({
      username: this.#verifier.username,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    }))
    return Object.freeze({
      state: 'authenticated',
      username: this.#verifier.username,
      setCookie: `${OWNER_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1_000}`,
    })
  }

  session(cookieHeader: string | undefined): Readonly<{ authenticated: true; username: string }> | undefined {
    const now = this.#safeNow()
    this.#sweep(now)
    const token = cookieToken(cookieHeader)
    if (token === undefined) return undefined
    const session = this.#sessions.get(token)
    return session === undefined
      ? undefined
      : Object.freeze({ authenticated: true, username: session.username })
  }

  logout(cookieHeader: string | undefined): string {
    const token = cookieToken(cookieHeader)
    if (token !== undefined) this.#sessions.delete(token)
    return `${OWNER_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`
  }

  close(): void {
    this.#sessions.clear()
    this.#failures.length = 0
  }

  #safeNow(): number {
    const value = this.#now()
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid-credentials')
    return value
  }

  #sweep(now: number): void {
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(token)
    }
  }
}
