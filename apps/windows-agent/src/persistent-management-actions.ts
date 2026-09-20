import type {
  ActionReceipt,
  PairingCreateReceipt,
} from '../../../packages/codex-serve-client/src/index.ts'
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/index.ts'

import type { ManagementActionHandlers } from './e2ee-management-action.ts'
import type { R3RelayHostClient } from './relay-host-client.ts'
import {
  WindowsIdentityStore,
  WindowsIdentityStoreError,
} from './windows-identity-store.ts'

type ManagementReceipt = ActionReceipt | PairingCreateReceipt

function rejected(
  actionId: string,
  code: 'action-id-conflict' | 'capability-denied' | 'stale-host',
  message: string,
): Extract<ActionReceipt, { state: 'rejected' }> {
  return Object.freeze({
    actionId,
    state: 'rejected' as const,
    rejection: Object.freeze({ code, message }),
  })
}

export function createPersistentManagementActionHandlers(options: Readonly<{
  store: WindowsIdentityStore
  relayClient: R3RelayHostClient
  onAuthorizationRevoked?: (
    tombstone: Awaited<ReturnType<WindowsIdentityStore['revokeManagedDevice']>>,
  ) => void | Promise<void>
  createPairingInvitation: () => Promise<Readonly<{
    invitationFragment: string
    expiresAt: number
  }>>
}>): ManagementActionHandlers {
  const actions = new Map<string, Readonly<{
    fingerprint: string
    result: Promise<ManagementReceipt>
  }>>()

  const once = <T extends ManagementReceipt>(
    actionId: string,
    fingerprint: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const existing = actions.get(actionId)
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? existing.result as Promise<T>
        : Promise.resolve(rejected(
            actionId,
            'action-id-conflict',
            'The action id was already used for another management action.',
          ) as T)
    }
    if (actions.size >= 256) {
      return Promise.resolve(rejected(
        actionId,
        'capability-denied',
        'The management action window is full.',
      ) as T)
    }
    const result = run()
    actions.set(actionId, Object.freeze({ fingerprint, result }))
    return result
  }

  const handlers: ManagementActionHandlers = {
    createPairing(input, context) {
      return once(input.actionId, context.requestFingerprint, async () => {
        const invitation = await options.createPairingInvitation()
        return Object.freeze({
          actionId: input.actionId,
          state: 'accepted' as const,
          invitationFragment: invitation.invitationFragment,
          expiresAt: invitation.expiresAt,
        })
      })
    },

    renameDevice(input, context) {
      return once(input.actionId, context.requestFingerprint, async () => {
        try {
          await options.store.renameManagedDevice(input)
          return Object.freeze({ actionId: input.actionId, state: 'accepted' as const })
        } catch (error) {
          return error instanceof WindowsIdentityStoreError && error.code === 'stale-authority'
            ? rejected(input.actionId, 'stale-host', 'The device authority changed.')
            : rejected(input.actionId, 'capability-denied', 'The device cannot be renamed.')
        }
      })
    },

    revokeDevice(input, context) {
      return once(input.actionId, context.requestFingerprint, async () => {
        let tombstone
        try {
          tombstone = await options.store.revokeManagedDevice({
            currentClientDeviceId: context.authority.clientDeviceId,
            deviceId: input.deviceId,
            authorizationId: input.authorizationId,
            authorizationEpoch: input.authorizationEpoch,
          })
        } catch (error) {
          return error instanceof WindowsIdentityStoreError && error.code === 'stale-authority'
            ? rejected(input.actionId, 'stale-host', 'The device authority changed.')
            : rejected(input.actionId, 'capability-denied', 'The device cannot be revoked.')
        }
        try {
          await options.onAuthorizationRevoked?.(tombstone)
        } catch {
          // Local revocation is already durable; Relay synchronization still proceeds.
        }
        try {
          const applied = await options.relayClient.putAuthorization({
            protocolVersion: PROTOCOL_VERSION,
            relayType: 'authorization.put',
            ...tombstone,
          })
          if (
            applied.status !== 'revoked'
            || applied.authorizationId !== tombstone.authorizationId
            || applied.authorizationEpoch !== tombstone.authorizationEpoch
            || applied.hostAuthorizationRevision !== tombstone.hostAuthorizationRevision
          ) throw new Error('relay-authority-mismatch')
          return Object.freeze({
            actionId: input.actionId,
            state: 'accepted' as const,
            revision: tombstone.hostAuthorizationRevision,
          })
        } catch {
          return Object.freeze({ actionId: input.actionId, state: 'queued' as const })
        }
      })
    },
  }
  return Object.freeze(handlers)
}
