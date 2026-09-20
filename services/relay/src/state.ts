import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'

export const MAX_RELAY_STATE_BYTES = 4 * 1024

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const digestPattern = /^[A-Za-z0-9_-]{43}$/
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const dummyDigest = Buffer.alloc(32)

export interface RegisteredHostState {
  stateVersion: 1
  registrationClosed: true
  hostId: string
  deviceId: string
  sessionCredentialDigest: string
}

export class RelayStateError extends Error {
  constructor() {
    super('Relay state operation failed.')
    this.name = 'RelayStateError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeDigest(value: string): Buffer | undefined {
  if (!digestPattern.test(value)) return undefined

  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) return undefined
    return decoded
  } catch {
    return undefined
  }
}

function normalizeState(value: unknown): RegisteredHostState | undefined {
  if (!isRecord(value)) return undefined

  const expectedKeys = [
    'stateVersion',
    'registrationClosed',
    'hostId',
    'deviceId',
    'sessionCredentialDigest',
  ]
  const keys = Object.keys(value)
  if (keys.length !== expectedKeys.length || !keys.every(key => expectedKeys.includes(key))) {
    return undefined
  }
  if (value.stateVersion !== 1 || value.registrationClosed !== true) return undefined
  if (typeof value.hostId !== 'string' || !identifierPattern.test(value.hostId)) return undefined
  if (typeof value.deviceId !== 'string' || !identifierPattern.test(value.deviceId)) return undefined
  if (
    typeof value.sessionCredentialDigest !== 'string'
    || decodeDigest(value.sessionCredentialDigest) === undefined
  ) {
    return undefined
  }

  return {
    stateVersion: 1,
    registrationClosed: true,
    hostId: value.hostId,
    deviceId: value.deviceId,
    sessionCredentialDigest: value.sessionCredentialDigest,
  }
}

function encodeState(value: unknown): string {
  const state = normalizeState(value)
  if (state === undefined) throw new RelayStateError()

  const encoded = JSON.stringify(state)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RELAY_STATE_BYTES) throw new RelayStateError()
  return encoded
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

export async function loadRelayState(path: string): Promise<RegisteredHostState | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw new RelayStateError()
  }

  let bytes: Buffer
  try {
    const bounded = Buffer.alloc(MAX_RELAY_STATE_BYTES + 1)
    let offset = 0
    while (offset < bounded.byteLength) {
      const result = await handle.read(bounded, offset, bounded.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset > MAX_RELAY_STATE_BYTES) throw new RelayStateError()
    bytes = bounded.subarray(0, offset)
    const text = decoder.decode(bytes)
    const parsed = JSON.parse(text) as unknown
    const state = normalizeState(parsed)
    if (state === undefined || JSON.stringify(state) !== text) throw new RelayStateError()
    return state
  } catch {
    throw new RelayStateError()
  } finally {
    try {
      await handle.close()
    } catch {
      throw new RelayStateError()
    }
  }
}

export async function createRelayState(path: string, state: RegisteredHostState): Promise<void> {
  let encoded: string
  const parent = dirname(path)
  try {
    encoded = encodeState(state)
    await mkdir(parent, { recursive: true })
  } catch {
    throw new RelayStateError()
  }

  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(encoded, { encoding: 'utf8' })
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (process.platform !== 'win32') {
      const directory = await open(parent, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch {
    // A partially created file deliberately remains registration-closing state.
    throw new RelayStateError()
  }
}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest()
}

export function digestCredential(credential: string): string {
  return hashCredential(credential).toString('base64url')
}

export function credentialMatches(credential: string, digest: string): boolean {
  const actual = hashCredential(credential)
  const decoded = decodeDigest(digest)
  const matches = timingSafeEqual(actual, decoded ?? dummyDigest)
  return decoded !== undefined && matches
}
