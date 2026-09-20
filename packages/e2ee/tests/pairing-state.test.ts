import { describe, expect, it, vi } from 'vitest'

import {
  HostPairingSessionGuard,
  MAX_PAIRING_INVALID_ATTEMPTS,
  type PairingAttemptValidation,
} from '../src/pairing-state.ts'

const fixedNow = 1_800_000_000_000

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function guard(clock: () => number = () => fixedNow) {
  return new HostPairingSessionGuard<{ deviceName: string }>({
    expiresAt: fixedNow + 120_000,
    clock,
  })
}

describe('Host pairing session state guard', () => {
  it('serializes validation and atomically claims only the first valid join', async () => {
    const session = guard()
    const firstValidation = deferred<PairingAttemptValidation<{ deviceName: string }>>()
    const secondValidator = vi.fn(() => ({
      valid: true as const,
      claim: { deviceName: 'other' },
    }))

    const firstAttempt = session.validateAttempt('join-first', () => firstValidation.promise)
    expect(session.localStatus().state).toBe('validating')

    await expect(session.validateAttempt('join-second', secondValidator)).resolves.toEqual({
      outcome: 'unavailable',
    })
    expect(secondValidator).not.toHaveBeenCalled()

    firstValidation.resolve({ valid: true, claim: { deviceName: 'phone' } })
    const claimed = await firstAttempt
    expect(claimed.outcome).toBe('pending-confirmation')
    if (claimed.outcome !== 'pending-confirmation') throw new Error('expected a claim')
    expect(claimed.confirmation.attemptId).toBe('join-first')
    expect(session.localStatus().state).toBe('pending-confirmation')

    await expect(session.validateAttempt('join-third', secondValidator)).resolves.toEqual({
      outcome: 'unavailable',
    })
    expect(secondValidator).not.toHaveBeenCalled()
  })

  it('does not let invalid joins claim the session and consumes the fifth failure', async () => {
    const session = guard()

    for (let attempt = 1; attempt < MAX_PAIRING_INVALID_ATTEMPTS; attempt += 1) {
      await expect(session.validateAttempt(`invalid-${attempt}`, () => ({ valid: false }))).resolves.toEqual({
        outcome: 'invalid',
        invalidAttempts: attempt,
        attemptsRemaining: MAX_PAIRING_INVALID_ATTEMPTS - attempt,
      })
      expect(session.localStatus().state).toBe('waiting')
    }

    await expect(session.validateAttempt('invalid-5', () => ({ valid: false }))).resolves.toEqual({
      outcome: 'consumed',
      terminalOutcome: 'attempt-limit',
    })
    expect(session.localStatus()).toMatchObject({
      state: 'consumed',
      invalidAttempts: 5,
      terminalOutcome: 'attempt-limit',
    })

    const validator = vi.fn(() => ({ valid: true as const, claim: { deviceName: 'late' } }))
    await expect(session.validateAttempt('too-late', validator)).resolves.toEqual({
      outcome: 'unavailable',
    })
    expect(validator).not.toHaveBeenCalled()
  })

  it('expires waiting, validating, and pending sessions without reopening them', async () => {
    let now = fixedNow
    const waiting = guard(() => now)
    now += 120_000
    expect(waiting.expireIfDue()).toBe(true)
    expect(waiting.expireIfDue()).toBe(false)
    expect(waiting.localStatus()).toMatchObject({
      state: 'consumed',
      terminalOutcome: 'expired',
    })

    now = fixedNow
    const validating = guard(() => now)
    const validation = deferred<PairingAttemptValidation<{ deviceName: string }>>()
    const inFlight = validating.validateAttempt('slow', () => validation.promise)
    now += 120_000
    expect(validating.expireIfDue()).toBe(true)
    validation.resolve({ valid: true, claim: { deviceName: 'too late' } })
    await expect(inFlight).resolves.toEqual({ outcome: 'unavailable' })
    expect(validating.localStatus().terminalOutcome).toBe('expired')

    now = fixedNow
    const pending = guard(() => now)
    const claim = await pending.validateAttempt('phone', () => ({
      valid: true,
      claim: { deviceName: 'phone' },
    }))
    if (claim.outcome !== 'pending-confirmation') throw new Error('expected a claim')
    now += 120_000
    expect(pending.approve(claim.confirmation)).toEqual({ accepted: false })
    expect(pending.localStatus().terminalOutcome).toBe('expired')
  })

  it('accepts exactly one local decision and rejects stale or double confirmation', async () => {
    const approved = guard()
    const claim = await approved.validateAttempt('phone', () => ({
      valid: true,
      claim: { deviceName: 'phone' },
    }))
    if (claim.outcome !== 'pending-confirmation') throw new Error('expected a claim')

    const forged = { ...claim.confirmation }
    expect(approved.approve(forged)).toEqual({ accepted: false })
    expect(approved.localStatus().state).toBe('pending-confirmation')
    expect(approved.approve(claim.confirmation)).toEqual({
      accepted: true,
      terminalOutcome: 'approved',
      claim: { deviceName: 'phone' },
    })
    expect(approved.localStatus()).toMatchObject({
      state: 'consumed',
      terminalOutcome: 'approved',
    })
    expect(approved.approve(claim.confirmation)).toEqual({ accepted: false })
    expect(approved.deny(claim.confirmation)).toEqual({ accepted: false })

    const denied = guard()
    const deniedClaim = await denied.validateAttempt('tablet', () => ({
      valid: true,
      claim: { deviceName: 'tablet' },
    }))
    if (deniedClaim.outcome !== 'pending-confirmation') throw new Error('expected a claim')
    expect(denied.deny(deniedClaim.confirmation)).toEqual({
      accepted: true,
      terminalOutcome: 'denied',
    })
    expect(denied.localStatus().terminalOutcome).toBe('denied')
  })

  it('approves the validated claim snapshot even if validator or UI references mutate', async () => {
    const session = new HostPairingSessionGuard<{
      identity: { deviceName: string }
      keyBytes: Uint8Array
    }>({
      expiresAt: fixedNow + 120_000,
      clock: () => fixedNow,
    })
    const validatorClaim = {
      identity: { deviceName: 'phone' },
      keyBytes: Uint8Array.of(1, 2, 3),
    }
    const pending = await session.validateAttempt('phone', () => ({
      valid: true,
      claim: validatorClaim,
    }))
    if (pending.outcome !== 'pending-confirmation') throw new Error('expected a claim')

    validatorClaim.identity.deviceName = 'attacker'
    validatorClaim.keyBytes[0] = 9
    pending.confirmation.claim.identity.deviceName = 'mutated preview'
    pending.confirmation.claim.keyBytes[1] = 9

    expect(session.approve(pending.confirmation)).toEqual({
      accepted: true,
      terminalOutcome: 'approved',
      claim: {
        identity: { deviceName: 'phone' },
        keyBytes: Uint8Array.of(1, 2, 3),
      },
    })
  })

  it('fails closed on validator faults, malformed success, and clock ambiguity', async () => {
    const session = guard()
    await expect(session.validateAttempt('throws', () => {
      throw new Error('sensitive crypto failure')
    })).resolves.toMatchObject({ outcome: 'invalid', invalidAttempts: 1 })

    await expect(session.validateAttempt('malformed', () => ({
      valid: true,
      claim: { deviceName: 'phone' },
      extra: true,
    }) as never)).resolves.toMatchObject({ outcome: 'invalid', invalidAttempts: 2 })

    let now = fixedNow
    const regressedClock = guard(() => now)
    now -= 1
    expect(regressedClock.expireIfDue()).toBe(true)
    expect(regressedClock.localStatus()).toMatchObject({
      state: 'consumed',
      terminalOutcome: 'expired',
    })

    expect(() => new HostPairingSessionGuard({
      expiresAt: fixedNow + 1,
      clock: () => Number.NaN,
    })).toThrow(TypeError)
    expect(() => new HostPairingSessionGuard({
      expiresAt: fixedNow + 300_001,
      clock: () => fixedNow,
    })).toThrow(TypeError)
    expect(() => new HostPairingSessionGuard({
      expiresAt: fixedNow + 1,
      clock: () => {
        throw new Error('clock unavailable')
      },
    })).toThrow(TypeError)
  })

  it('keeps a claimed session pending when its transport disconnects', async () => {
    const session = guard()
    const claim = await session.validateAttempt('disconnected-phone', () => ({
      valid: true,
      claim: { deviceName: 'phone' },
    }))
    if (claim.outcome !== 'pending-confirmation') throw new Error('expected a claim')

    // The guard deliberately has no release/reopen transition for transport loss.
    expect(session.localStatus().state).toBe('pending-confirmation')
    await expect(session.validateAttempt('replacement-phone', () => ({
      valid: true,
      claim: { deviceName: 'replacement' },
    }))).resolves.toEqual({ outcome: 'unavailable' })
    expect(session.localStatus().state).toBe('pending-confirmation')
  })
})
