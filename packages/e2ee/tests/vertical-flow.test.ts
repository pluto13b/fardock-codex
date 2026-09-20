import { describe, expect, it } from 'vitest'

import {
  PROTOCOL_VERSION,
  ProtocolViolation,
  type EnvelopeHeader,
} from '@codex-plus/protocol'

import {
  acceptClientSessionConfirm,
  acceptHostSessionReady,
  approveHostPairing,
  createClientPairJoin,
  createClientSessionConfirm,
  createClientSessionInit,
  createHostPairingInvitation,
  createHostSessionAccept,
  createHostSessionReady,
  deriveClientSessionAfterGenerationCommit,
  generateAgreementKeyPair,
  generateSigningKeyPair,
  getEstablishedSessionChannelInfo,
  openClientPairResult,
  openEstablishedApplication,
  openHostPairJoin,
  sealEstablishedApplication,
  validateSessionAcceptForClient,
  validateSessionInitForHost,
} from '../src/index.ts'

const now = 1_800_000_000_000
const relayOrigin = 'https://relay.example.test'

describe('pairing to encrypted application vertical flow', () => {
  it('preserves an exact user turn through grant, key-confirm and seq-2 AEAD', async () => {
    let hostClock = now
    const [hostAgreement, hostSigning] = await Promise.all([
      generateAgreementKeyPair(),
      generateSigningKeyPair(),
    ])
    const invitation = await createHostPairingInvitation({
      relayOrigin,
      hostId: 'host.vertical',
      hostDeviceId: 'device.windows',
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      now,
      clock: () => hostClock,
    })
    const clientJoin = await createClientPairJoin({
      invitationFragment: invitation.invitationFragment,
      expectedRelayOrigin: relayOrigin,
      deviceDisplayName: 'Vertical Phone',
      now: now + 100,
    })
    hostClock = now + 200
    const join = await openHostPairJoin({
      invitation: invitation.handle,
      attemptId: 'attempt.vertical',
      wireFrame: clientJoin.wireText,
      now: hostClock,
    })
    expect(join.outcome).toBe('pending-confirmation')
    if (join.outcome !== 'pending-confirmation') throw new Error('pairing failed')

    let durableAuthorizationId: string | undefined
    hostClock = now + 300
    const approval = await approveHostPairing({
      confirmation: join.confirmation,
      persistenceAdapter: {
        async commitAuthorizationAndUpsertRelay({ authorization }) {
          durableAuthorizationId = authorization.grantClaims.authorizationId
          return { relayRevision: 1, nextGeneration: 1 }
        },
      },
      now: hostClock,
    })
    expect(durableAuthorizationId).toBe(approval.authorization.grantClaims.authorizationId)
    const clientGrant = await openClientPairResult(
      clientJoin.handle,
      approval.wireText,
      now + 301,
    )
    expect(clientGrant.outcome).toBe('approved')
    if (clientGrant.outcome !== 'approved') throw new Error('grant failed')

    const clientAuthorization = {
      status: 'active' as const,
      ...clientGrant.authorization,
    }
    const hostAuthorization = {
      status: 'active' as const,
      grantClaims: approval.authorization.grantClaims,
      grantClaimsHash: approval.authorization.grantClaimsHash,
      hostGrantSignature: approval.authorization.hostGrantSignature,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPublicKey: hostSigning.publicKey,
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostSigningPrivateKey: hostSigning.privateKey,
    }

    const init = await createClientSessionInit({
      authorization: clientAuthorization,
      now: now + 400,
      expiresAt: now + 20_000,
    })
    let nextGeneration = approval.persistence.nextGeneration
    const hostValidated = await validateSessionInitForHost({
      authorization: hostAuthorization,
      frame: init.frame,
      now: now + 401,
      async reserveGeneration(request) {
        expect(request.authorizationId).toBe(durableAuthorizationId)
        const reserved = nextGeneration
        nextGeneration += 1
        return reserved
      },
    })
    const hostAwaiting = await createHostSessionAccept({
      state: hostValidated,
      now: now + 402,
      expiresAt: now + 15_000,
    })
    let clientGenerationHighWater = 0
    const clientValidated = await validateSessionAcceptForClient({
      state: init,
      frame: hostAwaiting.frame,
      now: now + 403,
      async installGeneration(request) {
        const previous = clientGenerationHighWater
        if (request.connectionGeneration <= previous) {
          throw new ProtocolViolation('stale-authority')
        }
        clientGenerationHighWater = request.connectionGeneration
        return previous
      },
    })
    const clientAwaiting = await deriveClientSessionAfterGenerationCommit({
      state: clientValidated,
    })
    const confirm = await createClientSessionConfirm({
      state: clientAwaiting,
      now: now + 404,
      expiresAt: now + 10_000,
    })
    const hostConfirmed = await acceptClientSessionConfirm({
      state: hostAwaiting,
      frame: confirm.wireText,
      now: now + 405,
    })
    const hostReady = await createHostSessionReady({
      state: hostConfirmed,
      now: now + 406,
      expiresAt: now + 10_000,
    })
    const clientChannel = await acceptHostSessionReady({
      state: clientAwaiting,
      frame: hostReady.ready.wireText,
      now: now + 407,
    })

    const clientInfo = getEstablishedSessionChannelInfo(clientChannel)
    const originalText = '  请继续检查远程链路\n保留中文、🙂 与尾部空格  '
    const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: clientInfo.authority.connectionGeneration,
      fromDeviceId: clientInfo.authority.clientDeviceId,
      toDeviceId: clientInfo.authority.hostDeviceId,
      hostId: clientInfo.authority.hostId,
      keyId: clientInfo.outboundKeyId,
      requestId: 'action.vertical',
      taskId: 'task.vertical',
      sentAt: now + 500,
      expiresAt: now + 10_000,
      messageType: 'request',
    }
    const message = {
      kind: 'request' as const,
      operation: 'turn.send' as const,
      params: {
        taskId: 'task.vertical',
        input: {
          actionId: 'action.vertical',
          input: [{ type: 'text' as const, text: originalText }],
          settings: { model: 'gpt-5', effort: 'high' as const, permission: 'ask' as const },
          expected: {
            hostId: clientInfo.authority.hostId,
            connectionGeneration: clientInfo.authority.connectionGeneration,
            revision: 7,
          },
        },
      },
    }
    let reservedSequence = 1
    let storedWireText: string | undefined
    const sealed = await sealEstablishedApplication({
      state: clientChannel,
      header,
      message,
      now: now + 500,
      assertAuthorizationActive: async authority => {
        expect(authority.authorizationId).toBe(durableAuthorizationId)
      },
      persistence: {
        async reserveSequence(request) {
          expect(request.expectedSequence).toBe(reservedSequence + 1)
          reservedSequence += 1
          return reservedSequence
        },
        async commitFrame(request) {
          storedWireText = request.wireText
        },
      },
    })
    expect(storedWireText).toBe(sealed.wireText)
    let committed = false
    const opened = await openEstablishedApplication({
      state: hostReady.channel,
      frame: sealed.wireText,
      now: now + 501,
      assertAuthorizationActive: async authority => {
        expect(authority.authorizationId).toBe(durableAuthorizationId)
      },
      async commitInbound(request) {
        expect(request.sequence).toBe(2)
        expect(request.ack).toBe(1)
        committed = true
      },
    })
    expect(committed).toBe(true)
    expect(opened.message).toMatchObject({
      kind: 'request',
      operation: 'turn.send',
      params: { input: { input: [{ text: originalText }] } },
    })
  })
})
