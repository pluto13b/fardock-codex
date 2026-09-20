import { beforeEach, describe, expect, it, vi } from 'vitest'

const capturedPairingMaterial = vi.hoisted(() => [] as Array<{
  purpose: string
  bytes: Uint8Array
  ownedBytes: Uint8Array
}>)
const capturedCryptoOutputs = vi.hoisted(() => [] as Uint8Array[])
const capturedNoncePrefixes = vi.hoisted(() => [] as Uint8Array[])
const pairingFaults = vi.hoisted(() => ({
  beforeDerive: undefined as undefined | ((purpose: string) => void | Promise<void>),
  failNextEncrypt: false,
}))

vi.mock('../src/primitives.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/primitives.ts')>()
  return {
    ...actual,
    derivePairingMaterial: async (
      ...parameters: Parameters<typeof actual.derivePairingMaterial>
    ): ReturnType<typeof actual.derivePairingMaterial> => {
      await pairingFaults.beforeDerive?.(parameters[3])
      const output = await actual.derivePairingMaterial(...parameters)
      capturedPairingMaterial.push({
        purpose: parameters[3],
        bytes: output.slice(),
        ownedBytes: output,
      })
      return output
    },
    encryptAes256Gcm: async (
      ...parameters: Parameters<typeof actual.encryptAes256Gcm>
    ): ReturnType<typeof actual.encryptAes256Gcm> => {
      if (pairingFaults.failNextEncrypt) {
        pairingFaults.failNextEncrypt = false
        throw new Error('injected encrypt failure')
      }
      capturedNoncePrefixes.push(parameters[1])
      const output = await actual.encryptAes256Gcm(...parameters)
      capturedCryptoOutputs.push(output)
      return output
    },
    decryptAes256Gcm: async (
      ...parameters: Parameters<typeof actual.decryptAes256Gcm>
    ): ReturnType<typeof actual.decryptAes256Gcm> => {
      capturedNoncePrefixes.push(parameters[1])
      const output = await actual.decryptAes256Gcm(...parameters)
      capturedCryptoOutputs.push(output)
      return output
    },
  }
})

import {
  decodeBase64Url,
  decodePairJoinDetails,
  decodePairResultPayload,
  decodePairingInvitationFragment,
  encodeBase64Url,
  encodeGrantSignatureInput,
  encodePairJoinAad,
  encodePairJoinDetails,
  encodePairJoinFrame,
  encodePairResultAad,
  encodePairResultFrame,
  encodePairResultPayload,
  encodePairingInvitationFragment,
  pairJoinHeader,
  pairResultHeader,
  type PairJoinDetails,
  type PairJoinFrame,
  type PairResultFrame,
  type PairResultPayload,
} from '@codex-plus/protocol'

import {
  approveHostPairing,
  createClientPairJoin,
  createHostPairingInvitation,
  getHostPairingSessionStatus,
  openClientPairResult,
  openHostPairJoin,
  prepareHostPairingDenial,
  type CreatedClientPairJoin,
  type CreatedHostPairingInvitation,
  type HostPairingApprovalPersistenceAdapter,
  type HostPairingConfirmation,
} from '../src/pairing-flow.ts'
import { generateAgreementKeyPair, generateSigningKeyPair } from '../src/keys.ts'
import {
  decryptAes256Gcm,
  encryptAes256Gcm,
  importAes256GcmKey,
  signP256,
} from '../src/primitives.ts'
import { E2eeError } from '../src/runtime.ts'

const encoder = new TextEncoder()
const relayOrigin = 'https://relay.example.test'
const fixedNow = 1_800_000_000_000

interface Fixture {
  readonly host: CreatedHostPairingInvitation
  readonly client: CreatedClientPairJoin
  readonly hostAgreement: CryptoKeyPair
  readonly hostSigning: CryptoKeyPair
  readonly clientToHostKey: Uint8Array
  readonly clientToHostPrefix: Uint8Array
  readonly hostToClientKey: Uint8Array
  readonly hostToClientPrefix: Uint8Array
  readonly setHostClock: (now: number) => void
}

beforeEach(() => {
  capturedPairingMaterial.length = 0
  capturedCryptoOutputs.length = 0
  capturedNoncePrefixes.length = 0
  pairingFaults.beforeDerive = undefined
  pairingFaults.failNextEncrypt = false
})

function captured(purpose: string): Uint8Array {
  const match = capturedPairingMaterial.find(item => item.purpose === purpose)
  if (match === undefined) throw new Error(`Missing captured ${purpose} material`)
  return match.bytes.slice()
}

async function fixture(now = fixedNow, lifetimeMs = 120_000): Promise<Fixture> {
  let hostClock = now
  const [hostAgreement, hostSigning] = await Promise.all([
    generateAgreementKeyPair(),
    generateSigningKeyPair(),
  ])
  const host = await createHostPairingInvitation({
    relayOrigin,
    hostId: 'host-main',
    hostDeviceId: 'host-windows',
    hostAgreementPublicKey: hostAgreement.publicKey,
    hostSigningPrivateKey: hostSigning.privateKey,
    hostSigningPublicKey: hostSigning.publicKey,
    now,
    lifetimeMs,
    clock: () => hostClock,
  })
  const client = await createClientPairJoin({
    invitationFragment: host.invitationFragment,
    expectedRelayOrigin: relayOrigin,
    deviceDisplayName: 'Alice Phone',
    now: now + 1_000,
  })
  return {
    host,
    client,
    hostAgreement,
    hostSigning,
    clientToHostKey: captured('client-to-host-key'),
    clientToHostPrefix: captured('client-to-host-nonce-prefix'),
    hostToClientKey: captured('host-to-client-key'),
    hostToClientPrefix: captured('host-to-client-nonce-prefix'),
    setHostClock(value) {
      hostClock = value
    },
  }
}

function persistenceAdapter(
  commit: HostPairingApprovalPersistenceAdapter['commitAuthorizationAndUpsertRelay']
  = async () => ({ relayRevision: 1, nextGeneration: 1 }),
): HostPairingApprovalPersistenceAdapter {
  return { commitAuthorizationAndUpsertRelay: vi.fn(commit) }
}

function expectAllZero(values: readonly Uint8Array[]): void {
  for (const value of values) {
    expect(Array.from(value)).toEqual(new Array(value.byteLength).fill(0))
  }
}

function flipEncodedByte(value: string): string {
  const bytes = decodeBase64Url(value)
  if (bytes === undefined) throw new Error('Expected canonical base64url')
  bytes[0] = (bytes[0] ?? 0) ^ 1
  return encodeBase64Url(bytes)
}

async function rewriteJoinDetails(
  setup: Fixture,
  rewrite: (details: PairJoinDetails) => PairJoinDetails,
): Promise<string> {
  const decryptKey = await importAes256GcmKey(setup.clientToHostKey, 'decrypt')
  const encryptKey = await importAes256GcmKey(setup.clientToHostKey, 'encrypt')
  const originalCiphertext = decodeBase64Url(setup.client.frame.ciphertext)
  if (originalCiphertext === undefined) throw new Error('Expected join ciphertext')
  const plaintext = await decryptAes256Gcm(
    decryptKey,
    setup.clientToHostPrefix,
    1n,
    encodePairJoinAad(pairJoinHeader(setup.client.frame as PairJoinFrame)),
    originalCiphertext,
  )
  const changed = rewrite(decodePairJoinDetails(plaintext))
  const ciphertext = await encryptAes256Gcm(
    encryptKey,
    setup.clientToHostPrefix,
    1n,
    encodePairJoinAad(pairJoinHeader(setup.client.frame as PairJoinFrame)),
    encoder.encode(encodePairJoinDetails(changed)),
  )
  return encodePairJoinFrame({
    ...setup.client.frame,
    ciphertext: encodeBase64Url(ciphertext),
  })
}

async function rewriteApprovedResult(
  setup: Fixture,
  frame: Readonly<PairResultFrame>,
  rewrite: (payload: Extract<PairResultPayload, { outcome: 'approved' }>) => Promise<Extract<PairResultPayload, { outcome: 'approved' }>>,
): Promise<string> {
  const decryptKey = await importAes256GcmKey(setup.hostToClientKey, 'decrypt')
  const encryptKey = await importAes256GcmKey(setup.hostToClientKey, 'encrypt')
  const originalCiphertext = decodeBase64Url(frame.ciphertext)
  if (originalCiphertext === undefined) throw new Error('Expected result ciphertext')
  const plaintext = await decryptAes256Gcm(
    decryptKey,
    setup.hostToClientPrefix,
    1n,
    encodePairResultAad(pairResultHeader(frame as PairResultFrame)),
    originalCiphertext,
  )
  const payload = decodePairResultPayload(plaintext)
  if (payload.outcome !== 'approved') throw new Error('Expected approved payload')
  const changed = await rewrite(payload)
  const ciphertext = await encryptAes256Gcm(
    encryptKey,
    setup.hostToClientPrefix,
    1n,
    encodePairResultAad(pairResultHeader(frame as PairResultFrame)),
    encoder.encode(encodePairResultPayload(changed)),
  )
  return encodePairResultFrame({ ...frame, ciphertext: encodeBase64Url(ciphertext) })
}

async function validateJoin(setup: Fixture): Promise<HostPairingConfirmation> {
  setup.setHostClock(fixedNow + 1_001)
  const result = await openHostPairJoin({
    invitation: setup.host.handle,
    attemptId: 'attempt.valid',
    wireFrame: setup.client.wireText,
    now: fixedNow + 1_001,
  })
  if (result.outcome !== 'pending-confirmation') throw new Error('Expected pending confirmation')
  return result.confirmation
}

function expectAuthenticationFailure(action: Promise<unknown>): Promise<void> {
  return expect(action).rejects.toEqual(new E2eeError('authentication-failed'))
}

describe('high-level pairing flow', () => {
  it('creates and verifies a signed invitation only for the configured origin', async () => {
    const [hostAgreement, hostSigning] = await Promise.all([
      generateAgreementKeyPair(),
      generateSigningKeyPair(),
    ])
    const host = await createHostPairingInvitation({
      relayOrigin,
      hostId: 'host-main',
      hostDeviceId: 'host-windows',
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      now: fixedNow,
      clock: () => fixedNow,
    })
    expect(host.handle.expiresAt).toBe(fixedNow + 300_000)

    await expect(createClientPairJoin({
      invitationFragment: host.invitationFragment,
      expectedRelayOrigin: 'https://other.example.test',
      deviceDisplayName: 'Alice Phone',
      now: fixedNow + 1,
    })).rejects.toMatchObject({ code: 'route-mismatch' })

    const invitation = decodePairingInvitationFragment(
      host.invitationFragment,
      relayOrigin,
      fixedNow + 1,
    )
    const tamperedFragment = encodePairingInvitationFragment({
      ...invitation,
      invitationSignature: flipEncodedByte(invitation.invitationSignature),
    })
    await expectAuthenticationFailure(createClientPairJoin({
      invitationFragment: tamperedFragment,
      expectedRelayOrigin: relayOrigin,
      deviceDisplayName: 'Alice Phone',
      now: fixedNow + 1,
    }))
  })

  it('rejects ciphertext tampering without consuming the valid invitation', async () => {
    const setup = await fixture()
    const tampered = {
      ...setup.client.frame,
      ciphertext: flipEncodedByte(setup.client.frame.ciphertext),
    }
    await expect(openHostPairJoin({
      invitation: setup.host.handle,
      attemptId: 'attempt.tampered',
      wireFrame: encodePairJoinFrame(tampered),
      now: fixedNow + 1_001,
    })).resolves.toMatchObject({ outcome: 'invalid', invalidAttempts: 1 })

    const confirmation = await validateJoin(setup)
    expect(confirmation.claim.sas).toBe(setup.client.sas)
  })

  it('rejects a valid-AEAD join with a wrong signature or agreement proof', async () => {
    const setup = await fixture()
    const wrongSignature = await rewriteJoinDetails(setup, details => ({
      ...details,
      clientJoinSignature: flipEncodedByte(details.clientJoinSignature),
    }))
    await expect(openHostPairJoin({
      invitation: setup.host.handle,
      attemptId: 'attempt.bad-signature',
      wireFrame: wrongSignature,
      now: fixedNow + 1_001,
    })).resolves.toMatchObject({ outcome: 'invalid', invalidAttempts: 1 })

    const wrongProof = await rewriteJoinDetails(setup, details => ({
      ...details,
      clientAgreementProof: flipEncodedByte(details.clientAgreementProof),
    }))
    await expect(openHostPairJoin({
      invitation: setup.host.handle,
      attemptId: 'attempt.bad-proof',
      wireFrame: wrongProof,
      now: fixedNow + 1_001,
    })).resolves.toMatchObject({ outcome: 'invalid', invalidAttempts: 2 })

    expect((await validateJoin(setup)).claim.sas).toBe(setup.client.sas)
  })

  it('round-trips approval and rejects signed wrong-challenge grants before install', async () => {
    const setup = await fixture()
    const confirmation = await validateJoin(setup)
    expect(confirmation.claim).toMatchObject({
      deviceDisplayName: 'Alice Phone',
      sas: setup.client.sas,
      clientSigningFingerprint: setup.client.clientSigningFingerprint,
    })
    expect(Object.isFrozen(confirmation)).toBe(true)
    await expect(approveHostPairing({
      confirmation: structuredClone(confirmation),
      persistenceAdapter: persistenceAdapter(),
      now: fixedNow + 2_000,
    })).rejects.toMatchObject({ code: 'pair-session-unavailable' })

    const adapter = persistenceAdapter() as {
      commitAuthorizationAndUpsertRelay: HostPairingApprovalPersistenceAdapter[
        'commitAuthorizationAndUpsertRelay'
      ]
    }
    const approval = await approveHostPairing({
      confirmation,
      persistenceAdapter: adapter,
      now: fixedNow + 2_000,
    })
    expect(adapter.commitAuthorizationAndUpsertRelay).toHaveBeenCalledOnce()
    expect(approval.persistence).toEqual({ relayRevision: 1, nextGeneration: 1 })
    const wrongChallenge = await rewriteApprovedResult(setup, approval.frame, async payload => {
      const grantClaims = {
        ...payload.grantClaims,
        clientChallenge: encodeBase64Url(new Uint8Array(32).fill(0xa5)),
      }
      return {
        ...payload,
        grantClaims,
        hostGrantSignature: encodeBase64Url(await signP256(
          setup.hostSigning.privateKey,
          encodeGrantSignatureInput(grantClaims),
        )),
      }
    })
    await expectAuthenticationFailure(openClientPairResult(
      setup.client.handle,
      wrongChallenge,
      fixedNow + 2_001,
    ))

    const opened = await openClientPairResult(
      setup.client.handle,
      approval.wireText,
      fixedNow + 2_001,
    )
    expect(opened.outcome).toBe('approved')
    if (opened.outcome !== 'approved') throw new Error('Expected approval')
    expect(opened.authorization.grantClaims).toEqual(approval.authorization.grantClaims)
    expect(opened.authorization.grantClaimsHash).toBe(approval.authorization.grantClaimsHash)
    expect(opened.authorization.clientAgreementPrivateKey).toMatchObject({
      type: 'private',
      extractable: false,
      usages: ['deriveBits'],
    })
    expect(opened.authorization.clientSigningPrivateKey).toMatchObject({
      type: 'private',
      extractable: false,
      usages: ['sign'],
    })
    await expect(openClientPairResult(
      setup.client.handle,
      approval.wireText,
      fixedNow + 2_001,
    )).rejects.toMatchObject({ code: 'pair-session-unavailable' })
    await expect(approveHostPairing({
      confirmation,
      persistenceAdapter: persistenceAdapter(),
      now: fixedNow + 2_001,
    })).rejects.toMatchObject({ code: 'pair-session-unavailable' })

    const invitation = decodePairingInvitationFragment(
      setup.host.invitationFragment,
      relayOrigin,
      fixedNow + 1,
    )
    expect(setup.client.wireText).not.toContain(invitation.rendezvousSecret)
    expect(setup.client.wireText).not.toContain('Alice Phone')
    expect(setup.client.wireText).not.toContain('clientSigningKey')
    expect(approval.wireText).not.toContain('hostChallenge')
  })

  it('rejects a valid-AEAD result with a wrong host grant signature', async () => {
    const setup = await fixture()
    const approval = await approveHostPairing({
      confirmation: await validateJoin(setup),
      persistenceAdapter: persistenceAdapter(),
      now: fixedNow + 2_000,
    })
    const wrongSignature = await rewriteApprovedResult(setup, approval.frame, async payload => ({
      ...payload,
      hostGrantSignature: flipEncodedByte(payload.hostGrantSignature),
    }))
    await expectAuthenticationFailure(openClientPairResult(
      setup.client.handle,
      wrongSignature,
      fixedNow + 2_001,
    ))
    await expect(openClientPairResult(
      setup.client.handle,
      approval.wireText,
      fixedNow + 2_001,
    )).resolves.toMatchObject({ outcome: 'approved' })
  })

  it('delivers a terminal encrypted denial without authorization material', async () => {
    const setup = await fixture()
    const denialInput = {
      confirmation: await validateJoin(setup),
      now: fixedNow + 2_000,
    }
    const denialPromise = prepareHostPairingDenial(denialInput)
    denialInput.now = fixedNow + 99_000
    const denial = await denialPromise
    expect(denial.outcome).toBe('denied')
    await expect(openClientPairResult(
      setup.client.handle,
      denial.wireText,
      fixedNow + 2_001,
    )).resolves.toEqual({ outcome: 'denied', decidedAt: fixedNow + 2_000 })
  })

  it('snapshots mutable public inputs and owns Uint8Array wire frames before yielding', async () => {
    let hostClock = fixedNow
    const [hostAgreement, hostSigning] = await Promise.all([
      generateAgreementKeyPair(),
      generateSigningKeyPair(),
    ])
    const hostInput = {
      relayOrigin,
      hostId: 'host-main',
      hostDeviceId: 'host-windows',
      hostAgreementPublicKey: hostAgreement.publicKey,
      hostSigningPrivateKey: hostSigning.privateKey,
      hostSigningPublicKey: hostSigning.publicKey,
      now: fixedNow,
      clock: () => hostClock,
    }
    const hostPromise = createHostPairingInvitation(hostInput)
    hostInput.relayOrigin = 'https://mutated.example.test'
    hostInput.hostId = 'host-mutated'
    hostInput.now = fixedNow + 999_999
    const host = await hostPromise
    expect(host.handle).toMatchObject({ relayOrigin, hostId: 'host-main' })

    const clientInput = {
      invitationFragment: host.invitationFragment,
      expectedRelayOrigin: relayOrigin,
      deviceDisplayName: 'Original Phone',
      now: fixedNow + 1_000,
    }
    const clientPromise = createClientPairJoin(clientInput)
    clientInput.invitationFragment = 'mutated'
    clientInput.expectedRelayOrigin = 'https://mutated.example.test'
    clientInput.deviceDisplayName = 'Mutated Phone'
    clientInput.now = fixedNow + 999_999
    const client = await clientPromise

    hostClock = fixedNow + 1_001
    const joinBytes = encoder.encode(client.wireText)
    const openInput = {
      invitation: host.handle,
      attemptId: 'attempt.snapshot',
      wireFrame: joinBytes,
      now: fixedNow + 1_001,
    }
    const openedHostPromise = openHostPairJoin(openInput)
    joinBytes.fill(0xff)
    openInput.attemptId = 'attempt.mutated'
    openInput.now = fixedNow + 999_999
    const openedHost = await openedHostPromise
    expect(openedHost.outcome).toBe('pending-confirmation')
    if (openedHost.outcome !== 'pending-confirmation') throw new Error('Expected confirmation')
    expect(openedHost.confirmation).toMatchObject({
      attemptId: 'attempt.snapshot',
      claim: { deviceDisplayName: 'Original Phone' },
    })

    const adapter = persistenceAdapter() as {
      commitAuthorizationAndUpsertRelay: HostPairingApprovalPersistenceAdapter[
        'commitAuthorizationAndUpsertRelay'
      ]
    }
    const approvalInput = {
      confirmation: openedHost.confirmation,
      persistenceAdapter: adapter,
      now: fixedNow + 2_000,
    }
    const approvalPromise = approveHostPairing(approvalInput)
    adapter.commitAuthorizationAndUpsertRelay = async () => {
      throw new Error('mutated adapter method must not run')
    }
    approvalInput.now = fixedNow + 999_999
    const approval = await approvalPromise

    const resultBytes = encoder.encode(approval.wireText)
    const openedClientPromise = openClientPairResult(
      client.handle,
      resultBytes,
      fixedNow + 2_001,
    )
    resultBytes.fill(0xff)
    await expect(openedClientPromise).resolves.toMatchObject({ outcome: 'approved' })
  })

  it('fails closed when validation crosses the real clock expiry', async () => {
    const setup = await fixture(fixedNow, 2_000)
    setup.setHostClock(fixedNow + 1_001)
    pairingFaults.beforeDerive = (purpose) => {
      if (purpose === 'client-to-host-key') setup.setHostClock(fixedNow + 2_000)
    }

    await expect(openHostPairJoin({
      invitation: setup.host.handle,
      attemptId: 'attempt.slow',
      wireFrame: setup.client.wireText,
      now: fixedNow + 1_001,
    })).resolves.toEqual({ outcome: 'consumed', terminalOutcome: 'expired' })
    expect(() => getHostPairingSessionStatus(setup.host.handle))
      .toThrowError(expect.objectContaining({ code: 'pair-session-unavailable' }))
    expectAllZero(capturedPairingMaterial.map(item => item.ownedBytes))
  })

  it('runs one durable approval under concurrency and releases only after the adapter resolves', async () => {
    const setup = await fixture()
    const confirmation = await validateJoin(setup)
    let resolveCommit: ((value: { relayRevision: number; nextGeneration: number }) => void) | undefined
    const adapter = persistenceAdapter(() => new Promise((resolve) => {
      resolveCommit = resolve
    }))

    const first = approveHostPairing({
      confirmation,
      persistenceAdapter: adapter,
      now: fixedNow + 2_000,
    })
    await expect(approveHostPairing({
      confirmation,
      persistenceAdapter: adapter,
      now: fixedNow + 2_000,
    })).rejects.toMatchObject({ code: 'pair-session-unavailable' })
    await vi.waitFor(() => expect(adapter.commitAuthorizationAndUpsertRelay).toHaveBeenCalledOnce())
    resolveCommit?.({ relayRevision: 7, nextGeneration: 3 })
    await expect(first).resolves.toMatchObject({
      outcome: 'approved',
      persistence: { relayRevision: 7, nextGeneration: 3 },
    })
  })

  it('consumes the exact confirmation when durable commit or post-commit sealing fails', async () => {
    const commitFailureSetup = await fixture()
    const commitFailureConfirmation = await validateJoin(commitFailureSetup)
    const failingAdapter = persistenceAdapter(async (input) => {
      expect(input).toHaveProperty('authorization')
      expect(input).not.toHaveProperty('frame')
      expect(input).not.toHaveProperty('wireText')
      throw new Error('injected durable commit failure')
    })
    await expect(approveHostPairing({
      confirmation: commitFailureConfirmation,
      persistenceAdapter: failingAdapter,
      now: fixedNow + 2_000,
    })).rejects.toThrow('injected durable commit failure')
    await expect(prepareHostPairingDenial({
      confirmation: commitFailureConfirmation,
      now: fixedNow + 2_001,
    })).rejects.toMatchObject({ code: 'pair-session-unavailable' })

    const invalidReceiptSetup = await fixture()
    const invalidReceiptConfirmation = await validateJoin(invalidReceiptSetup)
    await expect(approveHostPairing({
      confirmation: invalidReceiptConfirmation,
      persistenceAdapter: persistenceAdapter(async () => ({
        relayRevision: 0,
        nextGeneration: 0,
      })),
      now: fixedNow + 2_000,
    })).rejects.toMatchObject({ code: 'schema-invalid' })
    await expect(prepareHostPairingDenial({
      confirmation: invalidReceiptConfirmation,
      now: fixedNow + 2_001,
    })).rejects.toMatchObject({ code: 'pair-session-unavailable' })

    const sealFailureSetup = await fixture()
    const sealFailureConfirmation = await validateJoin(sealFailureSetup)
    const committed = persistenceAdapter()
    pairingFaults.failNextEncrypt = true
    await expect(approveHostPairing({
      confirmation: sealFailureConfirmation,
      persistenceAdapter: committed,
      now: fixedNow + 2_000,
    })).rejects.toThrow('injected encrypt failure')
    expect(committed.commitAuthorizationAndUpsertRelay).toHaveBeenCalledOnce()
    await expect(approveHostPairing({
      confirmation: sealFailureConfirmation,
      persistenceAdapter: persistenceAdapter(),
      now: fixedNow + 2_001,
    })).rejects.toMatchObject({ code: 'pair-session-unavailable' })
  })

  it('wipes derived material, AEAD buffers, and terminal nonce-prefix state', async () => {
    const setup = await fixture()
    expectAllZero(capturedPairingMaterial.map(item => item.ownedBytes))
    expectAllZero(capturedCryptoOutputs)
    expectAllZero(capturedNoncePrefixes)

    const confirmation = await validateJoin(setup)
    expectAllZero(capturedPairingMaterial.map(item => item.ownedBytes))
    expectAllZero(capturedCryptoOutputs)
    expectAllZero(capturedNoncePrefixes)

    const approval = await approveHostPairing({
      confirmation,
      persistenceAdapter: persistenceAdapter(),
      now: fixedNow + 2_000,
    })
    await expect(openClientPairResult(
      setup.client.handle,
      approval.wireText,
      fixedNow + 2_001,
    )).resolves.toMatchObject({ outcome: 'approved' })
    expectAllZero(capturedPairingMaterial.map(item => item.ownedBytes))
    expectAllZero(capturedCryptoOutputs)
    expectAllZero(capturedNoncePrefixes)
  })
})
