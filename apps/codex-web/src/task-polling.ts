import type { ActionReceipt, TaskSnapshot } from '@codex-plus/serve-client'

export type TaskPollReconciliation =
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'accept'; snapshot: TaskSnapshot }>

function running(status: TaskSnapshot['task']['status']): boolean {
  return status === 'running' || status === 'syncing'
}

export function reconcileTaskPoll(
  current: TaskSnapshot | undefined,
  next: TaskSnapshot,
): TaskPollReconciliation {
  if (
    current !== undefined
    && (
      next.host.hostId !== current.host.hostId
      || next.host.generation !== current.host.generation
      || next.task.id !== current.task.id
      || next.revision < current.revision
      || (next.revision === current.revision && next.sequence < current.sequence)
    )
  ) return Object.freeze({ kind: 'retry' })

  // An authenticated live-text revision may trim old history to keep the
  // response bounded. Message count is not a freshness clock.
  if (current !== undefined && next.sequence > next.revision && next.sequence > current.sequence) {
    return Object.freeze({ kind: 'accept', snapshot: next })
  }

  if (
    current !== undefined
    && next.revision === current.revision
    && next.messages.length < current.messages.length
  ) {
    if (running(next.task.status)) return Object.freeze({ kind: 'retry' })
    return Object.freeze({
      kind: 'accept',
      snapshot: { ...next, messages: current.messages },
    })
  }
  return Object.freeze({ kind: 'accept', snapshot: next })
}

export function acceptedSendRevision(receipt: ActionReceipt): number | undefined {
  if (receipt.state === 'rejected') {
    throw new Error(receipt.rejection.message || '动作已被拒绝。')
  }
  if (receipt.state === 'queued') {
    throw new Error('发送结果尚不明确，请勿重复提交。')
  }
  return receipt.revision
}
