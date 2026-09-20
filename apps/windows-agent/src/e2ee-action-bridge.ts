import {
  openEstablishedApplication,
  type AssertSessionAuthorizationActive,
  type EstablishedSessionChannel,
  type InboundFrameCommitRequest,
} from '../../../packages/e2ee/src/index.ts'
import { encodeApplicationMessage } from '../../../packages/protocol/src/index.ts'

import {
  runDurableTextAction,
  type AcceptedTextTurnProof,
} from './action-controller.ts'
import {
  type ActionStateStore,
  type InboundReservationResult,
  type StoredActionReceipt,
} from './action-state.ts'
import type { RuntimeCompatibility } from './runtime-binding.ts'
import type { AppServerSupervisor } from './supervisor.ts'
import { isSupportedTextTurnSettings, type TextTurnSettings } from './turn-runtime.ts'
import type { TextTurnAttachment } from './turn-runtime.ts'

const encoder = new TextEncoder()
const fingerprintDomain = encoder.encode('codex-plus/action-request/v1\0')

type SessionClosedReason = 'unsupported-request' | 'settings-mismatch'

export class OpenedActionRequestError extends Error {
  constructor(readonly reason: SessionClosedReason) {
    super('The E2EE session was closed.')
  }
}

export interface ExpectedTurnSettings {
  readonly model: string
  readonly effort: string
  readonly permission: 'ask' | 'read-only' | 'full-access'
}

export interface E2eeActionBridgeInput {
  readonly state: EstablishedSessionChannel
  readonly frame: string | Uint8Array
  readonly now: number
  readonly store: ActionStateStore
  readonly supervisor: AppServerSupervisor
  readonly compatibility: RuntimeCompatibility
  readonly expectedSettings: ExpectedTurnSettings
  readonly attachmentDirectory?: string
  readonly allowFullAccess?: boolean
  readonly onAcceptedTextTurn?: (proof: AcceptedTextTurnProof) => void
  readonly onRuntimeFailure?: (code: import('./turn-runtime.ts').TextTurnRuntimeErrorCode | 'unknown') => void
  readonly assertAuthorizationActive: AssertSessionAuthorizationActive
  readonly fingerprintCanonicalRequest: (bytes: Uint8Array) => Promise<string>
}

export type E2eeActionBridgeResult =
  | Readonly<{
      state: 'action-receipt'
      requestId: string
      taskId: string
      operation: 'turn.send' | 'turn.steer'
      receipt: StoredActionReceipt
    }>
  | Readonly<{
      state: 'session-closed'
      reason: SessionClosedReason
    }>

export interface OpenedTextActionInput {
  readonly now: number
  readonly store: ActionStateStore
  readonly supervisor: AppServerSupervisor
  readonly compatibility: RuntimeCompatibility
  readonly expectedSettings: ExpectedTurnSettings
  readonly attachmentDirectory?: string
  readonly allowFullAccess?: boolean
  readonly onAcceptedTextTurn?: (proof: AcceptedTextTurnProof) => void
  readonly onRuntimeFailure?: (code: import('./turn-runtime.ts').TextTurnRuntimeErrorCode | 'unknown') => void
  readonly fingerprintCanonicalRequest: (bytes: Uint8Array) => Promise<string>
}

export interface OpenedTextActionContext {
  readonly requestId: string
  readonly taskId: string
  readonly reservation: InboundReservationResult
  readonly action: Readonly<{
    operation: 'turn.send' | 'turn.steer'
    threadId: string
    actionId: string
    text: string
    attachments: readonly TextTurnAttachment[]
    settings?: TextTurnSettings
    expectedRevision: number
  }>
}

/** Package-private helper for an already authenticated open callback. */
export async function commitOpenedTextAction(
  input: OpenedTextActionInput,
  request: Readonly<InboundFrameCommitRequest>,
): Promise<OpenedTextActionContext> {
  const message = request.message
  if (
    message.kind !== 'request'
    || (message.operation !== 'turn.send' && message.operation !== 'turn.steer')
  ) {
    throw new OpenedActionRequestError('unsupported-request')
  }
  const inputs = message.params.input.input
  const textInput = inputs[0]?.type === 'text' ? inputs[0] : undefined
  const attachmentRefs = inputs.slice(textInput === undefined ? 0 : 1)
  if (
    inputs.length === 0
    || inputs.slice(1).some(value => value.type === 'text')
    || attachmentRefs.some(value => value.type === 'text')
  ) throw new OpenedActionRequestError('unsupported-request')
  const sidecars = message.params.input.attachments ?? []
  const sidecarById = new Map(sidecars.map(value => [value.attachmentId, value]))
  const attachments: TextTurnAttachment[] = []
  for (const ref of attachmentRefs) {
    if (ref.type === 'text') throw new OpenedActionRequestError('unsupported-request')
    const sidecar = sidecarById.get(ref.attachmentId)
    if (sidecar === undefined) throw new OpenedActionRequestError('unsupported-request')
    attachments.push(Object.freeze({
      kind: ref.type,
      attachmentId: ref.attachmentId,
      name: ref.name,
      mediaType: sidecar.mediaType,
      byteLength: sidecar.byteLength,
      contentBase64Url: sidecar.contentBase64Url,
    }))
  }
  const settings = message.operation === 'turn.send' ? message.params.input.settings : undefined
  if (settings !== undefined && !isSupportedTextTurnSettings(settings, input.allowFullAccess === true)) {
    throw new OpenedActionRequestError('settings-mismatch')
  }
  const action = Object.freeze({
    operation: message.operation,
    threadId: message.params.taskId,
    actionId: message.params.input.actionId,
    text: textInput?.text ?? '',
    attachments: Object.freeze(attachments),
    ...(settings === undefined ? {} : { settings: Object.freeze({
      model: settings.model,
      effort: settings.effort,
      permission: settings.permission,
    }) }),
    expectedRevision: message.params.input.expected.revision,
  })
  if (
    request.requestId !== action.actionId
    || request.taskId !== action.threadId
    || message.params.input.expected.hostId !== request.authority.hostId
    || message.params.input.expected.connectionGeneration
      !== request.authority.connectionGeneration
  ) {
    throw new OpenedActionRequestError('unsupported-request')
  }
  const canonical = encoder.encode(encodeApplicationMessage(message))
  const fingerprintInput = new Uint8Array(
    fingerprintDomain.byteLength + canonical.byteLength,
  )
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
    actionId: action.actionId,
    taskId: action.threadId,
    operation: action.operation,
    expectedRevision: action.expectedRevision,
    requestFingerprint,
    now: input.now,
  })
  return Object.freeze({
    requestId: request.requestId,
    taskId: request.taskId,
    reservation,
    action,
  })
}

/** Package-private helper called only after the authenticated commit succeeds. */
export async function completeOpenedTextAction(
  input: OpenedTextActionInput,
  context: OpenedTextActionContext,
): Promise<Extract<E2eeActionBridgeResult, { state: 'action-receipt' }>> {
  const receipt = context.reservation.kind === 'terminal'
    ? context.reservation.receipt
    : await runDurableTextAction({
        store: input.store,
        lease: context.reservation.lease,
        supervisor: input.supervisor,
        compatibility: input.compatibility,
        threadId: context.action.threadId,
        actionId: context.action.actionId,
        text: context.action.text,
        attachments: context.action.attachments,
        ...(input.attachmentDirectory === undefined ? {} : { attachmentDirectory: input.attachmentDirectory }),
        ...(input.allowFullAccess === true ? { allowFullAccess: true } : {}),
        operation: context.action.operation,
        ...(context.action.settings === undefined ? {} : { settings: context.action.settings }),
        ...(input.onAcceptedTextTurn === undefined ? {} : { onAcceptedTextTurn: input.onAcceptedTextTurn }),
        ...(input.onRuntimeFailure === undefined ? {} : { onRuntimeFailure: input.onRuntimeFailure }),
        expectedRevision: context.action.expectedRevision,
        now: input.now,
      })
  return Object.freeze({
    state: 'action-receipt' as const,
    requestId: context.requestId,
    taskId: context.taskId,
    operation: context.action.operation,
    receipt,
  })
}

/** Package-private authenticated inbound bridge; intentionally not root-exported. */
export async function dispatchEncryptedTextAction(
  input: E2eeActionBridgeInput,
): Promise<E2eeActionBridgeResult> {
  let context: OpenedTextActionContext | undefined

  try {
    await openEstablishedApplication({
      state: input.state,
      frame: input.frame,
      now: input.now,
      assertAuthorizationActive: input.assertAuthorizationActive,
      commitInbound: async request => {
        context = await commitOpenedTextAction(input, request)
      },
    })
  } catch (error) {
    if (error instanceof OpenedActionRequestError) {
      return Object.freeze({ state: 'session-closed', reason: error.reason })
    }
    throw error
  }

  if (context === undefined) {
    throw new Error('Authenticated inbound commit did not produce an action result.')
  }
  return completeOpenedTextAction(input, context)
}
