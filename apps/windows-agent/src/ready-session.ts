import {
  getEstablishedSessionChannelInfo,
  invalidateEstablishedSession,
} from '../../../packages/e2ee/src/index.ts'
import {
  decodeEnvelope,
  RelayReceiptSchema,
  type RelayReceipt,
} from '../../../packages/protocol/src/index.ts'

import {
  dispatchEncryptedHostRequest,
  type HostDispatcherInput,
} from './host-dispatcher.ts'

type RawEnvelope = string | Uint8Array

export interface WindowsCompanionReadySessionOptions
  extends Omit<HostDispatcherInput, 'frame' | 'now'> {
  readonly sendEnvelope: (frame: RawEnvelope) => Promise<RelayReceipt>
  readonly now?: () => number
}

export type WindowsCompanionReadySessionHandler = (
  frame: RawEnvelope,
) => Promise<void>

type ReadySessionFailure =
  | 'invalid-options'
  | 'closed'
  | 'concurrent-request'
  | 'session-closed'
  | 'dispatch-failed'
  | 'relay-unavailable'
  | 'receipt-mismatch'

export class WindowsCompanionReadySessionError extends Error {
  constructor(readonly code: ReadySessionFailure) {
    super(`Windows Companion ready session failed: ${code}.`)
    this.name = 'WindowsCompanionReadySessionError'
  }
}

/**
 * Fixed Host ready-session composition. The returned function is intended to be
 * installed directly as R3LoopbackRelayHostClient.onEnvelope.
 */
export function createWindowsCompanionReadySessionHandler(
  options: WindowsCompanionReadySessionOptions,
): WindowsCompanionReadySessionHandler {
  try {
    if (
      getEstablishedSessionChannelInfo(options.state).role !== 'host'
      || typeof options.sendEnvelope !== 'function'
      || (options.now !== undefined && typeof options.now !== 'function')
    ) {
      throw new WindowsCompanionReadySessionError('invalid-options')
    }
  } catch (error) {
    if (error instanceof WindowsCompanionReadySessionError) throw error
    throw new WindowsCompanionReadySessionError('invalid-options')
  }

  const now = options.now ?? Date.now
  let busy = false
  let closed = false

  const failClosed = (code: ReadySessionFailure): WindowsCompanionReadySessionError => {
    closed = true
    try {
      invalidateEstablishedSession(options.state)
    } catch {
      // The authenticated open may already have invalidated the opaque channel.
    }
    return new WindowsCompanionReadySessionError(code)
  }

  return async frame => {
    if (closed) throw new WindowsCompanionReadySessionError('closed')
    if (busy) throw failClosed('concurrent-request')
    busy = true
    try {
      const receivedAt = now()
      if (!Number.isSafeInteger(receivedAt) || receivedAt < 0) {
        throw failClosed('dispatch-failed')
      }
      const dispatched = await dispatchEncryptedHostRequest({
        ...options,
        frame,
        now: receivedAt,
      })
      if (dispatched.state === 'session-closed') {
        throw failClosed('session-closed')
      }

      const response = decodeEnvelope(dispatched.wireText, { now: receivedAt })
      if (
        response.messageType !== 'response'
        || response.requestId !== dispatched.requestId
        || response.taskId !== dispatched.taskId
      ) {
        throw failClosed('dispatch-failed')
      }

      let receivedReceipt: unknown
      try {
        receivedReceipt = await options.sendEnvelope(dispatched.wireText)
      } catch {
        throw failClosed('relay-unavailable')
      }
      const parsedReceipt = RelayReceiptSchema.safeParse(receivedReceipt)
      if (!parsedReceipt.success) throw failClosed('receipt-mismatch')
      const receipt = parsedReceipt.data
      if (
        receipt.connectionGeneration !== response.connectionGeneration
        || receipt.requestId !== response.requestId
        || receipt.seq !== response.seq
      ) {
        throw failClosed('receipt-mismatch')
      }
      if (receipt.state !== 'relayed') throw failClosed('relay-unavailable')
    } catch (error) {
      if (error instanceof WindowsCompanionReadySessionError) throw error
      throw failClosed('dispatch-failed')
    } finally {
      busy = false
    }
  }
}
