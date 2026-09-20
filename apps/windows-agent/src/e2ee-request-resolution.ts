import type {
  InboundFrameCommitRequest,
  SessionAuthority,
} from '../../../packages/e2ee/src/index.ts'
import type {
  ApprovalDecision,
  QuestionAnswer,
} from '../../../packages/codex-serve-client/src/index.ts'

import type { ActionStateStore, StoredActionReceipt } from './action-state.ts'
import type { LiveRequestAuthority } from './live-request-authority.ts'
import { OpenedActionRequestError } from './e2ee-action-bridge.ts'

export interface OpenedRequestResolutionContext {
  readonly requestId: string
  readonly taskId: string
  readonly authority: SessionAuthority
  readonly request: ApprovalDecision | QuestionAnswer
}

function storedReceipt(receipt: ReturnType<LiveRequestAuthority['resolve']>): StoredActionReceipt {
  if (receipt.state === 'accepted') {
    return Object.freeze({ actionId: receipt.actionId, state: 'accepted' as const })
  }
  if (receipt.state === 'rejected') {
    return Object.freeze({
      actionId: receipt.actionId,
      state: 'rejected' as const,
      rejection: Object.freeze({ ...receipt.rejection }),
    })
  }
  return Object.freeze({ actionId: receipt.actionId, state: 'queued' as const, recoveryRequired: true as const })
}

export function commitOpenedRequestResolution(
  input: Readonly<{ store: ActionStateStore }>,
  frame: Readonly<InboundFrameCommitRequest>,
): OpenedRequestResolutionContext {
  const message = frame.message
  if (
    message.kind !== 'request'
    || message.operation !== 'request.resolve'
    || frame.requestId === undefined
    || frame.requestId !== message.params.actionId
    || frame.taskId !== message.params.taskId
  ) throw new OpenedActionRequestError('unsupported-request')
  const task = input.store.getTaskState({
    hostId: frame.authority.hostId,
    taskId: message.params.taskId,
  })
  if (
    task === undefined
    || task.writeState !== 'writable'
    || task.revision !== message.params.expected.revision
  ) throw new OpenedActionRequestError('unsupported-request')
  input.store.commitInboundReadOnly({
    hostId: frame.authority.hostId,
    authorizationId: frame.authority.authorizationId,
    authorizationEpoch: frame.authority.authorizationEpoch,
    clientDeviceId: frame.authority.clientDeviceId,
    connectionGeneration: frame.authority.connectionGeneration,
    inboundKeyId: frame.keyId,
    sequence: frame.sequence,
    ack: frame.ack,
  })
  return Object.freeze({
    requestId: frame.requestId,
    taskId: message.params.taskId,
    authority: frame.authority,
    request: message.params,
  })
}

export function completeOpenedRequestResolution(
  input: Readonly<{ liveRequests?: LiveRequestAuthority }>,
  context: OpenedRequestResolutionContext,
): Readonly<{
  state: 'action-receipt'
  requestId: string
  taskId: string
  operation: 'request.resolve'
  receipt: StoredActionReceipt
}> {
  const receipt = input.liveRequests?.resolve(context.request, {
    hostId: context.authority.hostId,
    connectionGeneration: context.authority.connectionGeneration,
    clientDeviceId: context.authority.clientDeviceId,
    authorizationId: context.authority.authorizationId,
  }) ?? {
    actionId: context.request.actionId,
    state: 'rejected' as const,
    rejection: {
      code: 'capability-denied' as const,
      message: 'Live request resolution is unavailable.',
    },
  }
  return Object.freeze({
    state: 'action-receipt',
    requestId: context.requestId,
    taskId: context.taskId,
    operation: 'request.resolve',
    receipt: storedReceipt(receipt),
  })
}
