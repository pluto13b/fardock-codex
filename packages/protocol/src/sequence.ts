import { validateEnvelopeTime } from './codec.ts'
import { ProtocolViolation } from './errors.ts'
import type { RoutedEnvelope } from './schemas.ts'

export interface EnvelopeSequenceExpectation {
  hostId: string
  localDeviceId: string
  remoteDeviceId: string
  connectionGeneration: number
  keyId: string
  lastAcceptedSeq?: number
  lastPeerAck?: number
  maxSentSeq?: number
}

export interface EnvelopeSequenceState {
  lastAcceptedSeq: number
  lastPeerAck: number
  maxSentSeq: number
}

/**
 * State guard for frames whose AEAD and application payload were already verified.
 * Callers must not invoke acceptAuthenticatedEnvelope before authentication.
 */
export class EnvelopeSequenceGuard {
  private lastAcceptedSeq: number
  private lastPeerAck: number
  private maxSentSeq: number

  constructor(private readonly expectation: EnvelopeSequenceExpectation) {
    this.lastAcceptedSeq = expectation.lastAcceptedSeq ?? 0
    this.lastPeerAck = expectation.lastPeerAck ?? 0
    this.maxSentSeq = expectation.maxSentSeq ?? 0
  }

  recordSentSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence !== this.maxSentSeq + 1) {
      throw new ProtocolViolation('sequence-gap')
    }
    this.maxSentSeq = sequence
  }

  acceptAuthenticatedEnvelope(envelope: RoutedEnvelope, now = Date.now()): EnvelopeSequenceState {
    validateEnvelopeTime(envelope, now)
    if (
      envelope.hostId !== this.expectation.hostId
      || envelope.fromDeviceId !== this.expectation.remoteDeviceId
      || envelope.toDeviceId !== this.expectation.localDeviceId
      || envelope.keyId !== this.expectation.keyId
    ) {
      throw new ProtocolViolation('route-mismatch')
    }
    if (envelope.connectionGeneration !== this.expectation.connectionGeneration) {
      throw new ProtocolViolation('generation-mismatch')
    }
    if (envelope.ack < this.lastPeerAck) throw new ProtocolViolation('ack-regression')
    if (envelope.ack > this.maxSentSeq) throw new ProtocolViolation('ack-ahead')
    if (envelope.seq <= this.lastAcceptedSeq) throw new ProtocolViolation('replay')
    if (envelope.seq !== this.lastAcceptedSeq + 1) throw new ProtocolViolation('sequence-gap')

    this.lastAcceptedSeq = envelope.seq
    this.lastPeerAck = envelope.ack
    return this.state()
  }

  state(): EnvelopeSequenceState {
    return {
      lastAcceptedSeq: this.lastAcceptedSeq,
      lastPeerAck: this.lastPeerAck,
      maxSentSeq: this.maxSentSeq,
    }
  }
}
