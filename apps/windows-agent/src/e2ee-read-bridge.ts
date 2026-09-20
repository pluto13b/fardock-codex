import { readModelCatalog } from './model-catalog.ts'
import {
  getEstablishedSessionChannelInfo,
  openEstablishedApplication,
  sealEstablishedApplication,
  type AssertSessionAuthorizationActive,
  type EstablishedSessionChannel,
  type InboundFrameCommitRequest,
  type OutboundFrameCommitRequest,
  type OutboundSequenceReservationRequest,
  type SessionAuthority,
} from '../../../packages/e2ee/src/index.ts'
import {
  ApplicationResponseSchema,
  PROTOCOL_VERSION,
  ProtocolViolation,
  protocolErrorPayload,
  type ApplicationRequest,
  type ApplicationResponse,
} from '../../../packages/protocol/src/index.ts'
import type { ManagedDevice } from '../../../packages/codex-serve-client/src/index.ts'
import type { LiveTextSnapshot } from './live-text-projection.ts'

import {
  ActionStateError,
  type ActionStateStore,
  type DurableTaskStateSnapshot,
} from './action-state.ts'
import type { ExpectedTurnSettings } from './e2ee-action-bridge.ts'
import {
  AppServerReadProjection,
  AppServerReadProjectionError,
  type ProjectedThreadStatus,
  type ProjectedTimelineItem,
  type ProjectedTurn,
  type ReadOnlyTaskProjection,
  type ReadOnlyTaskSummary,
} from './read-projection.ts'
import {
  isRuntimeCompatibilityCurrent,
  type RuntimeCompatibility,
} from './runtime-binding.ts'
import type { AppServerSupervisor } from './supervisor.ts'
import type { LiveRequestAuthority } from './live-request-authority.ts'

const READ_RESPONSE_TTL_MS = 30_000
const PROJECTED_MESSAGE_BUDGET_BYTES = 384 * 1024
const MAX_PROJECTED_MESSAGES = 2_048

export type ReadOperation = 'model.list' | 'manage.read' | 'workspace.list' | 'task.list' | 'task.read'
export type ReadFailureCategory =
  | `action-state:${ActionStateError['code']}`
  | `projection:${AppServerReadProjectionError['code']}`
  | `protocol:${ProtocolViolation['code']}`
  | 'response-schema'
  | 'unknown'
export type ReadFailureStage = 'projection' | 'authority-seed' | 'authority-update' | 'response'
export type TaskSendDisabledReason =
  | 'blocked-indeterminate'
  | 'runtime-read-only'
  | 'compatibility'
  | 'status-syncing'
  | 'status-running'
  | 'status-waiting-approval'
  | 'status-failed'
  | 'status-unknown'
  | 'live-request'

export class OpenedReadRequestError extends Error {}
class MissingReadAuthority extends Error {}

export interface E2eeReadBridgeInput {
  readonly state: EstablishedSessionChannel
  readonly frame: string | Uint8Array
  readonly now: number
  readonly store: ActionStateStore
  readonly projection: AppServerReadProjection
  readonly supervisor: AppServerSupervisor
  readonly compatibility: RuntimeCompatibility
  readonly expectedSettings: ExpectedTurnSettings
  readonly isTaskDemoOwned?: (taskId: string) => boolean
  readonly canStartTask?: boolean
  readonly listManagedDevices?: (input: Readonly<{
    currentClientDeviceId: string
    generatedAt: number
  }>) => Promise<readonly ManagedDevice[]>
  readonly liveRequests?: LiveRequestAuthority
  readonly readLiveText?: (taskId: string) => LiveTextSnapshot | undefined
  readonly assertAuthorizationActive: AssertSessionAuthorizationActive
  readonly onReadFailure?: (
    operation: ReadOperation,
    category: ReadFailureCategory,
    stage: ReadFailureStage,
  ) => void
  readonly onTaskSendDisabled?: (reason: TaskSendDisabledReason) => void
}

export function classifyReadFailure(error: unknown): ReadFailureCategory {
  if (error instanceof ActionStateError) return `action-state:${error.code}`
  if (error instanceof AppServerReadProjectionError) return `projection:${error.code}`
  if (error instanceof ProtocolViolation) return `protocol:${error.code}`
  if (error instanceof Error && error.name === 'ZodError') return 'response-schema'
  return 'unknown'
}

export type E2eeReadBridgeResult =
  | Readonly<{
      state: 'encrypted-response'
      operation: ReadOperation
      requestId: string
      taskId?: string
      wireText: string
    }>
  | Readonly<{
      state: 'session-closed'
      reason: 'unsupported-request'
    }>

export interface ReadRequestContext {
  readonly requestId: string
  readonly taskId?: string
  readonly message: Extract<ApplicationRequest, { operation: ReadOperation }>
}

function sameAuthority(left: SessionAuthority, right: SessionAuthority): boolean {
  return left.relayOrigin === right.relayOrigin
    && left.hostId === right.hostId
    && left.hostDeviceId === right.hostDeviceId
    && left.clientDeviceId === right.clientDeviceId
    && left.authorizationId === right.authorizationId
    && left.authorizationEpoch === right.authorizationEpoch
    && left.handshakeId === right.handshakeId
    && left.connectionGeneration === right.connectionGeneration
    && left.sessionTranscriptHash === right.sessionTranscriptHash
}

function taskStatus(
  status: ProjectedThreadStatus,
): 'syncing' | 'running' | 'waiting-approval' | 'failed' | 'unknown' {
  if (status.type === 'notLoaded') return 'syncing'
  if (status.type === 'systemError') return 'failed'
  if (status.type === 'idle') return 'unknown'
  return status.activeFlags.includes('waitingOnApproval')
    ? 'waiting-approval'
    : 'running'
}

function readTaskStatus(projection: ReadOnlyTaskProjection): Readonly<{
  status: 'syncing' | 'running' | 'waiting-approval' | 'completed' | 'failed' | 'unknown'
  completionReason?: 'completed' | 'interrupted' | 'failed'
}> {
  const status = projection.task.status
  if (status.type !== 'idle' && status.type !== 'notLoaded') {
    return Object.freeze({ status: taskStatus(status) })
  }
  const lastTurn = projection.turns.at(-1)
  if (lastTurn?.status === 'completed') {
    return Object.freeze({ status: 'completed', completionReason: 'completed' })
  }
  if (lastTurn?.status === 'failed' || lastTurn?.status === 'interrupted') {
    return Object.freeze({
      status: 'failed',
      completionReason: lastTurn.status,
    })
  }
  return Object.freeze({ status: 'unknown' })
}

function requireTaskAuthority(
  store: ActionStateStore,
  hostId: string,
  task: ReadOnlyTaskSummary,
): DurableTaskStateSnapshot {
  const state = store.getTaskState({ hostId, taskId: task.id })
  if (state === undefined || state.workspaceId !== task.workspaceId) {
    throw new MissingReadAuthority()
  }
  return state
}

function ensureTaskAuthority(
  store: ActionStateStore,
  hostId: string,
  task: ReadOnlyTaskSummary,
): DurableTaskStateSnapshot {
  const existing = store.getTaskState({ hostId, taskId: task.id })
  if (existing === undefined) {
    store.upsertTask({
      hostId,
      taskId: task.id,
      workspaceId: task.workspaceId,
      revision: 0,
      writeState: 'read-only',
      canSend: false,
      canInterrupt: false,
    })
  } else if (existing.workspaceId !== task.workspaceId) {
    throw new MissingReadAuthority()
  }
  return requireTaskAuthority(store, hostId, task)
}

function listTaskSummary(
  task: ReadOnlyTaskSummary,
  authority: DurableTaskStateSnapshot,
): unknown {
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    status: taskStatus(task.status),
    updatedAt: task.updatedAt,
    revision: authority.revision,
  }
}

function commandState(state: Extract<ProjectedTimelineItem, { kind: 'command' }>['state']):
  'running' | 'completed' | 'failed' {
  if (state === 'inProgress') return 'running'
  if (state === 'completed') return 'completed'
  return 'failed'
}

function reasoningState(turn: ProjectedTurn): 'running' | 'completed' {
  return turn.status === 'inProgress' ? 'running' : 'completed'
}

function projectMessages(projection: ReadOnlyTaskProjection, live?: LiveTextSnapshot): Readonly<{
  messages: readonly unknown[]
  omitted: boolean
}> {
  const messages: unknown[] = []
  const messageBytes: number[] = []
  let retainedBytes = 0
  let omitted = projection.completeness === 'partial'
  const remainingLive = new Map(live?.messages.map(message => [message.id, message]))
  const pushMessage = (message: unknown): void => {
    let bytes: number
    try {
      bytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
    } catch {
      omitted = true
      return
    }
    if (bytes > PROJECTED_MESSAGE_BUDGET_BYTES) {
      omitted = true
      return
    }
    messages.push(message)
    messageBytes.push(bytes)
    retainedBytes += bytes
    while (
      retainedBytes > PROJECTED_MESSAGE_BUDGET_BYTES
      || messages.length > MAX_PROJECTED_MESSAGES
    ) {
      messages.shift()
      retainedBytes -= messageBytes.shift() ?? 0
      omitted = true
    }
  }
  for (const turn of projection.turns) {
    for (const item of turn.items) {
      const base = { id: item.id, turnId: turn.id, createdAt: item.createdAt }
      if (item.kind === 'user') {
        const textInputs = item.inputs.filter((input) => input.type === 'text')
        const attachmentInputs = item.inputs.filter((input) => input.type === 'localImage' || input.type === 'file')
        const unsupportedInputs = item.inputs.filter((input) => input.type === 'compatibility')
        if (textInputs.length === 0 && attachmentInputs.length === 0) {
          omitted = true
          continue
        }
        if (unsupportedInputs.length > 0) omitted = true
        const display = [
          ...textInputs.map((input) => input.text),
          ...attachmentInputs.map((input) => input.type === 'localImage' ? '[Image]' : `[File: ${input.name}]`),
        ].join('\n')
        pushMessage({
          ...base,
          kind: 'user',
          text: display,
          ...(textInputs.length === 0 ? {} : { input: textInputs.map((input) => ({ type: 'text', text: input.text })) }),
        })
        continue
      }
      if (item.kind === 'assistant') {
        const streamed = remainingLive.get(item.id)
        if (streamed?.turnId === turn.id) remainingLive.delete(item.id)
        pushMessage({ ...base, kind: 'assistant', markdown: streamed?.turnId === turn.id && streamed.markdown.length > item.text.length ? streamed.markdown : item.text })
        continue
      }
      if (item.kind === 'plan') {
        pushMessage({
          ...base,
          kind: 'reasoning',
          title: 'Plan',
          summary: item.text,
          state: reasoningState(turn),
        })
        continue
      }
      if (item.kind === 'reasoning') {
        pushMessage({
          ...base,
          kind: 'reasoning',
          title: 'Reasoning',
          summary: item.summary.join('\n'),
          state: reasoningState(turn),
        })
        continue
      }
      if (item.kind === 'command') {
        pushMessage({
          ...base,
          kind: 'tool',
          title: 'Command',
          summary: commandState(item.state),
          command: item.command,
          ...(item.output === null ? {} : { output: item.output }),
          state: commandState(item.state),
        })
        continue
      }
      if (item.kind === 'fileChange') {
        pushMessage({
          ...base,
          kind: 'diff',
          files: item.changes.map((change) => ({
            path: change.path,
            additions: change.additions,
            deletions: change.deletions,
          })),
        })
        continue
      }
      if (item.kind === 'webSearch') {
        pushMessage({
          ...base,
          kind: 'tool',
          title: 'Web Search',
          summary: item.query || item.actionType,
          state: 'completed',
        })
        continue
      }
      if (item.kind === 'operation') {
        pushMessage({
          ...base,
          kind: 'tool',
          title: item.title,
          summary: item.summary,
          state: item.state,
        })
        continue
      }
      if (item.kind === 'compatibility') {
        omitted = true
        pushMessage({
          ...base,
          kind: 'tool',
          title: 'Unsupported item',
          summary: item.itemType,
          state: 'completed',
        })
      }
    }
  }
  for (const message of remainingLive.values()) pushMessage(message)
  return Object.freeze({ messages: Object.freeze(messages), omitted })
}

function failureResponse(
  operation: ReadOperation,
  taskId: string | undefined,
  code: 'stale-authority' | 'internal',
): ApplicationResponse {
  return ApplicationResponseSchema.parse({
    kind: 'response',
    operation,
    ...(taskId === undefined ? {} : { taskId }),
    ok: false,
    error: protocolErrorPayload(code),
  })
}

async function applicationResponse(
  input: E2eeReadBridgeInput,
  context: ReadRequestContext,
  authority: SessionAuthority,
): Promise<ApplicationResponse> {
  let failureStage: ReadFailureStage = 'projection'
  try {
    if (context.message.operation === 'model.list') {
      return ApplicationResponseSchema.parse({ kind: 'response', operation: 'model.list', ok: true, result: await readModelCatalog(input.supervisor) })
    }
    if (context.message.operation === 'manage.read') {
      if (input.listManagedDevices === undefined) throw new Error('management-unavailable')
      const devices = await input.listManagedDevices({
        currentClientDeviceId: authority.clientDeviceId,
        generatedAt: input.now,
      })
      const appServer = input.compatibility.state === 'write-bound'
        ? (isRuntimeCompatibilityCurrent(input.supervisor, input.compatibility) ? 'compatible' : 'unavailable')
        : 'read-only'
      const eventId = (suffix: string): string => `manage.${input.now}.${suffix}`
      return ApplicationResponseSchema.parse({
        kind: 'response',
        operation: 'manage.read',
        ok: true,
        result: {
          generatedAt: input.now,
          hostId: authority.hostId,
          connectionGeneration: authority.connectionGeneration,
          layers: {
            gateway: 'healthy',
            relaySocket: 'authenticated',
            host: 'online',
            e2ee: 'ready',
            companion: 'online',
            appServer,
          },
          devices: [...devices],
          events: [
            { eventId: eventId('gateway'), category: 'gateway', state: 'healthy', occurredAt: input.now },
            { eventId: eventId('relay'), category: 'relay', state: 'authenticated', occurredAt: input.now },
            { eventId: eventId('host'), category: 'host', state: 'online', occurredAt: input.now },
            { eventId: eventId('e2ee'), category: 'e2ee', state: 'ready', occurredAt: input.now },
            { eventId: eventId('companion'), category: 'companion', state: 'online', occurredAt: input.now },
            { eventId: eventId('app'), category: 'app-server', state: appServer, occurredAt: input.now },
            { eventId: eventId('device'), category: 'device', state: 'authenticated', occurredAt: input.now },
          ],
        },
      })
    }

    if (context.message.operation === 'workspace.list') {
      return ApplicationResponseSchema.parse({
        kind: 'response',
        operation: 'workspace.list',
        ok: true,
        result: input.projection.listAuthorizedWorkspaces().map((workspace) => ({
          ...workspace,
          hostId: authority.hostId,
          connectionGeneration: authority.connectionGeneration,
          connection: 'online',
          capabilities: { startTask: input.canStartTask === true },
        })),
      })
    }

    if (context.message.operation === 'task.list') {
      const page = await input.projection.listTasks(context.message.params.cursor)
      return ApplicationResponseSchema.parse({
        kind: 'response',
        operation: 'task.list',
        ok: true,
        result: {
          tasks: page.tasks.map((task) => listTaskSummary(
            task,
            ensureTaskAuthority(input.store, authority.hostId, task),
          )),
          ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
        },
      })
    }

    const demoOwnedTask = input.isTaskDemoOwned?.(context.message.params.taskId) === true
    // Ownership controls writes, never the history read budget. Production
    // polling must stay paginated after its first accepted send as well.
    const projection = await input.projection.readTask(context.message.params.taskId)
    failureStage = 'authority-seed'
    let taskAuthority = ensureTaskAuthority(
      input.store,
      authority.hostId,
      projection.task,
    )
    const demoOwnedActiveTurn = taskAuthority.canInterrupt
    const status = readTaskStatus(projection)
    const liveText = input.readLiveText?.(context.message.params.taskId)
    const projectedMessages = projectMessages(projection, liveText)
    const liveMessages = input.liveRequests?.messagesForTask({
      taskId: projection.task.id,
      activeTurnId: projection.activeTurnId,
      hostId: authority.hostId,
      connectionGeneration: authority.connectionGeneration,
      clientDeviceId: authority.clientDeviceId,
      authorizationId: authority.authorizationId,
    }) ?? []
    const taskWriteBlocked = taskAuthority.writeState === 'blocked-indeterminate'
    const runtimeWriteBound = input.compatibility.state === 'write-bound'
      && isRuntimeCompatibilityCurrent(input.supervisor, input.compatibility)
    const projectionWriteSafe = runtimeWriteBound
      && projection.compatibility.length === 0
      && !taskWriteBlocked
    const terminalCanContinue = status.status === 'completed'
      || (status.status === 'failed' && status.completionReason !== undefined)
    const sendTurn = projectionWriteSafe
      && terminalCanContinue
      && liveMessages.length === 0
    if (!sendTurn) {
      const reason: TaskSendDisabledReason = taskWriteBlocked
        ? 'blocked-indeterminate'
        : !runtimeWriteBound
          ? 'runtime-read-only'
          : projection.compatibility.length > 0
            ? 'compatibility'
            : status.status !== 'completed'
              ? `status-${status.status}`
              : 'live-request'
      try { input.onTaskSendDisabled?.(reason) } catch {}
    }
    const interruptTurn = projectionWriteSafe
      && projection.activeTurnId !== null
      && (status.status === 'running' || status.status === 'waiting-approval')
      && demoOwnedActiveTurn
      && (input.isTaskDemoOwned === undefined || demoOwnedTask)
    const steerTurn = interruptTurn && liveMessages.length === 0
    failureStage = 'authority-update'
    if (!taskWriteBlocked) {
      input.store.upsertTask({
        hostId: authority.hostId,
        taskId: projection.task.id,
        workspaceId: projection.task.workspaceId,
        revision: taskAuthority.revision,
        writeState: projectionWriteSafe ? 'writable' : 'read-only',
        canSend: sendTurn,
        canInterrupt: interruptTurn,
      })
    }
    taskAuthority = requireTaskAuthority(
      input.store,
      authority.hostId,
      projection.task,
    )
    failureStage = 'response'
    const workspace = {
      ...projection.workspace,
      hostId: authority.hostId,
      connectionGeneration: authority.connectionGeneration,
      connection: 'online' as const,
      capabilities: { startTask: input.canStartTask === true },
    }
    const task = {
      id: projection.task.id,
      workspaceId: projection.task.workspaceId,
      title: projection.task.title,
      status: liveMessages.length > 0 ? 'waiting-approval' as const : status.status,
      updatedAt: projection.task.updatedAt,
      revision: taskAuthority.revision,
      ...(projection.activeTurnId === null ? {} : { activeTurnId: projection.activeTurnId }),
      ...(status.completionReason === undefined
        ? {}
        : { completionReason: status.completionReason }),
    }
    return ApplicationResponseSchema.parse({
      kind: 'response',
      operation: 'task.read',
      taskId: projection.task.id,
      ok: true,
      result: {
        authoritative: true,
        host: {
          hostId: authority.hostId,
          generation: authority.connectionGeneration,
          state: 'online',
        },
        revision: taskAuthority.revision,
        sequence: taskAuthority.revision + (liveText?.version ?? 0),
        cursor: `r5-revision-${taskAuthority.revision}${liveText === undefined ? '' : `-live-${liveText.version}`}`,
        capabilities: {
          sendTurn,
          steerTurn,
          interruptTurn,
          resolveApproval: liveMessages.some(message => message.kind === 'approval'),
          answerQuestion: liveMessages.some(message => message.kind === 'question'),
        },
        ...(projection.activeTurnId === null ? {} : { activeTurnId: projection.activeTurnId }),
        task,
        workspace,
        ...(projection.branch === null ? {} : { branch: projection.branch }),
        model: projection.model ?? input.expectedSettings.model,
        effort: projection.effort ?? input.expectedSettings.effort,
        permission: input.expectedSettings.permission,
        messages: [...projectedMessages.messages, ...liveMessages],
        sources: [],
      },
    })
  } catch (error) {
    try {
      input.onReadFailure?.(context.message.operation, classifyReadFailure(error), failureStage)
    } catch {}
    return failureResponse(
      context.message.operation,
      context.taskId,
      error instanceof MissingReadAuthority ? 'stale-authority' : 'internal',
    )
  }
}

function requireReservation(
  request: Readonly<OutboundSequenceReservationRequest>,
  expected: Readonly<{
    authority: SessionAuthority
    outboundKeyId: string
    requestId: string
    taskId?: string
  }>,
): void {
  if (
    !sameAuthority(request.authority, expected.authority)
    || request.keyId !== expected.outboundKeyId
    || request.direction !== 'host-to-client'
    || request.header.protocolVersion !== PROTOCOL_VERSION
    || request.header.connectionGeneration !== expected.authority.connectionGeneration
    || request.header.fromDeviceId !== expected.authority.hostDeviceId
    || request.header.toDeviceId !== expected.authority.clientDeviceId
    || request.header.hostId !== expected.authority.hostId
    || request.header.keyId !== expected.outboundKeyId
    || request.header.requestId !== expected.requestId
    || request.header.taskId !== expected.taskId
    || request.header.messageType !== 'response'
  ) {
    throw new ProtocolViolation('stale-authority')
  }
}

function requireCommit(
  request: Readonly<OutboundFrameCommitRequest>,
  expected: Readonly<{
    authority: SessionAuthority
    outboundKeyId: string
    sequence: number
  }>,
): void {
  if (
    !sameAuthority(request.authority, expected.authority)
    || request.keyId !== expected.outboundKeyId
    || request.sequence !== expected.sequence
  ) {
    throw new ProtocolViolation('stale-authority')
  }
}

/** Package-private helper for an already authenticated open callback. */
export function commitOpenedReadRequest(
  input: Pick<E2eeReadBridgeInput, 'store'>,
  request: Readonly<InboundFrameCommitRequest>,
): ReadRequestContext {
  const message = request.message
  if (
      message.kind !== 'request'
      || (
      message.operation !== 'model.list'
      && message.operation !== 'manage.read'
      && message.operation !== 'workspace.list'
      && message.operation !== 'task.list'
      && message.operation !== 'task.read'
    )
    || request.requestId === undefined
  ) {
    throw new OpenedReadRequestError()
  }
  const taskId = message.operation === 'task.read'
    ? message.params.taskId
    : undefined
  if (request.taskId !== taskId) throw new OpenedReadRequestError()
  const context = Object.freeze({
    requestId: request.requestId,
    ...(taskId === undefined ? {} : { taskId }),
    message,
  })
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
  return context
}

/** Package-private completion path called only after the authenticated commit. */
export async function completeOpenedReadRequest(
  input: E2eeReadBridgeInput,
  context: ReadRequestContext,
): Promise<Extract<E2eeReadBridgeResult, { state: 'encrypted-response' }>> {
  const info = getEstablishedSessionChannelInfo(input.state)
  if (info.role !== 'host') throw new ProtocolViolation('stale-authority')
  const response = await applicationResponse(input, context, info.authority)
  const expected = Object.freeze({
    authority: info.authority,
    outboundKeyId: info.outboundKeyId,
    requestId: context.requestId,
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
  })
  let reservedSequence: number | undefined
  const sealed = await sealEstablishedApplication({
    state: input.state,
    header: {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration: info.authority.connectionGeneration,
      fromDeviceId: info.authority.hostDeviceId,
      toDeviceId: info.authority.clientDeviceId,
      hostId: info.authority.hostId,
      keyId: info.outboundKeyId,
      requestId: context.requestId,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
      sentAt: input.now,
      expiresAt: input.now + READ_RESPONSE_TTL_MS,
      messageType: 'response',
    },
    message: response,
    now: input.now,
    assertAuthorizationActive: input.assertAuthorizationActive,
    persistence: {
      reserveSequence: async request => {
        requireReservation(request, expected)
        const channel = input.store.getChannelState({
          hostId: info.authority.hostId,
          authorizationId: info.authority.authorizationId,
          authorizationEpoch: info.authority.authorizationEpoch,
          connectionGeneration: info.authority.connectionGeneration,
          inboundKeyId: info.inboundKeyId,
        })
        const sequence = channel.maxSentSequence + 1
        if (sequence !== request.expectedSequence) {
          throw new ProtocolViolation(
            sequence < request.expectedSequence ? 'replay' : 'sequence-gap',
          )
        }
        reservedSequence = sequence
        return sequence
      },
      commitFrame: async request => {
        if (reservedSequence === undefined) throw new ProtocolViolation('stale-authority')
        requireCommit(request, {
          authority: info.authority,
          outboundKeyId: info.outboundKeyId,
          sequence: reservedSequence,
        })
        input.store.commitOutboundFrame({
          hostId: info.authority.hostId,
          authorizationId: info.authority.authorizationId,
          authorizationEpoch: info.authority.authorizationEpoch,
          connectionGeneration: info.authority.connectionGeneration,
          inboundKeyId: info.inboundKeyId,
          outboundKeyId: info.outboundKeyId,
          sequence: reservedSequence,
          encryptedWireText: request.wireText,
        })
      },
    },
  })

  return Object.freeze({
    state: 'encrypted-response' as const,
    operation: context.message.operation,
    requestId: context.requestId,
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    wireText: sealed.wireText,
  })
}

/** Package-private authenticated read bridge; intentionally not root-exported. */
export async function dispatchEncryptedReadRequest(
  input: E2eeReadBridgeInput,
): Promise<E2eeReadBridgeResult> {
  const initialInfo = getEstablishedSessionChannelInfo(input.state)
  if (initialInfo.role !== 'host') throw new ProtocolViolation('stale-authority')
  let context: ReadRequestContext | undefined
  try {
    await openEstablishedApplication({
      state: input.state,
      frame: input.frame,
      now: input.now,
      assertAuthorizationActive: input.assertAuthorizationActive,
      commitInbound: async request => {
        context = commitOpenedReadRequest(input, request)
      },
    })
  } catch (error) {
    if (error instanceof OpenedReadRequestError) {
      return Object.freeze({ state: 'session-closed', reason: 'unsupported-request' })
    }
    throw error
  }

  if (context === undefined) throw new ProtocolViolation('internal')
  return completeOpenedReadRequest(input, context)
}
