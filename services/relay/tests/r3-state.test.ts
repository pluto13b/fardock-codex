import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROTOCOL_VERSION,
  type P256PublicJwk,
  type RelayActiveAuthorizationPut,
  type RelayAuthorizationPut,
} from '@codex-plus/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  MAX_R3_RELAY_STATE_BYTES,
  R3RelayStateError,
  loadR3RelayState,
  openR3RelayStateStore,
  type R3RelayHostRegistration,
  type R3RelayPersistedState,
} from '../src/r3-state.ts'

const sharedTestRoot = fileURLToPath(new URL('../../../.tmp/relay-tests/', import.meta.url))
const testRoot = join(sharedTestRoot, `r3-state-${process.pid}-${randomUUID()}`)

function publicKey(): P256PublicJwk {
  const exported = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .publicKey
    .export({ format: 'jwk' })
  return {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x!,
    y: exported.y!,
  }
}

function fingerprint(key: P256PublicJwk): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }), 'utf8')
    .digest('base64url')
}

const hostSigningKey = publicKey()
const clientSigningKeyA = publicKey()
const clientSigningKeyB = publicKey()

function hostRegistration(
  overrides: Partial<R3RelayHostRegistration> = {},
): R3RelayHostRegistration {
  return {
    hostId: 'host.test',
    hostDeviceId: 'device.host',
    hostSigningKey,
    hostSigningFingerprint: fingerprint(hostSigningKey),
    ...overrides,
  }
}

function activeAuthorization(
  overrides: Partial<RelayActiveAuthorizationPut> = {},
): RelayActiveAuthorizationPut {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'authorization.put',
    hostId: 'host.test',
    hostDeviceId: 'device.host',
    clientDeviceId: 'device.client-a',
    authorizationId: 'authorization.a',
    authorizationEpoch: 1,
    hostAuthorizationRevision: 1,
    status: 'active',
    clientSigningKey: clientSigningKeyA,
    clientSigningFingerprint: fingerprint(clientSigningKeyA),
    ...overrides,
  }
}

function revokedAuthorization(
  source: RelayActiveAuthorizationPut,
  overrides: Partial<RelayAuthorizationPut> = {},
): RelayAuthorizationPut {
  return {
    protocolVersion: PROTOCOL_VERSION,
    relayType: 'authorization.put',
    hostId: source.hostId,
    hostDeviceId: source.hostDeviceId,
    clientDeviceId: source.clientDeviceId,
    authorizationId: source.authorizationId,
    authorizationEpoch: source.authorizationEpoch + 1,
    hostAuthorizationRevision: source.hostAuthorizationRevision + 1,
    status: 'revoked',
    ...overrides,
  } as RelayAuthorizationPut
}

async function expectSafeStateError(action: Promise<unknown>): Promise<void> {
  const error = await action.catch(reason => reason as unknown)
  expect(error).toBeInstanceOf(R3RelayStateError)
  expect(error).toMatchObject({
    name: 'R3RelayStateError',
    message: 'R3 Relay state operation failed.',
  })
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
  expect(error).not.toHaveProperty('path')
  expect(JSON.stringify(error)).toBe('{}')
}

async function bootstrappedStateFile(name: string): Promise<string> {
  const stateFile = join(testRoot, name, 'state.json')
  const store = await openR3RelayStateStore(stateFile)
  await store.bootstrapHost(hostRegistration())
  await store.close()
  return stateFile
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('R3 Relay Host registration state', () => {
  it('exclusive-creates a canonical registration-closed record and survives restart', async () => {
    const stateFile = join(testRoot, 'bootstrap', 'state.json')
    const store = await openR3RelayStateStore(stateFile)
    expect(store.registrationClosed).toBe(false)

    const expected: R3RelayPersistedState = {
      stateVersion: 1,
      registrationClosed: true,
      host: hostRegistration(),
      hostAuthorizationRevision: 0,
      authorizations: [],
    }
    await expect(store.bootstrapHost(hostRegistration())).resolves.toEqual(expected)
    expect(store.registrationClosed).toBe(true)
    await expect(readFile(stateFile, 'utf8')).resolves.toBe(JSON.stringify(expected))
    await store.close()

    const restarted = await openR3RelayStateStore(stateFile)
    expect(restarted.registrationClosed).toBe(true)
    expect(restarted.hostRegistration()).toEqual(hostRegistration())
    await expectSafeStateError(restarted.bootstrapHost(hostRegistration()))
    await restarted.close()
  })

  it('allows exactly one concurrent bootstrap and never overwrites it', async () => {
    const stateFile = join(testRoot, 'concurrent-bootstrap', 'state.json')
    const [left, right] = await Promise.all([
      openR3RelayStateStore(stateFile),
      openR3RelayStateStore(stateFile),
    ])
    const results = await Promise.allSettled([
      left.bootstrapHost(hostRegistration()),
      right.bootstrapHost(hostRegistration({ hostId: 'host.attacker' })),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)

    const persisted = await loadR3RelayState(stateFile)
    const winner = results[0].status === 'fulfilled' ? 'host.test' : 'host.attacker'
    expect(persisted?.host.hostId).toBe(winner)
    await Promise.all([left.close(), right.close()])
  })

  it('validates a real P-256 point and its RFC 7638 fingerprint before creating', async () => {
    const invalidPoint = Buffer.alloc(32).toString('base64url')
    const invalidKey: P256PublicJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: invalidPoint,
      y: invalidPoint,
    }
    const fixtures: R3RelayHostRegistration[] = [
      hostRegistration({ hostSigningFingerprint: fingerprint(clientSigningKeyA) }),
      hostRegistration({ hostSigningKey: invalidKey, hostSigningFingerprint: fingerprint(invalidKey) }),
      hostRegistration({ hostId: '../host' }),
    ]

    for (const [index, fixture] of fixtures.entries()) {
      const stateFile = join(testRoot, `invalid-bootstrap-${index}`, 'state.json')
      const store = await openR3RelayStateStore(stateFile)
      await expectSafeStateError(store.bootstrapHost(fixture))
      await expect(loadR3RelayState(stateFile)).resolves.toBeUndefined()
      await store.close()
    }
  })

  it('fails closed on malformed, noncanonical, oversized, and unknown state', async () => {
    const canonical: R3RelayPersistedState = {
      stateVersion: 1,
      registrationClosed: true,
      host: hostRegistration(),
      hostAuthorizationRevision: 0,
      authorizations: [],
    }
    const fixtures: Array<[string, string | Uint8Array]> = [
      ['invalid-utf8.json', Uint8Array.of(0xff)],
      ['invalid-json.json', '{'],
      ['oversized.json', 'x'.repeat(MAX_R3_RELAY_STATE_BYTES + 1)],
      ['trailing-newline.json', `${JSON.stringify(canonical)}\n`],
      ['bom.json', `\ufeff${JSON.stringify(canonical)}`],
      ['unknown.json', JSON.stringify({ ...canonical, unknown: true })],
      [
        'wrong-order.json',
        JSON.stringify({
          registrationClosed: true,
          stateVersion: 1,
          host: canonical.host,
          hostAuthorizationRevision: 0,
          authorizations: [],
        }),
      ],
    ]

    for (const [name, contents] of fixtures) {
      const stateFile = join(testRoot, name)
      await writeFile(stateFile, contents)
      await expectSafeStateError(openR3RelayStateStore(stateFile))
      await expect(readFile(stateFile)).resolves.toEqual(Buffer.from(contents))
    }
  })

  it('returns undefined only for a missing file and rejects relative paths', async () => {
    await expect(loadR3RelayState(join(testRoot, 'missing.json'))).resolves.toBeUndefined()
    await expectSafeStateError(openR3RelayStateStore('relative-state.json'))

    const directory = join(testRoot, 'not-a-state-file')
    await mkdir(directory)
    await expectSafeStateError(openR3RelayStateStore(directory))
  })
})

describe('R3 Relay authorization persistence', () => {
  it('applies monotonic active/revoked updates and accepts only exact idempotent replay', async () => {
    const stateFile = await bootstrappedStateFile('authorization-monotonic')
    const store = await openR3RelayStateStore(stateFile)
    const first = activeAuthorization()
    await expect(store.applyAuthorization(first)).resolves.toMatchObject({ outcome: 'applied' })
    await expect(store.applyAuthorization(first)).resolves.toMatchObject({ outcome: 'idempotent' })

    const second = activeAuthorization({
      clientDeviceId: 'device.client-b',
      authorizationId: 'authorization.b',
      hostAuthorizationRevision: 2,
      clientSigningKey: clientSigningKeyB,
      clientSigningFingerprint: fingerprint(clientSigningKeyB),
    })
    await expect(store.applyAuthorization(second)).resolves.toMatchObject({ outcome: 'applied' })
    // An older record remains exactly replayable after the global revision advances.
    await expect(store.applyAuthorization(first)).resolves.toMatchObject({ outcome: 'idempotent' })

    const rotated = activeAuthorization({
      authorizationEpoch: 2,
      hostAuthorizationRevision: 3,
      clientSigningKey: clientSigningKeyB,
      clientSigningFingerprint: fingerprint(clientSigningKeyB),
    })
    await expect(store.applyAuthorization(rotated)).resolves.toMatchObject({ outcome: 'applied' })

    const revoked = revokedAuthorization(rotated, {
      authorizationEpoch: 3,
      hostAuthorizationRevision: 4,
    })
    await expect(store.applyAuthorization(revoked)).resolves.toMatchObject({ outcome: 'applied' })
    await expect(store.applyAuthorization(revoked)).resolves.toMatchObject({ outcome: 'idempotent' })
    expect(store.authorization(first.authorizationId)).toMatchObject({
      status: 'revoked',
      authorizationEpoch: 3,
      hostAuthorizationRevision: 4,
    })
    expect(store.activeAuthorization({
      hostId: first.hostId,
      hostDeviceId: first.hostDeviceId,
      clientDeviceId: first.clientDeviceId,
      authorizationId: first.authorizationId,
      authorizationEpoch: 3,
    })).toBeUndefined()

    const persisted = await loadR3RelayState(stateFile)
    expect(persisted?.hostAuthorizationRevision).toBe(4)
    expect(persisted?.authorizations.map(value => value.authorizationId)).toEqual([
      'authorization.a',
      'authorization.b',
    ])
    expect(persisted?.authorizations[0]).not.toHaveProperty('clientSigningKey')
    await store.close()
  })

  it('rejects rollback, conflict, route changes, identifier reuse, and resurrection', async () => {
    const stateFile = await bootstrappedStateFile('authorization-rejections')
    const store = await openR3RelayStateStore(stateFile)
    const first = activeAuthorization()
    await store.applyAuthorization(first)

    const invalidUpdates: RelayAuthorizationPut[] = [
      activeAuthorization({ clientSigningKey: clientSigningKeyB }),
      activeAuthorization({ hostAuthorizationRevision: 2 }),
      activeAuthorization({ authorizationEpoch: 2, hostAuthorizationRevision: 1 }),
      activeAuthorization({
        hostId: 'host.other',
        authorizationEpoch: 2,
        hostAuthorizationRevision: 2,
      }),
      activeAuthorization({
        hostDeviceId: 'device.other-host',
        authorizationEpoch: 2,
        hostAuthorizationRevision: 2,
      }),
      activeAuthorization({
        authorizationId: 'authorization.new',
        authorizationEpoch: 2,
        hostAuthorizationRevision: 2,
      }),
      activeAuthorization({
        authorizationId: 'authorization.reused-device',
        hostAuthorizationRevision: 2,
      }),
      revokedAuthorization(first, {
        authorizationId: 'authorization.unknown',
        clientDeviceId: 'device.unknown',
        hostAuthorizationRevision: 2,
      }),
    ]
    for (const update of invalidUpdates) await expectSafeStateError(store.applyAuthorization(update))

    const revoked = revokedAuthorization(first)
    await store.applyAuthorization(revoked)
    await expectSafeStateError(store.applyAuthorization(activeAuthorization({
      authorizationEpoch: 3,
      hostAuthorizationRevision: 3,
    })))
    await expectSafeStateError(store.applyAuthorization(revokedAuthorization(first, {
      authorizationEpoch: 3,
      hostAuthorizationRevision: 3,
    })))

    const persisted = await loadR3RelayState(stateFile)
    expect(persisted?.hostAuthorizationRevision).toBe(2)
    expect(persisted?.authorizations).toHaveLength(1)
    expect(persisted?.authorizations[0]?.status).toBe('revoked')
    await store.close()
  })

  it('serializes one store and fails closed across concurrent stores without corrupting state', async () => {
    const stateFile = await bootstrappedStateFile('authorization-concurrency')
    const store = await openR3RelayStateStore(stateFile)
    const first = activeAuthorization()
    const second = activeAuthorization({
      clientDeviceId: 'device.client-b',
      authorizationId: 'authorization.b',
      hostAuthorizationRevision: 2,
      clientSigningKey: clientSigningKeyB,
      clientSigningFingerprint: fingerprint(clientSigningKeyB),
    })
    await expect(Promise.all([
      store.applyAuthorization(first),
      store.applyAuthorization(second),
    ])).resolves.toHaveLength(2)
    await store.close()

    const [left, right] = await Promise.all([
      openR3RelayStateStore(stateFile),
      openR3RelayStateStore(stateFile),
    ])
    const thirdA = activeAuthorization({
      clientDeviceId: 'device.client-c',
      authorizationId: 'authorization.c',
      hostAuthorizationRevision: 3,
    })
    const thirdB = activeAuthorization({
      clientDeviceId: 'device.client-d',
      authorizationId: 'authorization.d',
      hostAuthorizationRevision: 3,
    })
    const results = await Promise.allSettled([
      left.applyAuthorization(thirdA),
      right.applyAuthorization(thirdB),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)

    const persisted = await loadR3RelayState(stateFile)
    expect(persisted?.hostAuthorizationRevision).toBe(3)
    expect(persisted?.authorizations).toHaveLength(3)
    const directoryEntries = await readdir(join(testRoot, 'authorization-concurrency'))
    expect(directoryEntries).toEqual(['state.json'])
    await Promise.all([left.close(), right.close()])
  })

  it('rejects corrupted authorization invariants and never reopens bootstrap', async () => {
    const stateFile = await bootstrappedStateFile('corrupt-authorization')
    const baseline = (await loadR3RelayState(stateFile))!
    const authorization = activeAuthorization()
    const corrupt = {
      ...baseline,
      hostAuthorizationRevision: 1,
      authorizations: [{
        authorizationId: authorization.authorizationId,
        clientDeviceId: authorization.clientDeviceId,
        authorizationEpoch: 1,
        hostAuthorizationRevision: 1,
        status: 'active',
        clientSigningKey: authorization.clientSigningKey,
        clientSigningFingerprint: fingerprint(clientSigningKeyB),
      }],
    }
    await writeFile(stateFile, JSON.stringify(corrupt), 'utf8')

    await expectSafeStateError(openR3RelayStateStore(stateFile))
    expect(await readFile(stateFile, 'utf8')).toBe(JSON.stringify(corrupt))
  })

  it('does not expose mutable state and performs no operations after close', async () => {
    const stateFile = await bootstrappedStateFile('snapshot-isolation')
    const store = await openR3RelayStateStore(stateFile)
    const first = activeAuthorization()
    await store.applyAuthorization(first)

    const snapshot = store.snapshot()!
    snapshot.host.hostId = 'host.mutated'
    snapshot.authorizations.length = 0
    expect(store.snapshot()?.host.hostId).toBe('host.test')
    expect(store.snapshot()?.authorizations).toHaveLength(1)
    expect(store.activeAuthorization({
      hostId: first.hostId,
      hostDeviceId: first.hostDeviceId,
      clientDeviceId: first.clientDeviceId,
      authorizationId: first.authorizationId,
      authorizationEpoch: first.authorizationEpoch,
    })).toMatchObject({ status: 'active' })

    await store.close()
    await store.close()
    expect(() => store.snapshot()).toThrow(R3RelayStateError)
    await expectSafeStateError(store.applyAuthorization(first))
  })
})
