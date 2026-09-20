const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const

function requireAttempt(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid-reconnect-attempt')
  }
}

export function reconnectDelayMs(failureAttempt: number): number {
  requireAttempt(failureAttempt)
  return RECONNECT_DELAYS_MS[
    Math.min(failureAttempt, RECONNECT_DELAYS_MS.length - 1)
  ]!
}

export function invitationFragmentForConnectionAttempt(
  initialInvitationFragment: string,
  connectionAttempt: number,
): string {
  requireAttempt(connectionAttempt)
  return connectionAttempt === 0 ? initialInvitationFragment : ''
}

export function retryPairedClientFailure(detail: string, usedInvitation = false): boolean {
  return !usedInvitation
    && detail !== 'unpaired'
    && detail !== 'invalid-origin'
    && detail !== 'storage-unavailable'
}
