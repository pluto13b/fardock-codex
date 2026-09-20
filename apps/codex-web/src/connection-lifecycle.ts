import type { EphemeralPairedClient } from './paired-client.ts'
import { invitationFragmentForConnectionAttempt, reconnectDelayMs, retryPairedClientFailure } from './reconnect-policy.ts'

/** One owner for connect, disconnect and foreground recovery. Never replays actions. */
export function createConnectionLifecycle(options: {
  invitationFragment: string
  connect: (invitationFragment: string) => Promise<EphemeralPairedClient>
  isVisible: () => boolean
  onReady: (paired: EphemeralPairedClient) => void
  onReconnecting: () => void
  onFailure: (detail: string) => void
}) {
  let stopped = false
  let connecting = false
  let attempt = 0
  let failures = 0
  let current: EphemeralPairedClient | undefined
  let retained: EphemeralPairedClient | undefined
  let unsubscribe: (() => void) | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let healthTimer: ReturnType<typeof setTimeout> | undefined
  let checking = false

  const clearHealth = () => { if (healthTimer !== undefined) clearTimeout(healthTimer); healthTimer = undefined; checking = false }
  const pauseHealth = () => { if (healthTimer !== undefined) clearTimeout(healthTimer); healthTimer = undefined }
  const schedule = () => {
    if (stopped || current || connecting || retryTimer !== undefined || !options.isVisible()) return
    options.onReconnecting()
    retryTimer = setTimeout(() => { retryTimer = undefined; void connect() }, reconnectDelayMs(failures++))
  }
  const disconnect = (paired: EphemeralPairedClient) => {
    if (stopped || paired !== current) return
    unsubscribe?.(); unsubscribe = undefined
    retained = paired
    current = undefined
    clearHealth()
    options.onReconnecting()
    schedule()
  }
  const connect = async () => {
    if (stopped || connecting || current || !options.isVisible()) return
    connecting = true
    let fragment = ''
    let candidate: EphemeralPairedClient | undefined
    let retry = false
    try {
      if (retained !== undefined) {
        candidate = retained
        retained = undefined
        if (!(await candidate.tryResume?.())) { await candidate.close().catch(() => undefined); candidate = undefined }
      }
      if (candidate === undefined) {
        fragment = invitationFragmentForConnectionAttempt(options.invitationFragment, attempt++)
        candidate = await options.connect(fragment)
      }
      if (stopped) { await candidate.close(); return }
      const paired = candidate
      current = paired
      paired.setPageVisible?.(options.isVisible())
      unsubscribe = paired.onUnexpectedDisconnect(() => disconnect(paired))
      candidate = undefined
      failures = 0
      options.onReady(paired)
    } catch (error) {
      current = undefined
      await candidate?.close().catch(() => undefined)
      if (stopped) return
      const detail = error instanceof Error && error.message.startsWith('client-stage:') ? error.message.slice(13) : 'failed'
      retry = retryPairedClientFailure(detail, fragment !== '')
      if (!retry) options.onFailure(detail)
    } finally {
      connecting = false
      if (retry) schedule()
    }
  }
  return {
    start: () => { void connect() },
    background() {
      current?.setPageVisible?.(false)
      retained?.setPageVisible?.(false)
      pauseHealth()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
    },
    foreground() {
      if (stopped || !options.isVisible()) return
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      if (!current) { void connect(); return }
      if (checking) {
        if (healthTimer === undefined) {
          const paired = current
          healthTimer = setTimeout(() => disconnect(paired), 4_000)
        }
        return
      }
      checking = true
      const paired = current
      options.onReconnecting()
      const check = paired.checkConnection?.() ?? paired.client.listWorkspaces().then(() => true, () => false)
      healthTimer = setTimeout(() => disconnect(paired), 4_000)
      void check.then(ok => {
        if (current !== paired) return
        clearHealth()
        if (ok) { paired.setPageVisible?.(options.isVisible()); options.onReady(paired) }
        else {
          disconnect(paired)
          if (retryTimer !== undefined) clearTimeout(retryTimer)
          retryTimer = undefined
          void connect()
        }
      }, () => disconnect(paired))
    },
    stop() {
      stopped = true
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      clearHealth()
      unsubscribe?.()
      void current?.close().catch(() => undefined)
      void retained?.close().catch(() => undefined)
      retained = undefined
      current = undefined
    },
  }
}
