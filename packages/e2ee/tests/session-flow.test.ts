import { describe, expect, it } from 'vitest'

import {
  PROTOCOL_VERSION,
  ProtocolViolation,
  decodeBase64Url,
  decodeSessionAccept,
  encodeBase64Url,
  encodeGrantClaims,
  encodeGrantSignatureInput,
  type EnvelopeHeader,
  type GrantClaims,
} from '@codex-plus/protocol'

import {
  E2eeError,
  exportPublicJwk,
  fingerprintP256PublicJwk,
  generateAgreementKeyPair,
  generateSigningKeyPair,
} from '../src/index.ts'
import { sha256, signP256 } from '../src/primitives.ts'
import {
  acceptClientSessionConfirm,
  acceptHostSessionReady,
  createClientSessionConfirm,
  createClientSessionInit,
  createHostSessionAccept,
  createHostSessionReady,
  deriveClientSessionAfterGenerationCommit,
  disposeSessionState,
  getCachedOutboundFrame,
  getEstablishedSessionChannelInfo,
  invalidateAuthorizationSessions,
  openEstablishedApplication,
  sealEstablishedApplication,
  validateSessionAcceptForClient,
  validateSessionInitForHost,
  type ClientSessionAuthorization,
  type ClientGenerationInstallRequest,
  type EstablishedSessionChannel,
  type HostGenerationReservationRequest,
  type HostSessionAuthorization,
} from '../src/session-flow.ts'

const now = 1_800_000_000_000
const encoder = new TextEncoder()
let nextFixtureId = 0

interface Fixture {
  claims: GrantClaims
  grantClaimsHash: string
  clientAuthorization: ClientSessionAuthorization
  hostAuthorization: HostSessionAuthorization
}

async function fixture(): Promise<Fixture> {
  const fixtureId = ++nextFixtureId
  const [hostAgreement, hostSigning, clientAgreement, clientSigning] = await Promise.all([
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const [hostAgreementKey, hostSigningKey, clientAgreementKey, clientSigningKey] = await Promise.all([
    exportPublicJwk(hostAgreement.publicKey),
    exportPublicJwk(hostSigning.publicKey),
    exportPublicJwk(clientAgreement.publicKey),
    exportPublicJwk(clientSigning.publicKey),
  ])
  const [hostSigningFingerprint, clientSigningFingerprint] = await Promise.all([
    fingerprintP256PublicJwk(hostSigningKey),
    fingerprintP256PublicJwk(clientSigningKey),
  ])
  const bytes = (value: number): string => encodeBase64Url(new Uint8Array(32).fill(value))
  const claims: GrantClaims = {
    protocolVersion: PROTOCOL_VERSION,
    relayOrigin: 'https://relay.example.test',
    hostId: 'host-main',
    hostDeviceId: 'host-windows',
    clientDeviceId: 'client-phone',
    authorizationId: `authorization-${fixtureId}`,
    authorizationEpoch: 1,
    issuedAt: now - 60_000,
    pairingTranscriptHash: bytes(1),
    joinClaimsHash: bytes(2),
    clientChallenge: bytes(3),
    hostChallenge: bytes(4),
    hostAgreementKey,
    hostSigningKey,
    hostSigningFingerprint,
    clientAgreementKey,
    clientSigningKey,
    clientSigningFingerprint,
    remotePermissionModes: ['ask', 'read-only'],
    approvalDecisions: ['approve-once', 'deny'],
  }
  const grantClaimsHash = encodeBase64Url(
    await sha256(encoder.encode(encodeGrantClaims(claims))),
  )
  const hostGrantSignature = encodeBase64Url(await signP256(
    hostSigning.privateKey,
    encodeGrantSignatureInput(claims),
  ))
  return {
    claims,
    grantClaimsHash,
    clientAuthorization: {
      status: 'active',
      grantClaims: claims,
      grantClaimsHash,
      hostGrantSignature,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPublicKey: hostSigning.publicKey,
      clientAgreementPrivateKey: clientAgreement.privateKey,
      clientSigningPrivateKey: clientSigning.privateKey,
    },
    hostAuthorization: {
      status: 'active',
      grantClaims: claims,
      grantClaimsHash,
      hostGrantSignature,
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPublicKey: hostSigning.publicKey,
      hostAgreementPrivateKey: hostAgreement.privateKey,
      hostSigningPrivateKey: hostSigning.privateKey,
    },
  }
}

function hostGenerationStore(initialHighWater: number) {
  let highWater = initialHighWater
  const handshakeIds = new Set<string>()
  const clientNonces = new Set<string>()
  return async (request: Readonly<HostGenerationReservationRequest>): Promise<number> => {
    if (handshakeIds.has(request.handshakeId) || clientNonces.has(request.clientNonce)) {
      throw new ProtocolViolation('replay')
    }
    handshakeIds.add(request.handshakeId)
    clientNonces.add(request.clientNonce)
    highWater += 1
    return highWater
  }
}

function clientGenerationStore(initialHighWater: number) {
  let highWater = initialHighWater
  return async (request: Readonly<ClientGenerationInstallRequest>): Promise<number> => {
    const previous = highWater
    if (request.connectionGeneration <= highWater) {
      throw new ProtocolViolation('stale-authority')
    }
    highWater = request.connectionGeneration
    return previous
  }
}

function outboundPersistence(initialHighWater = 1) {
  let highWater = initialHighWater
  const frames = new Map<number, string>()
  return {
    frames,
    async reserveSequence(request: { expectedSequence: number }): Promise<number> {
      expect(request.expectedSequence).toBe(highWater + 1)
      highWater += 1
      return highWater
    },
    async commitFrame(request: { sequence: number; wireText: string }): Promise<void> {
      if (frames.has(request.sequence)) throw new ProtocolViolation('replay')
      frames.set(request.sequence, request.wireText)
    },
  }
}

async function prepareAccept(highWater = 5) {
  const value = await fixture()
  const clientInit = await createClientSessionInit({
    authorization: value.clientAuthorization,
    now,
    expiresAt: now + 25_000,
  })
  const hostValidated = await validateSessionInitForHost({
    authorization: value.hostAuthorization,
    reserveGeneration: hostGenerationStore(highWater),
    frame: clientInit.frame,
    now: now + 10,
  })
  const hostAwaiting = await createHostSessionAccept({
    state: hostValidated,
    now: now + 20,
    expiresAt: now + 20_000,
  })
  return { value, clientInit, hostAwaiting, highWater }
}

async function prepareAwaitingReady() {
  const prepared = await prepareAccept()
  const clientValidated = await validateSessionAcceptForClient({
    state: prepared.clientInit,
    frame: prepared.hostAwaiting.frame,
    now: now + 30,
    installGeneration: clientGenerationStore(prepared.highWater),
  })
  const clientAwaiting = await deriveClientSessionAfterGenerationCommit({
    state: clientValidated,
  })
  return { ...prepared, clientAwaiting }
}

function mutateCanonicalFrame(
  frame: string,
  mutate: (value: Record<string, unknown>) => void,
): string {
  const value = JSON.parse(frame) as Record<string, unknown>
  mutate(value)
  return JSON.stringify(value)
}

function tamperBase64Url(value: string): string {
  const bytes = decodeBase64Url(value)
  if (bytes === undefined) throw new Error('fixture base64url is invalid')
  bytes[0] ^= 1
  return encodeBase64Url(bytes)
}

describe('daily E2EE session flow', () => {
  it('clamps Host accept expiry to the still-live Client window under allowed clock skew', async () => {
    const value = await fixture()
    const clientInit = await createClientSessionInit({
      authorization: value.clientAuthorization,
      now,
      expiresAt: now + 30_000,
    })
    const hostValidated = await validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: hostGenerationStore(0),
      frame: clientInit.frame,
      now: now + 12_000,
    })
    const hostAwaiting = await createHostSessionAccept({
      state: hostValidated,
      now: now + 12_000,
      expiresAt: now + 32_000,
    })
    const accept = decodeSessionAccept(hostAwaiting.frame, {
      expectedRelayOrigin: value.claims.relayOrigin,
      now: now + 12_000,
    })
    expect(accept.expiresAt).toBe(now + 30_000)
    disposeSessionState(clientInit)
    disposeSessionState(hostAwaiting)
  })

  it('uses the signed Client issue time when it is slightly ahead of the Host clock', async () => {
    const value = await fixture()
    const clientInit = await createClientSessionInit({
      authorization: value.clientAuthorization,
      now: now + 5_000,
      expiresAt: now + 30_000,
    })
    const hostValidated = await validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: hostGenerationStore(0),
      frame: clientInit.frame,
      now,
    })
    const hostAwaiting = await createHostSessionAccept({
      state: hostValidated,
      now,
      expiresAt: now + 20_000,
    })
    const accept = decodeSessionAccept(hostAwaiting.frame, {
      expectedRelayOrigin: value.claims.relayOrigin,
      now,
    })
    expect(accept.issuedAt).toBe(now + 5_000)
    expect(accept.expiresAt).toBe(now + 20_000)
    disposeSessionState(clientInit)
    disposeSessionState(hostAwaiting)
  })

  it('establishes only after confirm/ready and returns seq-2 directional channel capabilities', async () => {
    const prepared = await prepareAwaitingReady()
    const [confirm, cachedConfirm] = await Promise.all([
      createClientSessionConfirm({
        state: prepared.clientAwaiting,
        now: now + 40,
        expiresAt: now + 10_000,
      }),
      createClientSessionConfirm({
        state: prepared.clientAwaiting,
        now: now + 50,
        expiresAt: now + 11_000,
      }),
    ])
    expect(cachedConfirm).toBe(confirm)
    expect(cachedConfirm.wireText).toBe(confirm.wireText)
    expect(Object.isFrozen(confirm)).toBe(true)
    expect(Object.isFrozen(confirm.envelope)).toBe(true)

    const hostConfirmed = await acceptClientSessionConfirm({
      state: prepared.hostAwaiting,
      frame: confirm.wireText,
      now: now + 50,
    })
    const [ready, cachedReady] = await Promise.all([
      createHostSessionReady({
        state: hostConfirmed,
        now: now + 60,
        expiresAt: now + 10_000,
      }),
      createHostSessionReady({
        state: hostConfirmed,
        now: now + 70,
        expiresAt: now + 11_000,
      }),
    ])
    expect(cachedReady).toBe(ready)
    expect(cachedReady.ready.wireText).toBe(ready.ready.wireText)

    const clientChannel = await acceptHostSessionReady({
      state: prepared.clientAwaiting,
      frame: ready.ready.wireText,
      now: now + 70,
    })
    const clientInfo = getEstablishedSessionChannelInfo(clientChannel)
    const hostInfo = getEstablishedSessionChannelInfo(ready.channel)
    expect(clientInfo.authority).toEqual(hostInfo.authority)
    expect(clientInfo.sequenceState).toEqual({
      nextOutboundSequence: 2,
      maxSentSequence: 1,
      lastAcceptedInboundSequence: 1,
      lastPeerAck: 1,
    })
    expect(hostInfo.sequenceState.lastPeerAck).toBe(0)
    expect(clientInfo.outboundKeyId).toBe(hostInfo.inboundKeyId)
    expect(clientInfo.outboundKeyId).not.toBe(clientInfo.inboundKeyId)

    const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: clientInfo.authority.connectionGeneration,
      fromDeviceId: prepared.value.claims.clientDeviceId,
      toDeviceId: prepared.value.claims.hostDeviceId,
      hostId: prepared.value.claims.hostId,
      keyId: clientInfo.outboundKeyId,
      requestId: 'request-after-ready',
      sentAt: now + 80,
      expiresAt: now + 15_000,
      messageType: 'request',
    }
    const message = {
      kind: 'request' as const,
      operation: 'workspace.list' as const,
      params: {},
    }
    const sealed = await sealEstablishedApplication({
      state: clientChannel,
      header,
      message,
      now: now + 80,
      assertAuthorizationActive: async () => {},
      persistence: outboundPersistence(),
    })
    expect(getCachedOutboundFrame(clientChannel, 2)).toBe(sealed)
    await expect(openEstablishedApplication({
      state: ready.channel,
      frame: sealed.wireText,
      now: now + 80,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })).resolves.toMatchObject({ message })
    expect(getEstablishedSessionChannelInfo(ready.channel).sequenceState).toMatchObject({
      lastAcceptedInboundSequence: 2,
      lastPeerAck: 1,
    })
    await expect(openEstablishedApplication({
      state: ready.channel,
      frame: sealed.wireText,
      now: now + 80,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })).rejects.toMatchObject({ code: 'replay' })
    await expect(openEstablishedApplication({
      state: clientChannel,
      frame: sealed.wireText,
      now: now + 80,
      assertAuthorizationActive: async () => {},
      commitInbound: async () => {},
    })).rejects.toMatchObject({ code: 'route-mismatch' })
  })

  it('runs Host reservation and Client high-water installation inside the verified flow', async () => {
    const value = await fixture()
    const clientInit = await createClientSessionInit({
      authorization: value.clientAuthorization,
      now,
      expiresAt: now + 25_000,
    })
    await expect(validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: async () => 0,
      frame: clientInit.frame,
      now: now + 1,
    })).rejects.toMatchObject({ code: 'stale-authority' })

    const prepared = await prepareAccept(9)
    await expect(validateSessionAcceptForClient({
      state: prepared.clientInit,
      frame: prepared.hostAwaiting.frame,
      now: now + 30,
      installGeneration: async request => request.connectionGeneration,
    })).rejects.toMatchObject({ code: 'stale-authority' })
  })

  it('binds init to active authorization, fresh ids, epoch, signature and ephemeral key', async () => {
    const value = await fixture()
    const clientInit = await createClientSessionInit({
      authorization: value.clientAuthorization,
      now,
      expiresAt: now + 25_000,
    })
    const reservationStore = hostGenerationStore(1)
    await validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: reservationStore,
      frame: clientInit.frame,
      now: now + 1,
    })
    await expect(validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: reservationStore,
      frame: clientInit.frame,
      now: now + 1,
    })).rejects.toMatchObject({ code: 'replay' })

    const signedTamper = mutateCanonicalFrame(clientInit.frame, frame => {
      frame.clientSignature = tamperBase64Url(frame.clientSignature as string)
    })
    await expect(validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: hostGenerationStore(1),
      frame: signedTamper,
      now: now + 1,
    })).rejects.toEqual(new E2eeError('authentication-failed'))

    const replacementEphemeral = await generateAgreementKeyPair()
    const parsedEphemeral = JSON.parse(clientInit.frame) as Record<string, unknown>
    parsedEphemeral.clientEphemeralAgreementKey = await exportPublicJwk(replacementEphemeral.publicKey)
    await expect(validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: hostGenerationStore(1),
      frame: JSON.stringify(parsedEphemeral),
      now: now + 1,
    })).rejects.toEqual(new E2eeError('authentication-failed'))

    const epochTamper = mutateCanonicalFrame(clientInit.frame, frame => {
      frame.authorizationEpoch = 2
    })
    await expect(validateSessionInitForHost({
      authorization: value.hostAuthorization,
      reserveGeneration: hostGenerationStore(1),
      frame: epochTamper,
      now: now + 1,
    })).rejects.toMatchObject({ code: 'stale-authority' })
  })

  it('rejects accept init-hash, generation, Host signature and ephemeral tampering', async () => {
    for (const kind of ['init-hash', 'generation', 'signature', 'ephemeral'] as const) {
      const prepared = await prepareAccept()
      const tampered = JSON.parse(prepared.hostAwaiting.frame) as Record<string, unknown>
      if (kind === 'init-hash') {
        tampered.sessionInitHash = tamperBase64Url(tampered.sessionInitHash as string)
      } else if (kind === 'generation') {
        tampered.connectionGeneration = (tampered.connectionGeneration as number) + 1
      } else if (kind === 'signature') {
        tampered.hostSignature = tamperBase64Url(tampered.hostSignature as string)
      } else {
        tampered.hostEphemeralAgreementKey = await exportPublicJwk(
          (await generateAgreementKeyPair()).publicKey,
        )
      }
      await expect(validateSessionAcceptForClient({
        state: prepared.clientInit,
        frame: JSON.stringify(tampered),
        now: now + 30,
        installGeneration: clientGenerationStore(prepared.highWater),
      })).rejects.toSatisfy((error: unknown) => (
        error instanceof E2eeError
        || (typeof error === 'object' && error !== null && 'code' in error)
      ))
    }

    const replayedGeneration = await prepareAccept()
    const accept = decodeSessionAccept(replayedGeneration.hostAwaiting.frame, {
      expectedRelayOrigin: replayedGeneration.value.claims.relayOrigin,
      now: now + 30,
    })
    await expect(validateSessionAcceptForClient({
      state: replayedGeneration.clientInit,
      frame: replayedGeneration.hostAwaiting.frame,
      now: now + 30,
      installGeneration: clientGenerationStore(accept.connectionGeneration),
    })).rejects.toMatchObject({ code: 'stale-authority' })
  })

  it('fails closed on confirm/ready tampering and never establishes before ready', async () => {
    const confirmPrepared = await prepareAwaitingReady()
    expect(() => getEstablishedSessionChannelInfo(
      confirmPrepared.clientAwaiting as unknown as EstablishedSessionChannel,
    )).toThrowError(expect.objectContaining({ code: 'stale-authority' }))
    const confirm = await createClientSessionConfirm({
      state: confirmPrepared.clientAwaiting,
      now: now + 40,
      expiresAt: now + 10_000,
    })
    const tamperedConfirm = mutateCanonicalFrame(confirm.wireText, frame => {
      frame.ciphertext = tamperBase64Url(frame.ciphertext as string)
    })
    await expect(acceptClientSessionConfirm({
      state: confirmPrepared.hostAwaiting,
      frame: tamperedConfirm,
      now: now + 50,
    })).rejects.toEqual(new E2eeError('authentication-failed'))

    const readyPrepared = await prepareAwaitingReady()
    const validConfirm = await createClientSessionConfirm({
      state: readyPrepared.clientAwaiting,
      now: now + 40,
      expiresAt: now + 10_000,
    })
    const hostConfirmed = await acceptClientSessionConfirm({
      state: readyPrepared.hostAwaiting,
      frame: validConfirm.wireText,
      now: now + 50,
    })
    const ready = await createHostSessionReady({
      state: hostConfirmed,
      now: now + 60,
      expiresAt: now + 10_000,
    })
    const tamperedReady = mutateCanonicalFrame(ready.ready.wireText, frame => {
      frame.ack = 0
    })
    await expect(acceptHostSessionReady({
      state: readyPrepared.clientAwaiting,
      frame: tamperedReady,
      now: now + 70,
    })).rejects.toEqual(new E2eeError('authentication-failed'))
  })

  it('rejects a self-signed replacement grant that is not rooted in the paired Host keys', async () => {
    const value = await fixture()
    const [replacementAgreement, replacementSigning] = await Promise.all([
      generateAgreementKeyPair(),
      generateSigningKeyPair(),
    ])
    const replacementClaims: GrantClaims = {
      ...value.claims,
      hostAgreementKey: await exportPublicJwk(replacementAgreement.publicKey),
      hostSigningKey: await exportPublicJwk(replacementSigning.publicKey),
      hostSigningFingerprint: await fingerprintP256PublicJwk(
        await exportPublicJwk(replacementSigning.publicKey),
      ),
    }
    const replacementHash = encodeBase64Url(
      await sha256(encoder.encode(encodeGrantClaims(replacementClaims))),
    )
    const replacementSignature = encodeBase64Url(await signP256(
      replacementSigning.privateKey,
      encodeGrantSignatureInput(replacementClaims),
    ))
    await expect(createClientSessionInit({
      authorization: {
        ...value.clientAuthorization,
        grantClaims: replacementClaims,
        grantClaimsHash: replacementHash,
        hostGrantSignature: replacementSignature,
      },
      now,
      expiresAt: now + 20_000,
    })).rejects.toMatchObject({ code: 'stale-authority' })
  })

  it('never rolls an established Host channel back to a delayed lower generation', async () => {
    const value = await fixture()
    const reserveGeneration = hostGenerationStore(5)
    const prepare = async (clientHighWater: number) => {
      const clientInit = await createClientSessionInit({
        authorization: value.clientAuthorization,
        now,
        expiresAt: now + 25_000,
      })
      const hostValidated = await validateSessionInitForHost({
        authorization: value.hostAuthorization,
        reserveGeneration,
        frame: clientInit.frame,
        now: now + 1,
      })
      const hostAwaiting = await createHostSessionAccept({
        state: hostValidated,
        now: now + 2,
        expiresAt: now + 20_000,
      })
      const clientValidated = await validateSessionAcceptForClient({
        state: clientInit,
        frame: hostAwaiting.frame,
        now: now + 3,
        installGeneration: clientGenerationStore(clientHighWater),
      })
      const clientAwaiting = await deriveClientSessionAfterGenerationCommit({
        state: clientValidated,
      })
      const confirm = await createClientSessionConfirm({
        state: clientAwaiting,
        now: now + 4,
        expiresAt: now + 10_000,
      })
      const hostConfirmed = await acceptClientSessionConfirm({
        state: hostAwaiting,
        frame: confirm.wireText,
        now: now + 5,
      })
      return { clientAwaiting, hostConfirmed }
    }
    const generation6 = await prepare(5)
    const generation7 = await prepare(6)
    const high = await createHostSessionReady({
      state: generation7.hostConfirmed,
      now: now + 6,
      expiresAt: now + 10_000,
    })
    await expect(createHostSessionReady({
      state: generation6.hostConfirmed,
      now: now + 7,
      expiresAt: now + 10_000,
    })).rejects.toMatchObject({ code: 'stale-authority' })
    expect(getEstablishedSessionChannelInfo(high.channel).authority.connectionGeneration).toBe(7)
    disposeSessionState(generation6.clientAwaiting)
    disposeSessionState(generation7.clientAwaiting)
    disposeSessionState(high.channel)
  })

  it('invalidates every pending or established key for a revoked authorization epoch', async () => {
    const prepared = await prepareAwaitingReady()
    const count = invalidateAuthorizationSessions({
      authorizationId: prepared.value.claims.authorizationId,
      throughEpoch: prepared.value.claims.authorizationEpoch,
    })
    expect(count).toBeGreaterThanOrEqual(2)
    await expect(createClientSessionConfirm({
      state: prepared.clientAwaiting,
      now: now + 40,
      expiresAt: now + 10_000,
    })).rejects.toMatchObject({ code: 'stale-authority' })
    disposeSessionState(prepared.clientAwaiting)
    disposeSessionState(prepared.hostAwaiting)
  })

  it('revokes pre-directional handshake capabilities before accept or key derivation', async () => {
    const beforeAccept = await fixture()
    const init = await createClientSessionInit({
      authorization: beforeAccept.clientAuthorization,
      now,
      expiresAt: now + 25_000,
    })
    const hostValidated = await validateSessionInitForHost({
      authorization: beforeAccept.hostAuthorization,
      reserveGeneration: hostGenerationStore(0),
      frame: init.frame,
      now: now + 1,
    })
    invalidateAuthorizationSessions({
      authorizationId: beforeAccept.claims.authorizationId,
      throughEpoch: beforeAccept.claims.authorizationEpoch,
    })
    await expect(createHostSessionAccept({
      state: hostValidated,
      now: now + 2,
      expiresAt: now + 20_000,
    })).rejects.toMatchObject({ code: 'stale-authority' })

    const beforeDerive = await prepareAccept()
    const clientValidated = await validateSessionAcceptForClient({
      state: beforeDerive.clientInit,
      frame: beforeDerive.hostAwaiting.frame,
      now: now + 30,
      installGeneration: clientGenerationStore(beforeDerive.highWater),
    })
    invalidateAuthorizationSessions({
      authorizationId: beforeDerive.value.claims.authorizationId,
      throughEpoch: beforeDerive.value.claims.authorizationEpoch,
    })
    await expect(deriveClientSessionAfterGenerationCommit({
      state: clientValidated,
    })).rejects.toMatchObject({ code: 'stale-authority' })
    disposeSessionState(init)
    disposeSessionState(beforeDerive.hostAwaiting)
  })
})
