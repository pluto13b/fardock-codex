import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  decodeSessionInit,
} from '../../../packages/protocol/src/index.ts'
import {
  approveHostPairing,
  createClientPairJoin,
  createClientSessionInit,
  createHostPairingInvitation,
  createHostSessionAccept,
  openClientPairResult,
  openHostPairJoin,
  validateSessionInitForHost,
} from '../../../packages/e2ee/src/index.ts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WindowsIdentityStore } from '../src/windows-identity-store.ts'
import { createPersistentHostPairingRuntime } from '../src/persistent-pairing-runtime.ts'
import type { R3RelayHostClient } from '../src/relay-host-client.ts'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const testRoot = join(workspaceRoot, '.tmp', 'windows-identity-tests')
const now = 1_900_000_000_000

async function createStore(name: string): Promise<Readonly<{
  store: WindowsIdentityStore
  directory: string
  identityFile: string
}>> {
  const directory = join(testRoot, `${name}-${randomUUID()}`)
  const identityFile = join(directory, 'identity.dpapi')
  await mkdir(directory, { recursive: true })
  return {
    store: await WindowsIdentityStore.open({ workspaceRoot, identityFile }),
    directory,
    identityFile,
  }
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('Windows DPAPI identity store', () => {
  it('rejects identity paths outside workspace-local .data/.tmp roots', async () => {
    await expect(WindowsIdentityStore.open({
      workspaceRoot,
      identityFile: join(workspaceRoot, 'tracked-identity.dpapi'),
    })).rejects.toMatchObject({ code: 'invalid-path' })
  })

  it('survives a new store instance, exports bootstrap once, and removes the Host copy', async () => {
    const value = await createStore('identity')
    const identity = await value.store.initialize()
    expect(identity.hostAgreementPrivateKey.extractable).toBe(false)
    expect(identity.hostSigningPrivateKey.extractable).toBe(false)
    expect(identity.bootstrapCredential).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const encrypted = await readFile(value.identityFile)
    expect(encrypted.toString('utf8')).not.toContain(identity.bootstrapCredential!)
    expect(encrypted.toString('utf8')).not.toContain(identity.hostId)
    expect((await readFile(`${value.identityFile}.anchor`)).toString('utf8')).not.toContain(identity.hostId)
    const exportFile = join(value.directory, 'relay-bootstrap')
    await value.store.exportBootstrap(exportFile)
    expect(await readFile(exportFile, 'utf8')).toBe(identity.bootstrapCredential)
    await expect(value.store.exportBootstrap(exportFile)).rejects.toMatchObject({
      code: 'bootstrap-export-failed',
    })
    expect(await readFile(exportFile, 'utf8')).toBe(identity.bootstrapCredential)

    const reopened = await WindowsIdentityStore.open({
      workspaceRoot,
      identityFile: value.identityFile,
    })
    const restored = await reopened.loadIdentity()
    expect(restored).toMatchObject({
      hostId: identity.hostId,
      hostDeviceId: identity.hostDeviceId,
      bootstrapCredential: identity.bootstrapCredential,
    })
    expect(restored.hostAgreementPrivateKey.extractable).toBe(false)
    expect(restored.hostSigningPrivateKey.extractable).toBe(false)

    await reopened.markBootstrapRegistered()
    expect((await reopened.loadIdentity()).bootstrapCredential).toBeUndefined()
    expect(await readFile(exportFile, 'utf8')).toBe(identity.bootstrapCredential)
  }, 30_000)

  it('detects corruption and state/anchor rollback mismatch', async () => {
    const corrupt = await createStore('corrupt')
    await corrupt.store.initialize()
    const ciphertext = await readFile(corrupt.identityFile)
    ciphertext[Math.floor(ciphertext.byteLength / 2)]! ^= 0xff
    await writeFile(corrupt.identityFile, ciphertext)
    await expect(corrupt.store.loadIdentity()).rejects.toMatchObject({ code: 'operation-failed' })

    const rollback = await createStore('rollback')
    await rollback.store.initialize()
    const oldAnchor = await readFile(`${rollback.identityFile}.anchor`)
    await rollback.store.markBootstrapRegistered()
    await writeFile(`${rollback.identityFile}.anchor`, oldAnchor)
    await expect(rollback.store.loadIdentity()).rejects.toMatchObject({ code: 'rollback-detected' })
  }, 30_000)

  it('keeps a stable independent action fingerprinter inside current-user DPAPI state', async () => {
    const first = await createStore('fingerprint-first')
    await first.store.initialize()
    const fingerprinter = await first.store.openActionRequestFingerprinter()
    const canonical = new TextEncoder().encode('{"kind":"request","requestId":"action.one"}')
    const fingerprint = await fingerprinter.fingerprintCanonicalRequest(canonical)
    expect(fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await fingerprinter.fingerprintCanonicalRequest(canonical)).toBe(fingerprint)
    expect(await fingerprinter.fingerprintCanonicalRequest(
      new TextEncoder().encode(`other-domain\0${new TextDecoder().decode(canonical)}`),
    )).not.toBe(fingerprint)

    const reopened = await WindowsIdentityStore.open({
      workspaceRoot,
      identityFile: first.identityFile,
    })
    const restored = await reopened.openActionRequestFingerprinter()
    expect(await restored.fingerprintCanonicalRequest(canonical)).toBe(fingerprint)

    const second = await createStore('fingerprint-second')
    await second.store.initialize()
    const independent = await second.store.openActionRequestFingerprinter()
    expect(await independent.fingerprintCanonicalRequest(canonical)).not.toBe(fingerprint)
    await expect(independent.fingerprintCanonicalRequest(
      new Uint8Array(512 * 1024 + 1),
    )).rejects.toMatchObject({ code: 'invalid-fingerprint-input' })

    fingerprinter.close()
    fingerprinter.close()
    await expect(fingerprinter.fingerprintCanonicalRequest(canonical)).rejects.toMatchObject({
      code: 'fingerprinter-closed',
    })
    restored.close()
    independent.close()

    const encrypted = await readFile(first.identityFile)
    expect(encrypted.toString('utf8')).not.toContain(fingerprint)
  }, 30_000)

  it('persists authorization and burns Host generation before session accept', async () => {
    const value = await createStore('generation')
    const identity = await value.store.initialize()
    const invitation = await createHostPairingInvitation({
      relayOrigin: 'https://relay.example.test',
      hostId: identity.hostId,
      hostDeviceId: identity.hostDeviceId,
      hostAgreementPublicKey: identity.hostAgreementPublicKey,
      hostSigningPrivateKey: identity.hostSigningPrivateKey,
      hostSigningPublicKey: identity.hostSigningPublicKey,
      now,
      clock: () => now + 100,
    })
    const join = await createClientPairJoin({
      invitationFragment: invitation.invitationFragment,
      expectedRelayOrigin: 'https://relay.example.test',
      deviceDisplayName: 'Persistent Phone',
      now: now + 100,
    })
    const opened = await openHostPairJoin({
      invitation: invitation.handle,
      attemptId: 'attempt.persisted',
      wireFrame: join.wireText,
      now: now + 200,
    })
    if (opened.outcome !== 'pending-confirmation') throw new Error('pairing-failed')
    const approved = await approveHostPairing({
      confirmation: opened.confirmation,
      now: now + 300,
      persistenceAdapter: {
        commitAuthorizationAndUpsertRelay: async ({ authorization }) => {
          const local = await value.store.commitAuthorization(authorization)
          return { relayRevision: local.hostAuthorizationRevision, nextGeneration: local.nextGeneration }
        },
      },
    })
    const clientGrant = await openClientPairResult(join.handle, approved.wireText, now + 301)
    if (clientGrant.outcome !== 'approved') throw new Error('grant-failed')

    const reopened = await WindowsIdentityStore.open({
      workspaceRoot,
      identityFile: value.identityFile,
    })
    const stored = await reopened.loadAuthorization(
      approved.authorization.grantClaims.authorizationId,
    )
    expect(stored.nextGeneration).toBe(1)
    const restoredIdentity = await reopened.loadIdentity()
    const init = await createClientSessionInit({
      authorization: { status: 'active', ...clientGrant.authorization },
      now: now + 400,
      expiresAt: now + 20_000,
    })
    const validated = await validateSessionInitForHost({
      authorization: {
        status: 'active',
        grantClaims: stored.material.grantClaims,
        grantClaimsHash: stored.material.grantClaimsHash,
        hostGrantSignature: stored.material.hostGrantSignature,
        hostAgreementPrivateKey: restoredIdentity.hostAgreementPrivateKey,
        hostAgreementPublicKey: restoredIdentity.hostAgreementPublicKey,
        hostSigningPrivateKey: restoredIdentity.hostSigningPrivateKey,
        hostSigningPublicKey: restoredIdentity.hostSigningPublicKey,
      },
      frame: init.frame,
      now: now + 401,
      reserveGeneration: request => reopened.reserveGeneration(request),
    })
    const accept = await createHostSessionAccept({
      state: validated,
      now: now + 402,
      expiresAt: now + 10_000,
    })
    expect(accept.authority.connectionGeneration).toBe(1)
    const decodedInit = decodeSessionInit(init.frame, {
      expectedRelayOrigin: 'https://relay.example.test',
      now: now + 401,
    })
    await expect(reopened.reserveGeneration({
      hostId: accept.authority.hostId,
      hostDeviceId: accept.authority.hostDeviceId,
      clientDeviceId: accept.authority.clientDeviceId,
      authorizationId: accept.authority.authorizationId,
      authorizationEpoch: accept.authority.authorizationEpoch,
      handshakeId: decodedInit.handshakeId,
      clientNonce: decodedInit.clientNonce,
    })).rejects.toMatchObject({ code: 'stale-authority' })
    expect((await reopened.loadAuthorization(
      accept.authority.authorizationId,
    )).nextGeneration).toBe(2)
    expect(await reopened.listManagedDevices({
      currentClientDeviceId: accept.authority.clientDeviceId,
      generatedAt: now + 410,
    })).toEqual([
      expect.objectContaining({
        deviceId: accept.authority.clientDeviceId,
        signingFingerprint: stored.material.grantClaims.clientSigningFingerprint,
        authorizationId: accept.authority.authorizationId,
        authorizationEpoch: accept.authority.authorizationEpoch,
        status: 'active',
        presence: 'online',
        pairedAt: stored.material.grantClaims.issuedAt,
        lastSeenAt: now + 410,
        isCurrent: true,
      }),
    ])
    await reopened.renameManagedDevice({
      deviceId: accept.authority.clientDeviceId,
      authorizationId: accept.authority.authorizationId,
      authorizationEpoch: accept.authority.authorizationEpoch,
      displayName: '测试手机',
    })
    expect(await reopened.listManagedDevices({
      currentClientDeviceId: accept.authority.clientDeviceId,
      generatedAt: now + 411,
    })).toEqual([expect.objectContaining({ displayName: '测试手机' })])
    await expect(reopened.revokeManagedDevice({
      currentClientDeviceId: accept.authority.clientDeviceId,
      deviceId: accept.authority.clientDeviceId,
      authorizationId: accept.authority.authorizationId,
      authorizationEpoch: accept.authority.authorizationEpoch,
    })).rejects.toMatchObject({ code: 'stale-authority' })

    const secondProcess = await WindowsIdentityStore.open({
      workspaceRoot,
      identityFile: value.identityFile,
    })
    const secondIdentity = await secondProcess.loadIdentity()
    const secondStored = await secondProcess.loadAuthorization(accept.authority.authorizationId)
    const secondInit = await createClientSessionInit({
      authorization: { status: 'active', ...clientGrant.authorization },
      now: now + 450,
      expiresAt: now + 20_000,
    })
    const secondValidated = await validateSessionInitForHost({
      authorization: {
        status: 'active',
        grantClaims: secondStored.material.grantClaims,
        grantClaimsHash: secondStored.material.grantClaimsHash,
        hostGrantSignature: secondStored.material.hostGrantSignature,
        hostAgreementPrivateKey: secondIdentity.hostAgreementPrivateKey,
        hostAgreementPublicKey: secondIdentity.hostAgreementPublicKey,
        hostSigningPrivateKey: secondIdentity.hostSigningPrivateKey,
        hostSigningPublicKey: secondIdentity.hostSigningPublicKey,
      },
      frame: secondInit.frame,
      now: now + 451,
      reserveGeneration: request => secondProcess.reserveGeneration(request),
    })
    const secondAccept = await createHostSessionAccept({
      state: secondValidated,
      now: now + 452,
      expiresAt: now + 10_000,
    })
    expect(secondAccept.authority.connectionGeneration).toBe(2)
    expect((await secondProcess.loadAuthorization(
      accept.authority.authorizationId,
    )).nextGeneration).toBe(3)

    const unusedRelay: R3RelayHostClient = {
      connect: async () => {},
      putAuthorization: async () => { throw new Error('unused') },
      openPairSession: async open => ({ ...open, relayType: 'pair.opened' }),
      registerPairingCode: async () => { throw new Error('unused') },
      claimPairSession: async () => { throw new Error('unused') },
      sendPairResult: async () => { throw new Error('unused') },
      closePairSession: async () => { throw new Error('unused') },
      sendSessionAccept: async () => { throw new Error('unused') },
      sendEnvelope: async () => { throw new Error('unused') },
      onUnexpectedDisconnect: () => () => {},
      close: async () => {},
    }
    let runtimeNow = now + 500
    const persistent = await createPersistentHostPairingRuntime({
      store: reopened,
      relayClient: unusedRelay,
      relayOrigin: 'https://relay.example.test',
      authorizationId: accept.authority.authorizationId,
      requestLocalDecision: async () => ({ decision: 'deny' }),
      now: () => runtimeNow,
    })
    expect(persistent.identity).toMatchObject({
      hostId: identity.hostId,
      hostDeviceId: identity.hostDeviceId,
    })
    const firstInvitation = await persistent.runtime.createInvitation()
    expect(firstInvitation).toMatchObject({
      invitationFragment: expect.any(String),
      handle: { hostId: identity.hostId, hostDeviceId: identity.hostDeviceId },
    })
    await expect(persistent.runtime.createInvitation()).rejects.toThrow('pairing-already-started')
    runtimeNow = firstInvitation.handle.expiresAt
    const replacementInvitation = await persistent.runtime.createInvitation()
    expect(replacementInvitation).toMatchObject({
      invitationFragment: expect.any(String),
      handle: {
        hostId: identity.hostId,
        hostDeviceId: identity.hostDeviceId,
      },
    })
    expect(replacementInvitation.handle.pairSessionId).not.toBe(firstInvitation.handle.pairSessionId)
    await expect(reopened.revokeManagedDevice({
      currentClientDeviceId: 'client.other',
      deviceId: accept.authority.clientDeviceId,
      authorizationId: accept.authority.authorizationId,
      authorizationEpoch: 2,
    })).rejects.toMatchObject({ code: 'stale-authority' })
    const tombstone = await reopened.revokeManagedDevice({
      currentClientDeviceId: 'client.other',
      deviceId: accept.authority.clientDeviceId,
      authorizationId: accept.authority.authorizationId,
      authorizationEpoch: 1,
    })
    expect(tombstone).toMatchObject({
      status: 'revoked', authorizationEpoch: 2, hostAuthorizationRevision: 2,
    })
    expect(await reopened.activeAuthorizationIds()).toEqual([])
    expect(await reopened.listManagedDevices({
      currentClientDeviceId: 'client.other',
      generatedAt: now + 510,
    })).toEqual([
      expect.objectContaining({
        deviceId: accept.authority.clientDeviceId,
        authorizationEpoch: 2,
        status: 'revoked',
        presence: 'offline',
        lastSeenAt: null,
        isCurrent: false,
      }),
    ])
    await expect(reopened.loadAuthorization(
      accept.authority.authorizationId,
    )).rejects.toMatchObject({ code: 'authorization-unavailable' })
    await expect(reopened.reserveGeneration({
      hostId: accept.authority.hostId,
      hostDeviceId: accept.authority.hostDeviceId,
      clientDeviceId: accept.authority.clientDeviceId,
      authorizationId: accept.authority.authorizationId,
      authorizationEpoch: 1,
      handshakeId: 'handshake.after.revoke',
      clientNonce: Buffer.alloc(32, 0x44).toString('base64url'),
    })).rejects.toMatchObject({ code: 'stale-authority' })
  }, 30_000)
})
