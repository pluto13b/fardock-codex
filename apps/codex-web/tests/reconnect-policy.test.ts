import { describe, expect, it } from 'vitest'

import {
  invitationFragmentForConnectionAttempt,
  reconnectDelayMs,
  retryPairedClientFailure,
} from '../src/reconnect-policy.ts'

describe('formal client reconnect policy', () => {
  it('uses an invitation only for the first connection attempt', () => {
    expect(invitationFragmentForConnectionAttempt('one-time-fragment', 0)).toBe('one-time-fragment')
    expect(invitationFragmentForConnectionAttempt('one-time-fragment', 1)).toBe('')
    expect(invitationFragmentForConnectionAttempt('one-time-fragment', 20)).toBe('')
  })

  it('caps retry delay and does not retry an unpaired or invalid origin', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelayMs)).toEqual([
      250,
      500,
      1_000,
      2_000,
      5_000,
      5_000,
      5_000,
    ])
    expect(retryPairedClientFailure('connection-closed')).toBe(true)
    expect(retryPairedClientFailure('connection-closed', true)).toBe(false)
    expect(retryPairedClientFailure('unpaired')).toBe(false)
    expect(retryPairedClientFailure('invalid-origin')).toBe(false)
    expect(retryPairedClientFailure('storage-unavailable')).toBe(false)
    expect(() => reconnectDelayMs(-1)).toThrow('invalid-reconnect-attempt')
  })
})
