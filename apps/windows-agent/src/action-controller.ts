import {
  issueTerminalEvidence,
  type ActionStateStore,
  type DurableActionLease,
  type StoredActionReceipt,
} from './action-state.ts'
import type { RuntimeCompatibility } from './runtime-binding.ts'
import type { AppServerSupervisor } from './supervisor.ts'
import { interruptBoundTurn, startBoundTextTurn, steerBoundTextTurn, TextTurnRuntimeError } from './turn-runtime.ts'
import type { AcceptedTextTurn, TextTurnAttachment, TextTurnRuntimeErrorCode, TextTurnSettings } from './turn-runtime.ts'

/**
 * Exact task/turn identity proven by the owned app-server response and exposed
 * only after the matching accepted action receipt is durably committed.
 */
export interface AcceptedTextTurnProof {
  readonly taskId: string
  readonly turnId: string
}

export interface DurableTextActionInput {
  readonly store: ActionStateStore
  readonly lease: DurableActionLease
  readonly supervisor: AppServerSupervisor
  readonly compatibility: RuntimeCompatibility
  readonly threadId: string
  readonly actionId: string
  readonly text: string
  readonly attachments?: readonly TextTurnAttachment[]
  readonly attachmentDirectory?: string
  readonly allowFullAccess?: boolean
  readonly operation?: 'turn.send' | 'turn.steer'
  readonly settings?: TextTurnSettings
  /** Trusted synchronous ownership observer; failures leave ownership unmarked. */
  readonly onAcceptedTextTurn?: (proof: AcceptedTextTurnProof) => void
  readonly onRuntimeFailure?: (code: TextTurnRuntimeErrorCode | 'unknown') => void
  readonly expectedRevision: number
  readonly now: number
}

/** Package-private durable write controller; intentionally not root-exported. */
export async function runDurableTextAction(
  input: DurableTextActionInput,
): Promise<StoredActionReceipt> {
  const acceptedRevision = input.expectedRevision + 1
  if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision <= 0) {
    throw new TypeError('Invalid expected revision.')
  }
  const begun = input.store.beginDispatch(
    input.lease,
    input.compatibility.supervisorGeneration,
    input.now,
  )
  if (begun.kind === 'rejected') return begun.receipt

  let acceptedTurn: AcceptedTextTurn
  try {
    const run = input.operation === 'turn.steer' ? steerBoundTextTurn : startBoundTextTurn
    acceptedTurn = await run(input.supervisor, input.compatibility, {
      threadId: input.threadId,
      actionId: input.actionId,
      text: input.text,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.attachmentDirectory === undefined ? {} : { attachmentDirectory: input.attachmentDirectory }),
      ...(input.allowFullAccess === true ? { allowFullAccess: true } : {}),
      ...(input.settings === undefined ? {} : { settings: input.settings }),
    })
  } catch (error) {
    try {
      input.onRuntimeFailure?.(error instanceof TextTurnRuntimeError ? error.code : 'unknown')
    } catch {}
    if (error instanceof TextTurnRuntimeError && error.submission !== 'unknown') {
      return input.store.commitTerminal(begun.dispatch, issueTerminalEvidence(begun.dispatch, {
        state: 'rejected',
        code: error.code === 'catalog-unavailable' ? 'invalid-input' : 'capability-denied',
        message: error.code === 'catalog-unavailable'
            ? '模型或推理强度已不可用，请刷新模型列表后重新选择。'
            : '本次消息未被接受，请刷新任务状态后再发送。',
      }), input.now)
    }
    return input.store.commitTerminal(
      begun.dispatch,
      issueTerminalEvidence(begun.dispatch, {
        state: 'indeterminate',
        reason: 'runtime-outcome-unknown',
      }),
      input.now,
    )
  }

  const receipt = input.store.commitTerminal(
    begun.dispatch,
    issueTerminalEvidence(begun.dispatch, {
      state: 'accepted',
      revision: acceptedRevision,
    }),
    input.now,
  )
  if (receipt.state === 'accepted') {
    try {
      input.onAcceptedTextTurn?.(Object.freeze({
        taskId: acceptedTurn.threadId,
        turnId: acceptedTurn.turnId,
      }))
    } catch {
      // Acceptance is already durable. A failed observer grants no new authority
      // and cannot roll back or fabricate the stored app-server outcome.
    }
  }
  return receipt
}

export async function runDurableInterruptAction(input: Readonly<{
  store: ActionStateStore
  lease: DurableActionLease
  supervisor: AppServerSupervisor
  compatibility: RuntimeCompatibility
  threadId: string
  turnId: string
  actionId: string
  expectedRevision: number
  now: number
}>): Promise<StoredActionReceipt> {
  const acceptedRevision = input.expectedRevision + 1
  if (!Number.isSafeInteger(acceptedRevision) || acceptedRevision <= 0) {
    throw new TypeError('Invalid expected revision.')
  }
  const begun = input.store.beginDispatch(
    input.lease,
    input.compatibility.supervisorGeneration,
    input.now,
  )
  if (begun.kind === 'rejected') return begun.receipt
  try {
    await interruptBoundTurn(input.supervisor, input.compatibility, {
      threadId: input.threadId,
      turnId: input.turnId,
    })
  } catch {
    return input.store.commitTerminal(
      begun.dispatch,
      issueTerminalEvidence(begun.dispatch, {
        state: 'indeterminate',
        reason: 'runtime-outcome-unknown',
      }),
      input.now,
    )
  }
  return input.store.commitTerminal(
    begun.dispatch,
    issueTerminalEvidence(begun.dispatch, {
      state: 'accepted',
      revision: acceptedRevision,
    }),
    input.now,
  )
}
