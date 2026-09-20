import { MAX_PAIRING_INVITATION_TTL_MS } from '@codex-plus/protocol'

export const MAX_PAIRING_INVALID_ATTEMPTS = 5 as const

export type HostPairingSessionState =
  | 'waiting'
  | 'validating'
  | 'pending-confirmation'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'attempt-limit'
  | 'consumed'

export type HostPairingTerminalOutcome =
  | 'approved'
  | 'denied'
  | 'expired'
  | 'attempt-limit'

/**
 * Host-local diagnostic state. This is deliberately not a protocol DTO and
 * must never be exposed as a Relay status or enumeration API.
 */
export interface LocalHostPairingSessionStatus {
  readonly state: HostPairingSessionState
  readonly invalidAttempts: number
  readonly expiresAt: number
  readonly updatedAt: number
  readonly terminalOutcome?: HostPairingTerminalOutcome
}

export type PairingAttemptValidation<TClaim> =
  | { readonly valid: true; readonly claim: TClaim }
  | { readonly valid: false }

/**
 * An in-process capability for the one verified join claimed by this guard.
 * Confirmation requires this exact object identity, not merely the attempt id.
 */
export interface PendingPairingConfirmation<TClaim> {
  readonly attemptId: string
  readonly claim: TClaim
}

export type PairingAttemptResult<TClaim> =
  | {
    readonly outcome: 'pending-confirmation'
    readonly confirmation: PendingPairingConfirmation<TClaim>
  }
  | {
    readonly outcome: 'invalid'
    readonly invalidAttempts: number
    readonly attemptsRemaining: number
  }
  | { readonly outcome: 'unavailable' }
  | {
    readonly outcome: 'consumed'
    readonly terminalOutcome: 'expired' | 'attempt-limit'
  }

export type PairingDecisionResult<TClaim> =
  | {
    readonly accepted: true
    readonly terminalOutcome: 'approved'
    readonly claim: TClaim
  }
  | {
    readonly accepted: true
    readonly terminalOutcome: 'denied'
  }
  | { readonly accepted: false }

export interface HostPairingSessionGuardOptions {
  readonly expiresAt: number
  readonly clock?: () => number
}

class LocalPendingPairingConfirmation<TClaim>
implements PendingPairingConfirmation<TClaim> {
  constructor(
    readonly attemptId: string,
    readonly claim: TClaim,
  ) {
    Object.freeze(this)
  }
}

const unavailableAttemptResult = Object.freeze({ outcome: 'unavailable' } as const)
const rejectedDecisionResult = Object.freeze({ accepted: false } as const)

function containsSharedMemory(value: unknown, seen = new Set<object>()): boolean {
  if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
    return true
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return false
  seen.add(value)
  if (ArrayBuffer.isView(value)) return containsSharedMemory(value.buffer, seen)
  for (const key of Reflect.ownKeys(value)) {
    let child: unknown
    try {
      child = Reflect.get(value, key)
    } catch {
      return true
    }
    if (containsSharedMemory(child, seen)) return true
  }
  return false
}

function snapshotClaim<TClaim>(claim: TClaim): TClaim {
  if (containsSharedMemory(claim)) throw new TypeError('shared memory is not a valid claim')
  const snapshot = structuredClone(claim)
  if (containsSharedMemory(snapshot)) throw new TypeError('shared memory is not a valid claim')
  return snapshot
}

function isSafeTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isValidClaimResult<TClaim>(
  value: unknown,
): value is { readonly valid: true; readonly claim: TClaim } {
  if (typeof value !== 'object' || value === null) return false

  try {
    const candidate = value as Record<string, unknown>
    const keys = Object.keys(candidate)
    return candidate.valid === true
      && Object.hasOwn(candidate, 'claim')
      && candidate.claim !== undefined
      && keys.length === 2
      && keys.includes('valid')
      && keys.includes('claim')
  } catch {
    return false
  }
}

/**
 * A single-process transition guard for one Host pairing session.
 *
 * Crypto, sockets, persistence, and cross-process coordination belong to their
 * respective adapters. This class only makes local transitions serial and
 * fail-closed. It does not claim to provide a distributed CAS.
 */
export class HostPairingSessionGuard<TClaim> {
  private readonly clock: () => number
  private stateValue: HostPairingSessionState = 'waiting'
  private invalidAttemptsValue = 0
  private updatedAtValue: number
  private lastObservedAt: number
  private terminalOutcomeValue: HostPairingTerminalOutcome | undefined
  private activeValidation: object | undefined
  private pendingConfirmation: LocalPendingPairingConfirmation<TClaim> | undefined
  private pendingClaim: TClaim | undefined

  readonly expiresAt: number

  constructor(options: HostPairingSessionGuardOptions) {
    if (!isSafeTimestamp(options.expiresAt)) {
      throw new TypeError('expiresAt must be a non-negative safe integer')
    }

    this.clock = options.clock ?? Date.now
    let startedAt: number
    try {
      startedAt = this.clock()
    } catch {
      throw new TypeError('clock must return a non-negative safe integer')
    }
    if (!isSafeTimestamp(startedAt)) {
      throw new TypeError('clock must return a non-negative safe integer')
    }
    if (options.expiresAt - startedAt > MAX_PAIRING_INVITATION_TTL_MS) {
      throw new TypeError('pairing session lifetime exceeds five minutes')
    }

    this.expiresAt = options.expiresAt
    this.updatedAtValue = startedAt
    this.lastObservedAt = startedAt

    if (startedAt >= this.expiresAt) {
      this.consume('expired', startedAt)
    }
  }

  /**
   * Runs at most one validator at a time. Validator exceptions and malformed
   * success values are indistinguishable from an invalid attempt.
   */
  async validateAttempt(
    attemptId: string,
    validator: () => PairingAttemptValidation<TClaim> | Promise<PairingAttemptValidation<TClaim>>,
  ): Promise<PairingAttemptResult<TClaim>> {
    const startedAt = this.observeTime()
    if (this.expireForAmbiguousOrElapsedTime(startedAt)) {
      return this.consumedAttemptResult()
    }
    if (startedAt === undefined) return unavailableAttemptResult
    if (this.stateValue !== 'waiting') return unavailableAttemptResult

    const validationToken = Object.freeze({})
    this.activeValidation = validationToken
    this.transition('validating', startedAt)

    let validation: PairingAttemptValidation<TClaim> | undefined
    try {
      validation = await validator()
    } catch {
      validation = undefined
    }

    const completedAt = this.observeTime()
    if (this.expireForAmbiguousOrElapsedTime(completedAt)) {
      return this.consumedAttemptResult()
    }
    if (completedAt === undefined) return unavailableAttemptResult

    if (!this.ownsValidation(validationToken)) {
      return unavailableAttemptResult
    }

    this.activeValidation = undefined
    if (!isValidClaimResult<TClaim>(validation)) {
      return this.recordInvalidAttempt(completedAt)
    }

    let authoritativeClaim: TClaim
    let displayClaim: TClaim
    try {
      authoritativeClaim = snapshotClaim(validation.claim)
      displayClaim = snapshotClaim(authoritativeClaim)
    } catch {
      return this.recordInvalidAttempt(completedAt)
    }

    const confirmation = new LocalPendingPairingConfirmation(attemptId, displayClaim)
    this.pendingClaim = authoritativeClaim
    this.pendingConfirmation = confirmation
    this.transition('pending-confirmation', completedAt)
    return Object.freeze({ outcome: 'pending-confirmation', confirmation })
  }

  approve(confirmation: PendingPairingConfirmation<TClaim>): PairingDecisionResult<TClaim> {
    return this.decide(confirmation, 'approved')
  }

  deny(confirmation: PendingPairingConfirmation<TClaim>): PairingDecisionResult<TClaim> {
    return this.decide(confirmation, 'denied')
  }

  /**
   * Advances an elapsed session exactly once. Ambiguous or regressed clocks
   * also expire the session rather than extending its authority.
   */
  expireIfDue(): boolean {
    const now = this.observeTime()
    return this.expireForAmbiguousOrElapsedTime(now)
  }

  localStatus(): LocalHostPairingSessionStatus {
    this.expireIfDue()
    return Object.freeze({
      state: this.stateValue,
      invalidAttempts: this.invalidAttemptsValue,
      expiresAt: this.expiresAt,
      updatedAt: this.updatedAtValue,
      ...(this.terminalOutcomeValue === undefined
        ? {}
        : { terminalOutcome: this.terminalOutcomeValue }),
    })
  }

  private decide(
    confirmation: PendingPairingConfirmation<TClaim>,
    outcome: 'approved' | 'denied',
  ): PairingDecisionResult<TClaim> {
    const now = this.observeTime()
    if (this.expireForAmbiguousOrElapsedTime(now)) return rejectedDecisionResult
    if (now === undefined) return rejectedDecisionResult
    if (
      this.stateValue !== 'pending-confirmation'
      || this.pendingConfirmation !== confirmation
    ) {
      return rejectedDecisionResult
    }

    const authoritativeClaim = this.pendingClaim
    if (authoritativeClaim === undefined) return rejectedDecisionResult
    this.consume(outcome, now)
    if (outcome === 'approved') {
      return Object.freeze({
        accepted: true,
        terminalOutcome: outcome,
        claim: authoritativeClaim,
      })
    }
    return Object.freeze({ accepted: true, terminalOutcome: outcome })
  }

  private recordInvalidAttempt(now: number | undefined): PairingAttemptResult<TClaim> {
    const transitionAt = now ?? this.updatedAtValue
    this.invalidAttemptsValue += 1

    if (this.invalidAttemptsValue >= MAX_PAIRING_INVALID_ATTEMPTS) {
      this.consume('attempt-limit', transitionAt)
      return this.consumedAttemptResult()
    }

    this.transition('waiting', transitionAt)
    return Object.freeze({
      outcome: 'invalid',
      invalidAttempts: this.invalidAttemptsValue,
      attemptsRemaining: MAX_PAIRING_INVALID_ATTEMPTS - this.invalidAttemptsValue,
    })
  }

  private ownsValidation(token: object): boolean {
    return this.stateValue === 'validating' && this.activeValidation === token
  }

  private observeTime(): number | undefined {
    let now: number
    try {
      now = this.clock()
    } catch {
      return undefined
    }
    if (!isSafeTimestamp(now) || now < this.lastObservedAt) return undefined
    this.lastObservedAt = now
    return now
  }

  private expireForAmbiguousOrElapsedTime(now: number | undefined): boolean {
    if (this.stateValue === 'consumed') return false
    if (now !== undefined && now < this.expiresAt) return false

    this.consume('expired', now ?? this.updatedAtValue)
    return true
  }

  private consume(outcome: HostPairingTerminalOutcome, now: number): void {
    this.transition(outcome, now)
    this.terminalOutcomeValue = outcome
    this.activeValidation = undefined
    this.pendingConfirmation = undefined
    this.pendingClaim = undefined
    this.transition('consumed', now)
  }

  private transition(state: HostPairingSessionState, now: number): void {
    this.stateValue = state
    this.updatedAtValue = Math.max(this.updatedAtValue, now)
  }

  private consumedAttemptResult(): PairingAttemptResult<TClaim> {
    const outcome = this.terminalOutcomeValue
    if (outcome !== 'expired' && outcome !== 'attempt-limit') {
      return unavailableAttemptResult
    }
    return Object.freeze({ outcome: 'consumed', terminalOutcome: outcome })
  }
}
