import {
  getEstablishedSessionChannelInfo,
  invalidateEstablishedSession,
  type CreatedHostPairingInvitation,
  type EstablishedSessionChannel,
} from '../../../packages/e2ee/src/index.ts'
import {
  decodeEnvelope,
  decodeSessionInit,
  PROTOCOL_VERSION,
} from '../../../packages/protocol/src/index.ts'

import {
  createPersistentHostPairingRuntime,
  type PersistentHostPairingRuntime,
} from './persistent-pairing-runtime.ts'
import type { LocalPairingDecision } from './pairing-session-runtime.ts'
import type { ManagementActionHandlers } from './e2ee-management-action.ts'
import type { R3RelayHostClient } from './relay-host-client.ts'
import { WindowsCompanionReadySessionError } from './ready-session.ts'
import {
  WindowsIdentityStore,
  type WindowsHostIdentity,
} from './windows-identity-store.ts'

type RawEnvelope = string | Uint8Array

export interface PersistentMultiClientHostRuntimeOptions {
  store: WindowsIdentityStore
  relayClient: R3RelayHostClient
  relayOrigin: string
  requestLocalDecision: (confirmation: Readonly<{
    deviceDisplayName: string
    sas: string
    clientSigningFingerprint: string
    expiresAt: number
  }>) => Promise<LocalPairingDecision>
  onReady?: (channel: EstablishedSessionChannel) => void | Promise<void>
  onPairingCompleted?: () => void
  onSessionReplacing?: (channel: EstablishedSessionChannel) => void | Promise<void>
  onAuthorizationRevoked?: (
    tombstone: Awaited<ReturnType<WindowsIdentityStore['revokeManagedDevice']>>,
    connectionGeneration: number | undefined,
  ) => void | Promise<void>
  onApplicationEnvelope: (
    channel: EstablishedSessionChannel,
    frame: RawEnvelope,
  ) => void | Promise<void>
  remotePermissionModes?: readonly ['ask', 'read-only'] | readonly ['ask', 'read-only', 'full-access']
  now?: () => number
}

export interface PersistentMultiClientHostRuntime {
  identity: WindowsHostIdentity
  managementActions: ManagementActionHandlers
  createInvitation(): Promise<CreatedHostPairingInvitation>
  createLocalPairingCode(): Promise<Readonly<{ code: string; expiresAt: number }>>
  handlePairJoin(frame: RawEnvelope): Promise<void>
  handleSessionInit(frame: RawEnvelope): Promise<void>
  handleSessionEnvelope(frame: RawEnvelope): Promise<void>
  readyChannels(): readonly EstablishedSessionChannel[]
  readyClientDeviceIds(): readonly string[]
}

interface RoutedRuntime {
  readonly authorizationId: string
  readonly clientDeviceId: string
  readonly value: PersistentHostPairingRuntime
}

export async function createPersistentMultiClientHostRuntime(
  options: PersistentMultiClientHostRuntimeOptions,
): Promise<PersistentMultiClientHostRuntime> {
  const now = options.now ?? Date.now
  const identity = await options.store.loadIdentity()
  const runtimesByAuthorization = new Map<string, RoutedRuntime>()
  const authorizationByClient = new Map<string, string>()

  const runtimeFor = async (
    authorizationId: string,
    clientDeviceId: string,
  ): Promise<RoutedRuntime> => {
    const existing = runtimesByAuthorization.get(authorizationId)
    if (existing !== undefined) {
      if (existing.clientDeviceId !== clientDeviceId) throw new Error('multi-client-runtime:stale-authority')
      return existing
    }
    const loaded = await options.store.loadAuthorization(authorizationId)
    const claims = loaded.material.grantClaims
    if (
      claims.hostId !== identity.hostId
      || claims.hostDeviceId !== identity.hostDeviceId
      || claims.clientDeviceId !== clientDeviceId
    ) throw new Error('multi-client-runtime:stale-authority')
    const occupied = authorizationByClient.get(clientDeviceId)
    if (occupied !== undefined && occupied !== authorizationId) {
      throw new Error('multi-client-runtime:stale-authority')
    }
    const value = await createPersistentHostPairingRuntime({
      store: options.store,
      relayClient: options.relayClient,
      relayOrigin: options.relayOrigin,
      authorizationId,
      requestLocalDecision: options.requestLocalDecision,
      onReady: async channel => {
        const info = getEstablishedSessionChannelInfo(channel)
        if (
          info.authority.authorizationId !== authorizationId
          || info.authority.clientDeviceId !== clientDeviceId
        ) throw new Error('multi-client-runtime:stale-authority')
        await options.onReady?.(channel)
      },
      onSessionReplacing: async channel => {
        if (channel !== undefined) await options.onSessionReplacing?.(channel)
      },
      ...(options.remotePermissionModes === undefined
        ? {}
        : { remotePermissionModes: options.remotePermissionModes }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    const routed = Object.freeze({ authorizationId, clientDeviceId, value })
    runtimesByAuthorization.set(authorizationId, routed)
    authorizationByClient.set(clientDeviceId, authorizationId)
    return routed
  }

  const pairing = await createPersistentHostPairingRuntime({
    store: options.store,
    relayClient: options.relayClient,
    relayOrigin: options.relayOrigin,
    authorizationId: null,
    requestLocalDecision: options.requestLocalDecision,
    ...(options.onPairingCompleted === undefined ? {} : { onPairingCompleted: options.onPairingCompleted }),
    onAuthorizationRevoked: async tombstone => {
      const routed = runtimesByAuthorization.get(tombstone.authorizationId)
      const channel = routed?.value.runtime.readyChannel()
      const generation = channel === undefined
        ? undefined
        : getEstablishedSessionChannelInfo(channel).authority.connectionGeneration
      if (channel !== undefined) {
        try { await options.onSessionReplacing?.(channel) } catch { /* revocation continues */ }
        try { invalidateEstablishedSession(channel) } catch { /* already invalid */ }
      }
      runtimesByAuthorization.delete(tombstone.authorizationId)
      if (routed !== undefined) authorizationByClient.delete(routed.clientDeviceId)
      await options.onAuthorizationRevoked?.(tombstone, generation)
    },
    ...(options.remotePermissionModes === undefined
      ? {}
      : { remotePermissionModes: options.remotePermissionModes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return Object.freeze({
    identity,
    managementActions: pairing.managementActions,
    createInvitation: () => pairing.runtime.createInvitation(),
    async createLocalPairingCode() {
      // Reachable only from the GUI owner's explicit private-pipe command.
      const invitation = await pairing.runtime.createInvitation({ requireLocalDecision: false })
      try {
        const result = await options.relayClient.registerPairingCode({
          protocolVersion: PROTOCOL_VERSION, relayType: 'pair.code.register',
          hostId: identity.hostId, hostDeviceId: identity.hostDeviceId,
          pairSessionId: invitation.handle.pairSessionId,
          expiresAt: invitation.handle.expiresAt,
          invitationFragment: invitation.invitationFragment,
        })
        return Object.freeze({ code: result.code, expiresAt: result.expiresAt })
      } catch (error) {
        await pairing.runtime.cancelInvitation(invitation.handle.pairSessionId).catch(() => undefined)
        throw error
      }
    },
    handlePairJoin: (frame: RawEnvelope) => pairing.runtime.handlePairJoin(frame),
    async handleSessionInit(frame: RawEnvelope) {
      const init = decodeSessionInit(frame, {
        expectedRelayOrigin: options.relayOrigin,
        now: now(),
      })
      if (init.hostId !== identity.hostId || init.hostDeviceId !== identity.hostDeviceId) {
        throw new Error('multi-client-runtime:stale-authority')
      }
      const routed = await runtimeFor(init.authorizationId, init.clientDeviceId)
      await routed.value.runtime.handleSessionInit(frame)
    },
    async handleSessionEnvelope(frame: RawEnvelope) {
      const envelope = decodeEnvelope(frame, { now: now() })
      if (envelope.hostId !== identity.hostId || envelope.toDeviceId !== identity.hostDeviceId) {
        throw new Error('multi-client-runtime:stale-authority')
      }
      const authorizationId = authorizationByClient.get(envelope.fromDeviceId)
      if (authorizationId === undefined) return
      const routed = runtimesByAuthorization.get(authorizationId)
      if (routed === undefined) return
      const channel = routed.value.runtime.readyChannel()
      if (channel === undefined) {
        // A retained browser key may probe after this Host restarted. No
        // application authority exists until a new session confirm succeeds.
        if (envelope.messageType !== 'control' || envelope.seq !== 1) return
        await routed.value.runtime.handleSessionEnvelope(frame)
        return
      }
      const info = getEstablishedSessionChannelInfo(channel)
      // An old frame can already be queued when this device replaces its
      // session. Discard it; never tear down the shared Host socket for it.
      if (envelope.connectionGeneration < info.authority.connectionGeneration) return
      if (
        info.authority.connectionGeneration !== envelope.connectionGeneration
        || info.inboundKeyId !== envelope.keyId
      ) throw new Error('multi-client-runtime:stale-authority')
      try {
        await options.onApplicationEnvelope(channel, frame)
      } catch (error) {
        if (!(error instanceof WindowsCompanionReadySessionError) || error.code !== 'relay-unavailable') throw error
        // The browser went away while its reply was being delivered. Its
        // channel is invalid, but another browser's Host route remains live.
        await options.onSessionReplacing?.(channel)
        try { invalidateEstablishedSession(channel) } catch { /* already invalid */ }
        runtimesByAuthorization.delete(authorizationId)
        authorizationByClient.delete(envelope.fromDeviceId)
      }
    },
    readyChannels() {
      return Object.freeze([...runtimesByAuthorization.values()]
        .map(value => value.value.runtime.readyChannel())
        .filter((value): value is EstablishedSessionChannel => value !== undefined))
    },
    readyClientDeviceIds() {
      return Object.freeze([...runtimesByAuthorization.values()]
        .filter(value => value.value.runtime.readyChannel() !== undefined)
        .map(value => value.clientDeviceId))
    },
  })
}
