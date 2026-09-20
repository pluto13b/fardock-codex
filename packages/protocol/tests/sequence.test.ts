import { describe, expect, it } from 'vitest'

import { EnvelopeSequenceGuard, ProtocolViolation } from '../src/index.ts'
import { envelope, fixedNow } from './helpers.ts'

function expectCode(action: () => unknown, code: ProtocolViolation['code']): void {
  try {
    action()
    throw new Error(`Expected protocol code ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolViolation)
    expect((error as ProtocolViolation).code).toBe(code)
  }
}

function guard(): EnvelopeSequenceGuard {
  return new EnvelopeSequenceGuard({
    hostId: 'host-main',
    localDeviceId: 'device-host',
    remoteDeviceId: 'device-phone',
    connectionGeneration: 7,
    keyId: 'key-7',
  })
}

describe('authenticated envelope sequence guard', () => {
  it('accepts contiguous sequence and monotonic acknowledgements', () => {
    const state = guard()
    state.recordSentSequence(1)
    expect(state.acceptAuthenticatedEnvelope(envelope({ seq: 1, ack: 1 }), fixedNow)).toEqual({
      lastAcceptedSeq: 1,
      lastPeerAck: 1,
      maxSentSeq: 1,
    })
    expect(state.acceptAuthenticatedEnvelope(envelope({ seq: 2, ack: 1 }), fixedNow).lastAcceptedSeq).toBe(2)
  })

  it('rejects replay and gaps without advancing state', () => {
    const state = guard()
    state.acceptAuthenticatedEnvelope(envelope({ seq: 1 }), fixedNow)
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ seq: 1 }), fixedNow), 'replay')
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ seq: 3 }), fixedNow), 'sequence-gap')
    expect(state.state().lastAcceptedSeq).toBe(1)
    expect(state.acceptAuthenticatedEnvelope(envelope({ seq: 2 }), fixedNow).lastAcceptedSeq).toBe(2)
  })

  it('rejects ack regression/ahead without consuming the frame', () => {
    const state = guard()
    state.recordSentSequence(1)
    state.recordSentSequence(2)
    state.acceptAuthenticatedEnvelope(envelope({ seq: 1, ack: 2 }), fixedNow)
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ seq: 2, ack: 1 }), fixedNow), 'ack-regression')
    expect(state.state().lastAcceptedSeq).toBe(1)
    expect(state.acceptAuthenticatedEnvelope(envelope({ seq: 2, ack: 2 }), fixedNow).lastAcceptedSeq).toBe(2)
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ seq: 3, ack: 3 }), fixedNow), 'ack-ahead')
    expect(state.state().lastAcceptedSeq).toBe(2)
  })

  it('fails closed on route, key, and generation ambiguity', () => {
    const state = guard()
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ toDeviceId: 'other-device' }), fixedNow), 'route-mismatch')
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ keyId: 'key-8' }), fixedNow), 'route-mismatch')
    expectCode(() => state.acceptAuthenticatedEnvelope(envelope({ connectionGeneration: 8 }), fixedNow), 'generation-mismatch')
    expect(state.state().lastAcceptedSeq).toBe(0)
  })
})
