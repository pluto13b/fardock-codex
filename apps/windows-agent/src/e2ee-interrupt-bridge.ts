import type { InboundFrameCommitRequest } from '../../../packages/e2ee/src/index.ts'
import { encodeApplicationMessage } from '../../../packages/protocol/src/index.ts'

import { runDurableInterruptAction } from './action-controller.ts'
import type {
  ActionStateStore,
  InboundReservationResult,
  StoredActionReceipt,
} from './action-state.ts'
import { OpenedActionRequestError } from './e2ee-action-bridge.ts'
import type { RuntimeCompatibility } from './runtime-binding.ts'
import type { AppServerSupervisor } from './supervisor.ts'

const encoder = new TextEncoder()
const fingerprintDomain = encoder.encode('codex-plus/action-request/v1\0')

export interface OpenedInterruptContext {
  readonly requestId: string
  readonly taskId: string
  readonly reservation: InboundReservationResult
  readonly action: Readonly<{
    actionId: string
    turnId: string
    expectedRevision: number
  }>
}

export async function commitOpenedInterruptAction(
  input: Readonly<{
    store: ActionStateStore
    now: number
    fingerprintCanonicalRequest: (bytes: Uint8Array) => Promise<string>
  }>,
  request: Readonly<InboundFrameCommitRequest>,
): Promise<OpenedInterruptContext> {
  const message = request.message
  if (
    message.kind !== 'request'
    || message.operation !== 'turn.interrupt'
    || request.requestId === undefined
    || request.taskId !== message.params.taskId
    || request.requestId !== message.params.input.actionId
  ) throw new OpenedActionRequestError('unsupported-request')
  const canonical = encoder.encode(encodeApplicationMessage(message))
  const fingerprintInput = new Uint8Array(fingerprintDomain.byteLength + canonical.byteLength)
  fingerprintInput.set(fingerprintDomain)
  fingerprintInput.set(canonical, fingerprintDomain.byteLength)
  const requestFingerprint = await input.fingerprintCanonicalRequest(fingerprintInput)
  const reservation = input.store.commitInboundReservation({
    hostId: request.authority.hostId,
    authorizationId: request.authority.authorizationId,
    authorizationEpoch: request.authority.authorizationEpoch,
    clientDeviceId: request.authority.clientDeviceId,
    connectionGeneration: request.authority.connectionGeneration,
    inboundKeyId: request.keyId,
    sequence: request.sequence,
    ack: request.ack,
    actionId: message.params.input.actionId,
    taskId: message.params.taskId,
    operation: 'turn.interrupt',
    expectedRevision: message.params.input.expected.revision,
    requestFingerprint,
    now: input.now,
  })
  return Object.freeze({
    requestId: request.requestId,
    taskId: message.params.taskId,
    reservation,
    action: Object.freeze({
      actionId: message.params.input.actionId,
      turnId: message.params.input.turnId,
      expectedRevision: message.params.input.expected.revision,
    }),
  })
}

export async function completeOpenedInterruptAction(
  input: Readonly<{
    store: ActionStateStore
    supervisor: AppServerSupervisor
    compatibility: RuntimeCompatibility
    now: number
  }>,
  context: OpenedInterruptContext,
): Promise<Readonly<{
  state: 'action-receipt'
  requestId: string
  taskId: string
  operation: 'turn.interrupt'
  receipt: StoredActionReceipt
}>> {
  const receipt = context.reservation.kind === 'terminal'
    ? context.reservation.receipt
    : await runDurableInterruptAction({
        store: input.store,
        lease: context.reservation.lease,
        supervisor: input.supervisor,
        compatibility: input.compatibility,
        threadId: context.taskId,
        turnId: context.action.turnId,
        actionId: context.action.actionId,
        expectedRevision: context.action.expectedRevision,
        now: input.now,
      })
  return Object.freeze({
    state: 'action-receipt',
    requestId: context.requestId,
    taskId: context.taskId,
    operation: 'turn.interrupt',
    receipt,
  })
}
