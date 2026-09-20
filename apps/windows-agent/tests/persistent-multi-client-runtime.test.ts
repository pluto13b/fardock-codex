import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  acceptHostSessionReady,
  approveHostPairing,
  createClientPairJoin,
  createClientSessionConfirm,
  createClientSessionInit,
  createHostPairingInvitation,
  deriveClientSessionAfterGenerationCommit,
  getEstablishedSessionChannelInfo,
  openClientPairResult,
  openHostPairJoin,
  sealEstablishedApplication,
  validateSessionAcceptForClient,
  type ClientSessionAuthorization,
  type EstablishedSessionChannel,
} from '../../../packages/e2ee/src/index.ts'
import {
  decodeEnvelope,
  decodeSessionAccept,
  PROTOCOL_VERSION,
  type EnvelopeHeader,
} from '../../../packages/protocol/src/index.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPersistentMultiClientHostRuntime } from '../src/persistent-multi-client-runtime.ts'
import { WindowsCompanionReadySessionError } from '../src/ready-session.ts'
import type { R3RelayHostClient } from '../src/relay-host-client.ts'
import { WindowsIdentityStore, type WindowsHostIdentity } from '../src/windows-identity-store.ts'

const WORKSPACE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const TEST_ROOT = join(WORKSPACE_ROOT, '.tmp', 'multi-client-runtime-tests')
const RELAY_ORIGIN = 'https://relay.example.test'
const NOW = 1_900_000_000_000

let caseDirectory = ''

beforeEach(async () => {
  caseDirectory = join(TEST_ROOT, randomUUID())
  await mkdir(caseDirectory, { recursive: true })
})

afterEach(async () => {
  await rm(caseDirectory, { recursive: true, force: true })
})

async function authorize(
  store: WindowsIdentityStore,
  identity: WindowsHostIdentity,
  name: string,
  offset: number,
): Promise<ClientSessionAuthorization> {
  const invitation = await createHostPairingInvitation({
    relayOrigin: RELAY_ORIGIN,
    hostId: identity.hostId,
    hostDeviceId: identity.hostDeviceId,
    hostAgreementPublicKey: identity.hostAgreementPublicKey,
    hostSigningPrivateKey: identity.hostSigningPrivateKey,
    hostSigningPublicKey: identity.hostSigningPublicKey,
    now: NOW + offset,
    clock: () => NOW + offset + 10,
  })
  const joinRequest = await createClientPairJoin({
    invitationFragment: invitation.invitationFragment,
    expectedRelayOrigin: RELAY_ORIGIN,
    deviceDisplayName: name,
    now: NOW + offset + 10,
  })
  const opened = await openHostPairJoin({
    invitation: invitation.handle,
    attemptId: `attempt.${offset}`,
    wireFrame: joinRequest.wireText,
    now: NOW + offset + 20,
  })
  if (opened.outcome !== 'pending-confirmation') throw new Error('pairing-failed')
  const approved = await approveHostPairing({
    confirmation: opened.confirmation,
    now: NOW + offset + 30,
    remotePermissionModes: ['ask', 'read-only', 'full-access'],
    persistenceAdapter: {
      commitAuthorizationAndUpsertRelay: async ({ authorization }) => {
        const local = await store.commitAuthorization(authorization)
        return { relayRevision: local.hostAuthorizationRevision, nextGeneration: local.nextGeneration }
      },
    },
  })
  const grant = await openClientPairResult(joinRequest.handle, approved.wireText, NOW + offset + 31)
  if (grant.outcome !== 'approved') throw new Error('grant-failed')
  return { status: 'active', ...grant.authorization }
}

describe('persistent multi-client Host runtime', () => {
  it('binds the first browser from a local click and permits retry after code registration fails', async () => {
    const store = await WindowsIdentityStore.open({ workspaceRoot: WORKSPACE_ROOT, identityFile: join(caseDirectory, 'identity.dpapi') })
    await store.initialize()
    expect(await store.activeAuthorizationIds()).toHaveLength(0)
    let fragment = '', pairResult: string | Uint8Array = ''
    let failRegistration = true
    const localDecision = vi.fn(async () => ({ decision: 'deny' as const }))
    const completed = vi.fn()
    const closePairSession = vi.fn(async () => {})
    const relayClient: R3RelayHostClient = {
      connect: async () => {}, close: async () => {}, onUnexpectedDisconnect: () => () => {},
      putAuthorization: async value => ({ ...value, relayType: 'authorization.applied' }),
      openPairSession: async value => ({ ...value, relayType: 'pair.opened' }),
      registerPairingCode: async value => {
        if (failRegistration) throw new Error('registration-unavailable')
        fragment = value.invitationFragment
        return { ...value, relayType: 'pair.code.registered', code: '23456789' }
      },
      claimPairSession: async value => ({ ...value, relayType: 'pair.claimed' }),
      closePairSession,
      sendPairResult: async value => { pairResult = value },
      sendSessionAccept: async () => { throw new Error('unused') },
      sendEnvelope: async () => { throw new Error('unused') },
    }
    const runtime = await createPersistentMultiClientHostRuntime({
      store, relayClient, relayOrigin: RELAY_ORIGIN, requestLocalDecision: localDecision,
      onPairingCompleted: completed, onApplicationEnvelope: async () => {},
      remotePermissionModes: ['ask', 'read-only', 'full-access'], now: () => NOW,
    })
    await expect(runtime.createLocalPairingCode()).rejects.toThrow('registration-unavailable')
    expect(closePairSession).toHaveBeenCalledOnce()
    failRegistration = false
    await expect(runtime.createLocalPairingCode()).resolves.toEqual({ code: '23456789', expiresAt: NOW + 300_000 })
    await expect(runtime.createLocalPairingCode()).rejects.toThrow('pairing-already-started')
    const joinRequest = await createClientPairJoin({ invitationFragment: fragment, expectedRelayOrigin: RELAY_ORIGIN, deviceDisplayName: 'First phone', now: NOW })
    await runtime.handlePairJoin(joinRequest.wireText)
    expect(localDecision).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledOnce()
    expect(await store.activeAuthorizationIds()).toHaveLength(1)
    await expect(openClientPairResult(joinRequest.handle, pairResult, NOW)).resolves.toMatchObject({ outcome: 'approved' })
    await expect(runtime.handlePairJoin(joinRequest.wireText)).rejects.toThrow('pairing-unavailable')
  })
  it('routes two independent browser sessions and replaces only the reconnecting device', async () => {
    const store = await WindowsIdentityStore.open({
      workspaceRoot: WORKSPACE_ROOT,
      identityFile: join(caseDirectory, 'identity.dpapi'),
    })
    const identity = await store.initialize()
    const firstAuthorization = await authorize(store, identity, 'Desktop browser', 0)
    const secondAuthorization = await authorize(store, identity, 'Android browser', 1_000)
    expect(await store.activeAuthorizationIds()).toHaveLength(2)

    let clock = NOW + 3_000
    const accepts = new Map<string, string | Uint8Array>()
    const readyFrames = new Map<string, string | Uint8Array>()
    let unavailable = false
    const routedApplications: string[] = []
    const replaced: string[] = []
    const revoked: string[] = []
    const relayClient: R3RelayHostClient = {
      connect: async () => {},
      putAuthorization: async value => ({ ...value, relayType: 'authorization.applied' }),
      openPairSession: async value => ({ ...value, relayType: 'pair.opened' }),
      registerPairingCode: async () => { throw new Error('unused') },
      claimPairSession: async () => { throw new Error('unused') },
      sendPairResult: async () => { throw new Error('unused') },
      closePairSession: async () => {},
      sendSessionAccept: async frame => {
        const decoded = decodeSessionAccept(frame, { expectedRelayOrigin: RELAY_ORIGIN, now: clock })
        accepts.set(decoded.clientDeviceId, frame)
      },
      sendEnvelope: async frame => {
        const decoded = decodeEnvelope(frame, { now: clock })
        readyFrames.set(decoded.toDeviceId, frame)
        return {
          protocolVersion: PROTOCOL_VERSION,
          relayType: 'receipt',
          connectionGeneration: decoded.connectionGeneration,
          requestId: decoded.requestId,
          seq: decoded.seq,
          state: 'relayed',
        }
      },
      onUnexpectedDisconnect: () => () => {},
      close: async () => {},
    }
    const runtime = await createPersistentMultiClientHostRuntime({
      store,
      relayClient,
      relayOrigin: RELAY_ORIGIN,
      requestLocalDecision: async () => ({ decision: 'approve' }),
      onSessionReplacing: channel => {
        replaced.push(getEstablishedSessionChannelInfo(channel).authority.clientDeviceId)
      },
      onAuthorizationRevoked: tombstone => { revoked.push(tombstone.authorizationId) },
      onApplicationEnvelope: channel => {
        if (unavailable) throw new WindowsCompanionReadySessionError('relay-unavailable')
        routedApplications.push(getEstablishedSessionChannelInfo(channel).authority.clientDeviceId)
      },
      now: () => clock,
    })

    const connect = async (
      authorization: ClientSessionAuthorization,
      previousGeneration: number,
    ): Promise<EstablishedSessionChannel> => {
      clock += 10
      const init = await createClientSessionInit({ authorization, now: clock, expiresAt: clock + 20_000 })
      clock += 1
      await runtime.handleSessionInit(init.frame)
      const deviceId = authorization.grantClaims.clientDeviceId
      const accept = accepts.get(deviceId)
      if (accept === undefined) throw new Error('accept-missing')
      clock += 1
      const validated = await validateSessionAcceptForClient({
        state: init,
        frame: accept,
        now: clock,
        installGeneration: async () => previousGeneration,
      })
      const awaiting = await deriveClientSessionAfterGenerationCommit({ state: validated })
      clock += 1
      const confirm = await createClientSessionConfirm({ state: awaiting, now: clock, expiresAt: clock + 10_000 })
      clock += 1
      await runtime.handleSessionEnvelope(confirm.wireText)
      const ready = readyFrames.get(deviceId)
      if (ready === undefined) throw new Error('ready-missing')
      clock += 1
      return await acceptHostSessionReady({ state: awaiting, frame: ready, now: clock })
    }

    const first = await connect(firstAuthorization, 0)
    const second = await connect(secondAuthorization, 0)
    expect(new Set(runtime.readyClientDeviceIds())).toEqual(new Set([
      firstAuthorization.grantClaims.clientDeviceId,
      secondAuthorization.grantClaims.clientDeviceId,
    ]))
    expect(runtime.readyChannels()).toHaveLength(2)
    const devices = await store.listManagedDevices({
      currentClientDeviceId: firstAuthorization.grantClaims.clientDeviceId,
      onlineClientDeviceIds: runtime.readyClientDeviceIds(),
      generatedAt: clock,
    })
    expect(devices.filter(device => device.status === 'active').map(device => device.presence))
      .toEqual(['online', 'online'])
    expect(devices.filter(device => device.isCurrent)).toHaveLength(1)

    const firstInfo = getEstablishedSessionChannelInfo(first)
    const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: firstInfo.authority.connectionGeneration,
      fromDeviceId: firstInfo.authority.clientDeviceId,
      toDeviceId: firstInfo.authority.hostDeviceId,
      hostId: firstInfo.authority.hostId,
      keyId: firstInfo.outboundKeyId,
      requestId: 'request.multi.first',
      sentAt: clock,
      expiresAt: clock + 10_000,
      messageType: 'request',
    }
    const request = await sealEstablishedApplication({
      state: first,
      header,
      message: { kind: 'request', operation: 'manage.read', params: {} },
      now: clock,
      assertAuthorizationActive: async () => {},
      persistence: {
        reserveSequence: async input => input.expectedSequence,
        commitFrame: async () => {},
      },
    })
    await runtime.handleSessionEnvelope(request.wireText)
    expect(routedApplications).toEqual([firstAuthorization.grantClaims.clientDeviceId])

    const firstReconnected = await connect(firstAuthorization, 1)
    expect(replaced).toEqual([firstAuthorization.grantClaims.clientDeviceId])
    expect(runtime.readyChannels()).toHaveLength(2)
    expect(getEstablishedSessionChannelInfo(second).authority.clientDeviceId)
      .toBe(secondAuthorization.grantClaims.clientDeviceId)

    await runtime.handleSessionEnvelope(request.wireText)
    expect(runtime.readyChannels()).toHaveLength(2)
    expect(routedApplications).toHaveLength(1)
    const firstReconnectedInfo = getEstablishedSessionChannelInfo(firstReconnected)
    const secondInfo = getEstablishedSessionChannelInfo(second)
    unavailable = true
    const secondRequest = await sealEstablishedApplication({
      state: second,
      header: { ...header, fromDeviceId: secondInfo.authority.clientDeviceId, keyId: secondInfo.outboundKeyId, connectionGeneration: secondInfo.authority.connectionGeneration, sentAt: clock, expiresAt: clock + 10_000 },
      message: { kind: 'request', operation: 'manage.read', params: {} }, now: clock,
      assertAuthorizationActive: async () => {},
      persistence: { reserveSequence: async input => input.expectedSequence, commitFrame: async () => {} },
    })
    await expect(runtime.handleSessionEnvelope(secondRequest.wireText)).resolves.toBeUndefined()
    expect(runtime.readyClientDeviceIds()).toEqual([firstAuthorization.grantClaims.clientDeviceId])
    unavailable = false
    // The phone can still hold its old channel after this runtime has lost it.
    // Such a continuity probe grants no application authority and cannot close
    // the shared Host route used by the first browser.
    await expect(runtime.handleSessionEnvelope(secondRequest.wireText)).resolves.toBeUndefined()
    expect(routedApplications).toHaveLength(1)
    expect(runtime.readyClientDeviceIds()).toEqual([firstAuthorization.grantClaims.clientDeviceId])
    await connect(secondAuthorization, secondInfo.authority.connectionGeneration)
    expect(runtime.readyChannels()).toHaveLength(2)
    const actionId = 'revoke.second.browser'
    const revokeInput = {
      actionId,
      deviceId: secondAuthorization.grantClaims.clientDeviceId,
      authorizationId: secondAuthorization.grantClaims.authorizationId,
      authorizationEpoch: secondAuthorization.grantClaims.authorizationEpoch,
      expected: {
        hostId: firstReconnectedInfo.authority.hostId,
        connectionGeneration: firstReconnectedInfo.authority.connectionGeneration,
      },
    }
    const receipt = await runtime.managementActions.revokeDevice?.(revokeInput, {
      requestId: actionId,
      requestFingerprint: 'fingerprint.revoke.second',
      message: { kind: 'request', operation: 'device.revoke', params: revokeInput },
      authority: firstReconnectedInfo.authority,
    })
    expect(receipt).toMatchObject({ state: 'accepted' })
    expect(revoked).toEqual([secondAuthorization.grantClaims.authorizationId])
    expect(replaced).toEqual([
      firstAuthorization.grantClaims.clientDeviceId,
      secondAuthorization.grantClaims.clientDeviceId,
      secondAuthorization.grantClaims.clientDeviceId,
    ])
    expect(runtime.readyClientDeviceIds()).toEqual([firstAuthorization.grantClaims.clientDeviceId])
    expect((await store.listManagedDevices({
      currentClientDeviceId: firstAuthorization.grantClaims.clientDeviceId,
      onlineClientDeviceIds: runtime.readyClientDeviceIds(),
      generatedAt: clock,
    })).find(device => device.authorizationId === secondAuthorization.grantClaims.authorizationId))
      .toMatchObject({ status: 'revoked', presence: 'offline', lastSeenAt: null })
  }, 30_000)
})
