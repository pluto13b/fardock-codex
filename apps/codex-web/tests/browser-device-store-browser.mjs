import { openBrowserDeviceStore } from '../src/browser-device-store.ts'

const relayOrigin = window.location.origin

function authority(generation) {
  return {
    relayOrigin,
    hostId: 'host.browser.store',
    hostDeviceId: 'device.browser.host',
    clientDeviceId: 'device.browser.client',
    authorizationId: 'authorization.browser.store',
    authorizationEpoch: 1,
    handshakeId: `handshake.browser.${generation}`,
    connectionGeneration: generation,
    sessionTranscriptHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  }
}

export async function runBrowserDeviceStoreBrowserTest() {
  const first = await openBrowserDeviceStore()
  await first.clear()
  const [clientAgreement, clientSigning, hostAgreement, hostSigning] = await Promise.all([
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
    crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']),
  ])
  const authorization = {
    grantClaims: {
      hostId: 'host.browser.store',
      hostDeviceId: 'device.browser.host',
      clientDeviceId: 'device.browser.client',
      authorizationId: 'authorization.browser.store',
      authorizationEpoch: 1,
    },
    hostGrantSignature: 'test-signature',
    grantClaimsHash: 'test-hash',
    clientAgreementPrivateKey: clientAgreement.privateKey,
    clientAgreementPublicKey: clientAgreement.publicKey,
    clientSigningPrivateKey: clientSigning.privateKey,
    clientSigningPublicKey: clientSigning.publicKey,
    hostAgreementPublicKey: hostAgreement.publicKey,
    hostSigningPublicKey: hostSigning.publicKey,
  }
  await first.saveAuthorization(relayOrigin, authorization)
  const restored = await first.loadAuthorization(relayOrigin)
  const install = request => first.installGeneration(request)
  const generationOne = authority(1)
  await install({ ...generationOne })
  const persistenceOne = await first.activateSession({
    role: 'client',
    authority: generationOne,
    inboundKeyId: 'key.browser.in.1',
    outboundKeyId: 'key.browser.out.1',
    sequenceState: {
      nextOutboundSequence: 2,
      maxSentSequence: 1,
      lastAcceptedInboundSequence: 1,
      lastPeerAck: 1,
    },
  })
  const reservedOne = await persistenceOne.outbound.reserveSequence({
    authority: generationOne,
    keyId: 'key.browser.out.1',
    direction: 'client-to-host',
    expectedSequence: 2,
    header: {},
  })
  await persistenceOne.outbound.commitFrame({
    authority: generationOne,
    keyId: 'key.browser.out.1',
    sequence: reservedOne,
    wireText: 'canonical-frame-generation-1-sequence-2',
  })
  first.close()

  const second = await openBrowserDeviceStore()
  const reloaded = await second.loadAuthorization(relayOrigin)
  const recovery = await second.recoverySnapshot()
  let exportRejected = false
  try {
    await crypto.subtle.exportKey('pkcs8', reloaded.clientSigningPrivateKey)
  } catch {
    exportRejected = true
  }
  const challenge = new TextEncoder().encode('browser-store-reload')
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    reloaded.clientSigningPrivateKey,
    challenge,
  )
  const signatureVerified = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    reloaded.clientSigningPublicKey,
    signature,
    challenge,
  )
  const derived = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: reloaded.hostAgreementPublicKey },
    reloaded.clientAgreementPrivateKey,
    256,
  )
  let replayRejected = false
  try {
    await second.installGeneration({ ...generationOne })
  } catch {
    replayRejected = true
  }

  const generationTwo = authority(2)
  await second.installGeneration({ ...generationTwo })
  const persistenceTwo = await second.activateSession({
    role: 'client',
    authority: generationTwo,
    inboundKeyId: 'key.browser.in.2',
    outboundKeyId: 'key.browser.out.2',
    sequenceState: {
      nextOutboundSequence: 2,
      maxSentSequence: 1,
      lastAcceptedInboundSequence: 1,
      lastPeerAck: 1,
    },
  })
  const reservedTwo = await persistenceTwo.outbound.reserveSequence({
    authority: generationTwo,
    keyId: 'key.browser.out.2',
    direction: 'client-to-host',
    expectedSequence: 2,
    header: {},
  })
  await persistenceTwo.outbound.commitFrame({
    authority: generationTwo,
    keyId: 'key.browser.out.2',
    sequence: reservedTwo,
    wireText: 'canonical-frame-generation-2-sequence-2',
  })
  await persistenceTwo.commitInbound({
    authority: generationTwo,
    keyId: 'key.browser.in.2',
    sequence: 2,
    ack: 2,
    message: {},
  })
  const acknowledged = await second.recoverySnapshot()
  await second.markRevoked('authorization.browser.store', 2)
  second.close()

  const third = await openBrowserDeviceStore()
  let revokedRejected = false
  try {
    await third.loadAuthorization(relayOrigin)
  } catch {
    revokedRejected = true
  }
  await third.clear()
  const cleared = await third.loadAuthorization(relayOrigin)
  third.close()

  return {
    privateExtractable: restored.clientSigningPrivateKey.extractable,
    exportRejected,
    signatureVerified,
    derivedBytes: derived.byteLength,
    recoveryGeneration: recovery.highestGeneration,
    recoveryFrames: recovery.rawFrames,
    replayRejected,
    acknowledgedFrames: acknowledged.rawFrames,
    revokedRejected,
    cleared: cleared === undefined,
  }
}
