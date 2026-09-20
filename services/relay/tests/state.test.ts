import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  MAX_RELAY_STATE_BYTES,
  RelayStateError,
  createRelayState,
  credentialMatches,
  digestCredential,
  loadRelayState,
  type RegisteredHostState,
} from '../src/state.ts'

const sharedTestRoot = fileURLToPath(new URL('../../../.tmp/relay-tests/', import.meta.url))
const testRoot = join(sharedTestRoot, `state-${process.pid}-${randomUUID()}`)
const sessionCredential = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg'

function state(overrides: Partial<RegisteredHostState> = {}): RegisteredHostState {
  return {
    stateVersion: 1,
    registrationClosed: true,
    hostId: 'host.test',
    deviceId: 'device.host',
    sessionCredentialDigest: digestCredential(sessionCredential),
    ...overrides,
  }
}

async function expectSafeStateError(action: Promise<unknown>): Promise<void> {
  const error = await action.catch(reason => reason as unknown)
  expect(error).toBeInstanceOf(RelayStateError)
  expect(error).toMatchObject({
    name: 'RelayStateError',
    message: 'Relay state operation failed.',
  })
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  expect(error).not.toHaveProperty('path')
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('relay persisted registration state', () => {
  it('returns undefined only for a missing state file', async () => {
    await expect(loadRelayState(join(testRoot, 'missing.json'))).resolves.toBeUndefined()

    const directory = join(testRoot, 'not-a-file')
    await mkdir(directory)
    await expectSafeStateError(loadRelayState(directory))
  })

  it('exclusive-creates, flushes, and strictly reloads canonical state', async () => {
    const path = join(testRoot, 'roundtrip', 'state.json')
    const expected = state()

    await createRelayState(path, expected)

    const encoded = await readFile(path, 'utf8')
    expect(encoded).toBe(JSON.stringify(expected))
    await expect(loadRelayState(path)).resolves.toEqual(expected)

    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('never overwrites or removes an existing state path', async () => {
    const path = join(testRoot, 'existing.json')
    await writeFile(path, 'sentinel', 'utf8')

    await expectSafeStateError(createRelayState(path, state()))
    await expect(readFile(path, 'utf8')).resolves.toBe('sentinel')
  })

  it('rejects invalid UTF-8, invalid JSON, oversized, and noncanonical state', async () => {
    const fixtures: Array<[string, string | Uint8Array]> = [
      ['invalid-utf8.json', Uint8Array.of(0xff)],
      ['invalid-json.json', '{'],
      ['oversized.json', 'x'.repeat(MAX_RELAY_STATE_BYTES + 1)],
      ['whitespace.json', `${JSON.stringify(state())}\n`],
      [
        'wrong-order.json',
        JSON.stringify({
          registrationClosed: true,
          stateVersion: 1,
          hostId: 'host.test',
          deviceId: 'device.host',
          sessionCredentialDigest: digestCredential(sessionCredential),
        }),
      ],
      ['bom.json', `\ufeff${JSON.stringify(state())}`],
    ]

    for (const [name, contents] of fixtures) {
      const path = join(testRoot, name)
      await writeFile(path, contents)
      await expectSafeStateError(loadRelayState(path))
    }
  })

  it('rejects unknown fields and invalid state values without leaking details', async () => {
    const invalidStates: unknown[] = [
      { ...state(), unknown: true },
      { ...state(), stateVersion: 2 },
      { ...state(), registrationClosed: false },
      { ...state(), hostId: '../host' },
      { ...state(), deviceId: '' },
      { ...state(), sessionCredentialDigest: 'not-a-digest' },
    ]

    for (const [index, invalidState] of invalidStates.entries()) {
      const path = join(testRoot, `invalid-state-${index}.json`)
      await writeFile(path, JSON.stringify(invalidState), 'utf8')
      await expectSafeStateError(loadRelayState(path))
    }
  })

  it('rejects an invalid state before creating the target', async () => {
    const path = join(testRoot, 'invalid-create.json')
    const invalid = { ...state(), registrationClosed: false } as unknown as RegisteredHostState

    await expectSafeStateError(createRelayState(path, invalid))
    await expect(loadRelayState(path)).resolves.toBeUndefined()
  })
})

describe('relay credential digest', () => {
  it('uses SHA-256 base64url without padding', () => {
    expect(digestCredential('relay-test-credential')).toBe(
      'u8Rqz5mixrzSgL7GBxrXt3DazHV6Wlv2LvTrLKmFDHc',
    )
  })

  it('matches only the exact credential and safely handles malformed digests', () => {
    const digest = digestCredential(sessionCredential)
    expect(credentialMatches(sessionCredential, digest)).toBe(true)
    expect(credentialMatches(`${sessionCredential}x`, digest)).toBe(false)
    expect(credentialMatches(sessionCredential, '')).toBe(false)
    expect(credentialMatches(sessionCredential, `${digest}=`)).toBe(false)
    expect(credentialMatches(sessionCredential, 'A'.repeat(43))).toBe(false)
  })
})
