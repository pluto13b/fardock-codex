import { describe, expect, it } from 'vitest'

import { createPersistentManagementActionHandlers } from '../src/persistent-management-actions.ts'
import type { R3RelayHostClient } from '../src/relay-host-client.ts'
import type { WindowsIdentityStore } from '../src/windows-identity-store.ts'

const context = {
  requestId: 'manage-action',
  requestFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  message: {} as any,
  authority: {
    relayOrigin: 'https://relay.example.test',
    hostId: 'host-1',
    hostDeviceId: 'windows-1',
    clientDeviceId: 'client-current',
    authorizationId: 'authorization-current',
    authorizationEpoch: 1,
    handshakeId: 'handshake-1',
    connectionGeneration: 1,
    sessionTranscriptHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  },
} as any

function relay(putAuthorization: R3RelayHostClient['putAuthorization']): R3RelayHostClient {
  return {
    connect: async () => {},
    putAuthorization,
    openPairSession: async () => { throw new Error('unused') },
    registerPairingCode: async () => { throw new Error('unused') },
    claimPairSession: async () => { throw new Error('unused') },
    sendPairResult: async () => { throw new Error('unused') },
    closePairSession: async () => { throw new Error('unused') },
    sendSessionAccept: async () => { throw new Error('unused') },
    sendEnvelope: async () => { throw new Error('unused') },
    onUnexpectedDisconnect: () => () => {},
    close: async () => {},
  }
}

describe('persistent management action handlers', () => {
  it('memoizes pairing and rename actions and detects action-id conflicts', async () => {
    let invitations = 0
    let renames = 0
    const store = {
      renameManagedDevice: async () => { renames += 1 },
      revokeManagedDevice: async () => { throw new Error('unused') },
    } as unknown as WindowsIdentityStore
    const handlers = createPersistentManagementActionHandlers({
      store,
      relayClient: relay(async () => { throw new Error('unused') }),
      createPairingInvitation: async () => {
        invitations += 1
        return { invitationFragment: 'cGFpcmluZw', expiresAt: 1_800_000_120_000 }
      },
    })
    const pairingInput = {
      actionId: 'pair-1', expected: { hostId: 'host-1', connectionGeneration: 1 },
    }
    await expect(handlers.createPairing!(pairingInput, context)).resolves.toMatchObject({ state: 'accepted' })
    await expect(handlers.createPairing!(pairingInput, context)).resolves.toMatchObject({ state: 'accepted' })
    expect(invitations).toBe(1)

    const renameInput = {
      actionId: 'rename-1', deviceId: 'client-old', authorizationId: 'authorization-old',
      authorizationEpoch: 1, displayName: '旧手机',
      expected: { hostId: 'host-1', connectionGeneration: 1 },
    }
    await expect(handlers.renameDevice!(renameInput, context)).resolves.toEqual({ actionId: 'rename-1', state: 'accepted' })
    await expect(handlers.renameDevice!(renameInput, context)).resolves.toEqual({ actionId: 'rename-1', state: 'accepted' })
    expect(renames).toBe(1)
    await expect(handlers.renameDevice!({ ...renameInput, displayName: '另一设备' }, {
      ...context, requestFingerprint: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    })).resolves.toMatchObject({ state: 'rejected', rejection: { code: 'action-id-conflict' } })
  })

  it('persists a Host-first tombstone before sending it to Relay', async () => {
    const order: string[] = []
    const store = {
      renameManagedDevice: async () => {},
      revokeManagedDevice: async () => {
        order.push('windows-revoked')
        return {
          hostId: 'host-1', hostDeviceId: 'windows-1', clientDeviceId: 'client-old',
          authorizationId: 'authorization-old', authorizationEpoch: 2,
          hostAuthorizationRevision: 7, status: 'revoked' as const,
        }
      },
    } as unknown as WindowsIdentityStore
    const handlers = createPersistentManagementActionHandlers({
      store,
      relayClient: relay(async update => {
        order.push('relay-tombstone')
        return { ...update, relayType: 'authorization.applied' }
      }),
      createPairingInvitation: async () => { throw new Error('unused') },
    })
    await expect(handlers.revokeDevice!({
      actionId: 'revoke-1', deviceId: 'client-old', authorizationId: 'authorization-old',
      authorizationEpoch: 1, expected: { hostId: 'host-1', connectionGeneration: 1 },
    }, context)).resolves.toEqual({ actionId: 'revoke-1', state: 'accepted', revision: 7 })
    expect(order).toEqual(['windows-revoked', 'relay-tombstone'])
  })
})
