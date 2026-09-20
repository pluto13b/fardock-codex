import type {
  EstablishedSessionChannel,
} from '../../../packages/e2ee/src/index.ts'

import {
  createEphemeralHostPairingRuntime,
  type EphemeralHostPairingRuntime,
  type LocalPairingDecision,
} from './pairing-session-runtime.ts'
import type { R3RelayHostClient } from './relay-host-client.ts'
import {
  createPersistentManagementActionHandlers,
} from './persistent-management-actions.ts'
import type { ManagementActionHandlers } from './e2ee-management-action.ts'
import {
  WindowsIdentityStore,
  type WindowsHostIdentity,
} from './windows-identity-store.ts'

export interface PersistentHostPairingRuntimeOptions {
  store: WindowsIdentityStore
  relayClient: R3RelayHostClient
  relayOrigin: string
  /** null creates a pairing-only runtime even when active authorizations already exist. */
  authorizationId?: string | null
  requestLocalDecision: (confirmation: Readonly<{
    deviceDisplayName: string
    sas: string
    clientSigningFingerprint: string
    expiresAt: number
  }>) => Promise<LocalPairingDecision>
  onReady?: (channel: EstablishedSessionChannel) => void | Promise<void>
  onPairingCompleted?: () => void
  onSessionReplacing?: (channel: EstablishedSessionChannel | undefined) => void | Promise<void>
  onAuthorizationRevoked?: (
    tombstone: Awaited<ReturnType<WindowsIdentityStore['revokeManagedDevice']>>,
  ) => void | Promise<void>
  remotePermissionModes?: readonly ['ask', 'read-only'] | readonly ['ask', 'read-only', 'full-access']
  now?: () => number
}

export interface PersistentHostPairingRuntime {
  identity: WindowsHostIdentity
  runtime: EphemeralHostPairingRuntime
  managementActions: ManagementActionHandlers
}

export async function createPersistentHostPairingRuntime(
  options: PersistentHostPairingRuntimeOptions,
): Promise<PersistentHostPairingRuntime> {
  const identity = await options.store.loadIdentity()
  let authorizationId = options.authorizationId
  if (authorizationId === undefined) {
    const active = await options.store.activeAuthorizationIds()
    if (active.length > 1) throw new Error('persistent-runtime:authorization-ambiguous')
    authorizationId = active[0]
  }
  const persisted = authorizationId === undefined || authorizationId === null
    ? undefined
    : await options.store.loadAuthorization(authorizationId)
  const runtime = createEphemeralHostPairingRuntime({
    relayClient: options.relayClient,
    relayOrigin: options.relayOrigin,
    hostId: identity.hostId,
    hostDeviceId: identity.hostDeviceId,
    hostAgreementPrivateKey: identity.hostAgreementPrivateKey,
    hostAgreementPublicKey: identity.hostAgreementPublicKey,
    hostSigningPrivateKey: identity.hostSigningPrivateKey,
    hostSigningPublicKey: identity.hostSigningPublicKey,
    requestLocalDecision: options.requestLocalDecision,
    commitAuthorizationLocally: authorization => options.store.commitAuthorization(authorization),
    ...(persisted === undefined ? {} : {
      initialAuthorization: persisted.material,
      initialNextGeneration: persisted.nextGeneration,
    }),
    reserveGeneration: request => options.store.reserveGeneration(request),
    ...(options.onReady === undefined ? {} : { onReady: options.onReady }),
    ...(options.onPairingCompleted === undefined ? {} : { onPairingCompleted: options.onPairingCompleted }),
    ...(options.onSessionReplacing === undefined ? {} : { onSessionReplacing: options.onSessionReplacing }),
    ...(options.remotePermissionModes === undefined
      ? {}
      : { remotePermissionModes: options.remotePermissionModes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const managementActions = createPersistentManagementActionHandlers({
    store: options.store,
    relayClient: options.relayClient,
    ...(options.onAuthorizationRevoked === undefined
      ? {}
      : { onAuthorizationRevoked: options.onAuthorizationRevoked }),
    createPairingInvitation: async () => {
      const invitation = await runtime.createInvitation({ requireLocalDecision: false })
      return {
        invitationFragment: invitation.invitationFragment,
        expiresAt: invitation.handle.expiresAt,
      }
    },
  })
  return Object.freeze({ identity, runtime, managementActions })
}
