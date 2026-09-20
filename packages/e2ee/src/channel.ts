import {
  ProtocolViolation,
  RoutedEnvelopeSchema,
  applicationEnvelopeType,
  decodeApplicationMessage,
  decodeBase64Url,
  decodeEnvelope,
  encodeApplicationMessage,
  encodeBase64Url,
  encodeEnvelope,
  encodeEnvelopeAad,
  validateEnvelopeApplicationBinding,
  type ApplicationMessage,
  type EnvelopeHeader,
  type RoutedEnvelope,
  validateEnvelopeTime,
} from '@codex-plus/protocol'

import { decryptAes256Gcm, encryptAes256Gcm } from './primitives.ts'

const encoder = new TextEncoder()

export interface DirectionalChannelExpectation {
  hostId: string
  fromDeviceId: string
  toDeviceId: string
  connectionGeneration: number
  keyId: string
  authorizationId: string
  authorizationEpoch: number
  sessionTranscriptHash: string
  handshakeId: string
  fromRole: 'client' | 'host'
}

function assertSessionAuthority(
  envelope: RoutedEnvelope,
  message: ApplicationMessage,
  expectation: DirectionalChannelExpectation,
): void {
  const isSessionControl = message.kind === 'control'
    && (message.operation === 'session.confirm' || message.operation === 'session.ready')

  if (!isSessionControl) {
    if (envelope.seq === 1) throw new ProtocolViolation('stale-authority')
    return
  }

  const expectedOperation = expectation.fromRole === 'client'
    ? 'session.confirm'
    : 'session.ready'
  const expectedAck = expectation.fromRole === 'client' ? 0 : 1
  if (
    message.operation !== expectedOperation
    || message.senderRole !== expectation.fromRole
    || message.sessionTranscriptHash !== expectation.sessionTranscriptHash
    || message.authorizationId !== expectation.authorizationId
    || message.authorizationEpoch !== expectation.authorizationEpoch
    || message.connectionGeneration !== expectation.connectionGeneration
    || envelope.requestId !== expectation.handshakeId
    || envelope.taskId !== undefined
    || envelope.seq !== 1
    || envelope.ack !== expectedAck
  ) {
    throw new ProtocolViolation('stale-authority')
  }
}

export interface SealedApplicationEnvelope {
  envelope: RoutedEnvelope
  wireText: string
}

export interface OpenedApplicationEnvelope {
  envelope: RoutedEnvelope
  message: ApplicationMessage
  plaintext: Uint8Array
}

function snapshotExpectation(
  value: DirectionalChannelExpectation,
): Readonly<DirectionalChannelExpectation> {
  const snapshot = Object.freeze({ ...value })
  const identifiers = [
    snapshot.hostId,
    snapshot.fromDeviceId,
    snapshot.toDeviceId,
    snapshot.keyId,
    snapshot.authorizationId,
    snapshot.handshakeId,
  ]
  if (
    identifiers.some(identifier => (
      typeof identifier !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(identifier)
    ))
    || !Number.isSafeInteger(snapshot.connectionGeneration)
    || snapshot.connectionGeneration < 1
    || !Number.isSafeInteger(snapshot.authorizationEpoch)
    || snapshot.authorizationEpoch < 1
    || decodeBase64Url(snapshot.sessionTranscriptHash)?.byteLength !== 32
    || (snapshot.fromRole !== 'client' && snapshot.fromRole !== 'host')
  ) {
    throw new ProtocolViolation('schema-invalid')
  }
  return snapshot
}

function assertDirection(
  header: EnvelopeHeader,
  expectation: DirectionalChannelExpectation,
): void {
  if (
    header.hostId !== expectation.hostId
    || header.fromDeviceId !== expectation.fromDeviceId
    || header.toDeviceId !== expectation.toDeviceId
    || header.keyId !== expectation.keyId
  ) {
    throw new ProtocolViolation('route-mismatch')
  }
  if (header.connectionGeneration !== expectation.connectionGeneration) {
    throw new ProtocolViolation('generation-mismatch')
  }
}

/**
 * Encrypt an application message using a sequence that the caller already
 * reserved durably. This function never allocates, commits, or retries seq.
 */
export async function sealApplicationEnvelope(
  key: CryptoKey,
  noncePrefix: Uint8Array,
  expectation: DirectionalChannelExpectation,
  header: EnvelopeHeader,
  message: unknown,
  now: number,
): Promise<SealedApplicationEnvelope> {
  const stableExpectation = snapshotExpectation(expectation)
  assertDirection(header, stableExpectation)
  validateEnvelopeTime(header, now)
  const plaintextText = encodeApplicationMessage(message)
  const parsedMessage = decodeApplicationMessage(plaintextText, header.messageType)
  if (applicationEnvelopeType(parsedMessage) !== header.messageType) {
    throw new ProtocolViolation('stale-authority')
  }
  const preflight = RoutedEnvelopeSchema.safeParse({
    ...header,
    ciphertext: encodeBase64Url(new Uint8Array([0])),
  })
  if (!preflight.success) throw new ProtocolViolation('schema-invalid')
  validateEnvelopeApplicationBinding(preflight.data, parsedMessage)
  assertSessionAuthority(preflight.data, parsedMessage, stableExpectation)

  const ciphertext = await encryptAes256Gcm(
    key,
    noncePrefix,
    BigInt(preflight.data.seq),
    encodeEnvelopeAad(preflight.data),
    encoder.encode(plaintextText),
  )
  const wireText = encodeEnvelope({
    ...preflight.data,
    ciphertext: encodeBase64Url(ciphertext),
  })
  const envelope = decodeEnvelope(wireText, { now })
  validateEnvelopeApplicationBinding(envelope, parsedMessage)
  return Object.freeze({
    envelope: Object.freeze(envelope),
    wireText,
  })
}

/**
 * Authenticate and decode without advancing seq/ack or application state.
 * Callers must reserve action idempotency and then commit sequence state.
 */
export async function openApplicationEnvelope(
  key: CryptoKey,
  noncePrefix: Uint8Array,
  expectation: DirectionalChannelExpectation,
  frame: string | Uint8Array,
  now: number,
): Promise<OpenedApplicationEnvelope> {
  const stableExpectation = snapshotExpectation(expectation)
  const envelope = decodeEnvelope(frame, { now })
  assertDirection(envelope, stableExpectation)
  const ciphertext = decodeBase64Url(envelope.ciphertext)
  if (ciphertext === undefined) throw new ProtocolViolation('schema-invalid')
  const plaintext = await decryptAes256Gcm(
    key,
    noncePrefix,
    BigInt(envelope.seq),
    encodeEnvelopeAad(envelope),
    ciphertext,
  )
  const message = decodeApplicationMessage(plaintext, envelope.messageType)
  validateEnvelopeApplicationBinding(envelope, message)
  assertSessionAuthority(envelope, message, stableExpectation)
  return { envelope, message, plaintext }
}
