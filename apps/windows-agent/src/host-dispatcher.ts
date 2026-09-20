import {
  getEstablishedSessionChannelInfo,
  openEstablishedApplication,
  type AssertSessionAuthorizationActive,
  type EstablishedSessionChannel,
  type InboundFrameCommitRequest,
} from '../../../packages/e2ee/src/index.ts'
import { ProtocolViolation } from '../../../packages/protocol/src/index.ts'
import type { ManagedDevice, StartTaskInput, StartTaskReceipt } from '../../../packages/codex-serve-client/src/index.ts'

import {
  commitOpenedTextAction,
  completeOpenedTextAction,
  OpenedActionRequestError,
  type ExpectedTurnSettings,
  type OpenedTextActionContext,
} from './e2ee-action-bridge.ts'
import { sealEncryptedActionReceipt } from './e2ee-action-response.ts'
import {
  commitOpenedInterruptAction,
  completeOpenedInterruptAction,
  type OpenedInterruptContext,
} from './e2ee-interrupt-bridge.ts'
import {
  commitOpenedManagementAction,
  completeOpenedManagementAction,
  OpenedManagementActionError,
  type ManagementActionContext,
  type ManagementActionHandlers,
} from './e2ee-management-action.ts'
import {
  commitOpenedReadRequest,
  completeOpenedReadRequest,
  OpenedReadRequestError,
  type ReadOperation,
  type ReadFailureCategory,
  type ReadFailureStage,
  type TaskSendDisabledReason,
  type ReadRequestContext,
} from './e2ee-read-bridge.ts'
import type { ActionStateStore } from './action-state.ts'
import type { AppServerReadProjection } from './read-projection.ts'
import type { RuntimeCompatibility } from './runtime-binding.ts'
import type { AppServerSupervisor } from './supervisor.ts'
import type { LiveRequestAuthority } from './live-request-authority.ts'
import type { AcceptedTextTurnProof } from './action-controller.ts'
import {
  commitOpenedRequestResolution,
  completeOpenedRequestResolution,
  type OpenedRequestResolutionContext,
} from './e2ee-request-resolution.ts'

class UnsupportedHostRequest extends Error {}

type OpenedRoute =
  | Readonly<{ kind: 'read'; context: ReadRequestContext }>
  | Readonly<{ kind: 'management'; context: ManagementActionContext }>
  | Readonly<{ kind: 'action'; context: OpenedTextActionContext }>
  | Readonly<{ kind: 'interrupt'; context: OpenedInterruptContext }>
  | Readonly<{ kind: 'resolution'; context: OpenedRequestResolutionContext }>
  | Readonly<{ kind: 'start'; context: Readonly<{ requestId: string; input: StartTaskInput }> }>

export interface HostDispatcherInput {
  readonly state: EstablishedSessionChannel
  readonly frame: string | Uint8Array
  readonly now: number
  readonly store: ActionStateStore
  readonly projection: AppServerReadProjection
  readonly supervisor: AppServerSupervisor
  readonly compatibility: RuntimeCompatibility
  readonly expectedSettings: ExpectedTurnSettings
  readonly attachmentDirectory?: string
  readonly allowFullAccess?: boolean
  readonly isTaskDemoOwned?: (taskId: string) => boolean
  readonly startTask?: (input: StartTaskInput) => Promise<StartTaskReceipt>
  readonly canStartTask?: boolean
  readonly listManagedDevices?: (input: Readonly<{
    currentClientDeviceId: string
    generatedAt: number
  }>) => Promise<readonly ManagedDevice[]>
  readonly managementActions?: ManagementActionHandlers
  readonly liveRequests?: LiveRequestAuthority
  readonly readLiveText?: (taskId: string) => import('./live-text-projection.ts').LiveTextSnapshot | undefined
  readonly onAcceptedTextTurn?: (proof: AcceptedTextTurnProof) => void
  readonly onRuntimeFailure?: (code: import('./turn-runtime.ts').TextTurnRuntimeErrorCode | 'unknown') => void
  readonly assertAuthorizationActive: AssertSessionAuthorizationActive
  readonly onReadFailure?: (
    operation: ReadOperation,
    category: ReadFailureCategory,
    stage: ReadFailureStage,
  ) => void
  readonly onTaskSendDisabled?: (reason: TaskSendDisabledReason) => void
  readonly fingerprintCanonicalRequest: (bytes: Uint8Array) => Promise<string>
}

export type HostDispatcherResult =
  | Readonly<{
      state: 'encrypted-response'
      operation: ReadOperation | 'pairing.create' | 'device.rename' | 'device.revoke' | 'turn.send' | 'turn.steer' | 'turn.interrupt' | 'request.resolve' | 'task.start'
      requestId: string
      taskId?: string
      wireText: string
    }>
  | Readonly<{
      state: 'session-closed'
      reason: 'unsupported-request' | 'settings-mismatch'
    }>

/**
 * Package-private Host endpoint. The request operation is routed only after one
 * authenticated open, inside its durable commit callback.
 */
export async function dispatchEncryptedHostRequest(
  input: HostDispatcherInput,
): Promise<HostDispatcherResult> {
  const info = getEstablishedSessionChannelInfo(input.state)
  if (info.role !== 'host') throw new ProtocolViolation('stale-authority')
  let route: OpenedRoute | undefined

  try {
    await openEstablishedApplication({
      state: input.state,
      frame: input.frame,
      now: input.now,
      assertAuthorizationActive: input.assertAuthorizationActive,
      commitInbound: async request => {
        const message = request.message
        if (
          message.kind === 'request'
          && (
            message.operation === 'model.list'
            || message.operation === 'manage.read'
            || message.operation === 'workspace.list'
            || message.operation === 'task.list'
            || message.operation === 'task.read'
          )
        ) {
          route = Object.freeze({
            kind: 'read' as const,
            context: commitOpenedReadRequest(input, request),
          })
          return
        }
        if (
          message.kind === 'request'
          && (
            message.operation === 'pairing.create'
            || message.operation === 'device.rename'
            || message.operation === 'device.revoke'
          )
        ) {
          route = Object.freeze({
            kind: 'management' as const,
            context: await commitOpenedManagementAction(input, request),
          })
          return
        }
        if (message.kind === 'request' && (message.operation === 'turn.send' || message.operation === 'turn.steer')) {
          route = Object.freeze({
            kind: 'action' as const,
            context: await commitOpenedTextAction(input, request),
          })
          return
        }
        if (message.kind === 'request' && message.operation === 'turn.interrupt') {
          route = Object.freeze({
            kind: 'interrupt' as const,
            context: await commitOpenedInterruptAction(input, request),
          })
          return
        }
        if (message.kind === 'request' && message.operation === 'request.resolve') {
          route = Object.freeze({
            kind: 'resolution' as const,
            context: commitOpenedRequestResolution(input, request),
          })
          return
        }
        if (
          message.kind === 'request'
          && message.operation === 'task.start'
          && input.startTask !== undefined
          && request.requestId === message.params.actionId
          && request.taskId === undefined
          && message.params.expected.hostId === request.authority.hostId
          && message.params.expected.connectionGeneration === request.authority.connectionGeneration
        ) {
          input.store.commitInboundReadOnly({
            hostId: request.authority.hostId,
            authorizationId: request.authority.authorizationId,
            authorizationEpoch: request.authority.authorizationEpoch,
            clientDeviceId: request.authority.clientDeviceId,
            connectionGeneration: request.authority.connectionGeneration,
            inboundKeyId: request.keyId,
            sequence: request.sequence,
            ack: request.ack,
          })
          route = Object.freeze({
            kind: 'start' as const,
            context: Object.freeze({ requestId: request.requestId, input: message.params }),
          })
          return
        }
        throw new UnsupportedHostRequest()
      },
    })
  } catch (error) {
    if (error instanceof OpenedActionRequestError) {
      return Object.freeze({ state: 'session-closed', reason: error.reason })
    }
    if (
      error instanceof OpenedReadRequestError
      || error instanceof OpenedManagementActionError
      || error instanceof UnsupportedHostRequest
    ) {
      return Object.freeze({ state: 'session-closed', reason: 'unsupported-request' })
    }
    throw error
  }

  const selected = route as OpenedRoute | undefined
  if (selected === undefined) throw new ProtocolViolation('internal')
  if (selected.kind === 'read') {
    return completeOpenedReadRequest(input, selected.context)
  }
  if (selected.kind === 'management') {
    const context = await completeOpenedManagementAction({
      state: input.state,
      handlers: input.managementActions,
    }, selected.context)
    return sealEncryptedActionReceipt({
      state: input.state,
      context,
      now: input.now,
      store: input.store,
      assertAuthorizationActive: input.assertAuthorizationActive,
    })
  }
  if (selected.kind === 'interrupt') {
    const context = await completeOpenedInterruptAction(input, selected.context)
    if (context.receipt.state === 'accepted') {
      input.liveRequests?.cancelTask(selected.context.taskId, selected.context.action.turnId)
    }
    return sealEncryptedActionReceipt({
      state: input.state,
      context,
      now: input.now,
      store: input.store,
      assertAuthorizationActive: input.assertAuthorizationActive,
    })
  }
  if (selected.kind === 'resolution') {
    const context = completeOpenedRequestResolution(input, selected.context)
    return sealEncryptedActionReceipt({
      state: input.state,
      context,
      now: input.now,
      store: input.store,
      assertAuthorizationActive: input.assertAuthorizationActive,
    })
  }
  if (selected.kind === 'start') {
    let receipt: StartTaskReceipt
    try {
      receipt = await input.startTask!(selected.context.input)
    } catch {
      receipt = Object.freeze({ actionId: selected.context.input.actionId, state: 'queued' as const })
    }
    const sealed = await sealEncryptedActionReceipt({
      state: input.state,
      context: Object.freeze({
        state: 'start-task-receipt' as const,
        requestId: selected.context.requestId,
        receipt,
      }),
      now: input.now,
      store: input.store,
      assertAuthorizationActive: input.assertAuthorizationActive,
    })
    return Object.freeze({ ...sealed, operation: 'task.start' as const })
  }
  const context = await completeOpenedTextAction(input, selected.context)
  const sealed = await sealEncryptedActionReceipt({
    state: input.state,
    context,
    now: input.now,
    store: input.store,
    assertAuthorizationActive: input.assertAuthorizationActive,
  })
  return Object.freeze({ ...sealed, operation: context.operation })
}
