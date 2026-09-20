import {
  createClientPairJoin,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  openClientPairResult,
} from '../../../packages/e2ee/src/index.ts'
import { PROTOCOL_VERSION } from '../../../packages/protocol/src/index.ts'
import { describe, expect, it, vi } from 'vitest'

import { createEphemeralHostPairingRuntime } from '../src/pairing-session-runtime.ts'
import type { R3RelayHostClient } from '../src/relay-host-client.ts'

const ORIGIN = 'https://relay.example.test'
const NOW = 1_900_000_000_000

describe('preauthorized Host pairing invitation', () => {
  it('auto-approves only when the invitation was explicitly created as preauthorized', async () => {
    const [hostAgreement, hostSigning] = await Promise.all([
      generateAgreementKeyPair(),
      generateSigningKeyPair(),
    ])
    let pairResult: string | Uint8Array | undefined
    const requestLocalDecision = vi.fn(async () => ({ decision: 'deny' as const }))
    const commitAuthorizationLocally = vi.fn(async () => ({
      hostAuthorizationRevision: 1,
      nextGeneration: 1,
    }))
    const relayClient: R3RelayHostClient = {
      connect: async () => {},
      putAuthorization: async update => ({ ...update, relayType: 'authorization.applied' }),
      openPairSession: async open => ({ ...open, relayType: 'pair.opened' }),
      registerPairingCode: async () => { throw new Error('unused') },
      claimPairSession: async claim => ({ ...claim, relayType: 'pair.claimed' }),
      sendPairResult: async frame => { pairResult = frame },
      closePairSession: async () => {},
      sendSessionAccept: async () => { throw new Error('unused') },
      sendEnvelope: async () => { throw new Error('unused') },
      onUnexpectedDisconnect: () => () => {},
      close: async () => {},
    }
    const runtime = createEphemeralHostPairingRuntime({
      relayClient,
      relayOrigin: ORIGIN,
      hostId: 'host.auto-approve',
      hostDeviceId: 'device.windows',
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      requestLocalDecision,
      commitAuthorizationLocally,
      remotePermissionModes: ['ask', 'read-only', 'full-access'],
      now: () => NOW,
    })
    const created = await runtime.createInvitation({ requireLocalDecision: false })
    const join = await createClientPairJoin({
      invitationFragment: created.invitationFragment,
      expectedRelayOrigin: ORIGIN,
      deviceDisplayName: 'Android Chrome',
      now: NOW,
    })
    await runtime.handlePairJoin(join.wireText)
    expect(requestLocalDecision).not.toHaveBeenCalled()
    expect(commitAuthorizationLocally).toHaveBeenCalledOnce()
    expect(pairResult).toBeDefined()
    await expect(openClientPairResult(join.handle, pairResult!, NOW)).resolves.toMatchObject({
      outcome: 'approved',
      authorization: {
        grantClaims: { remotePermissionModes: ['ask', 'read-only', 'full-access'] },
      },
    })
    expect(PROTOCOL_VERSION).toBe(1)
  })
})
