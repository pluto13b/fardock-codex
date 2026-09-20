import {
  getEstablishedSessionChannelInfo,
  type InboundFrameCommitRequest,
  type SessionAuthority,
} from '../../../packages/e2ee/src/index.ts'
import {
  encodeApplicationMessage,
  type ApplicationRequest,
} from '../../../packages/protocol/src/index.ts'
import type {
  ActionReceipt,
  PairingCreateInput,
  PairingCreateReceipt,
  RenameDeviceInput,
  RevokeDeviceInput,
} from '../../../packages/codex-serve-client/src/index.ts'

import type { ActionStateStore, StoredActionReceipt } from './action-state.ts'

const encoder = new TextEncoder()
const fingerprintDomain = encoder.encode('codex-plus/management-action/v1\0')

export type ManagementActionOperation = 'pairing.create' | 'device.rename' | 'device.revoke'

export interface ManagementActionContext {
  readonly requestId: string
  readonly requestFingerprint: string
  readonly message: Extract<ApplicationRequest, { operation: ManagementActionOperation }>
  readonly authority: SessionAuthority
}

export interface ManagementActionHandlers {
  readonly createPairing?: (
    input: PairingCreateInput,
    context: ManagementActionContext,
  ) => Promise<PairingCreateReceipt>
  readonly renameDevice?: (
    input: RenameDeviceInput,
    context: ManagementActionContext,
  ) => Promise<ActionReceipt>
  readonly revokeDevice?: (
    input: RevokeDeviceInput,
    context: ManagementActionContext,
  ) => Promise<ActionReceipt>
}

export class OpenedManagementActionError extends Error {}

function rejected(actionId: string, message: string): Extract<ActionReceipt, { state: 'rejected' }> {
  return Object.freeze({
    actionId,
    state: 'rejected' as const,
    rejection: Object.freeze({ code: 'capability-denied' as const, message }),
  })
}

function storedReceipt(receipt: ActionReceipt): StoredActionReceipt {
  if (receipt.state === 'accepted') {
    return Object.freeze({
      actionId: receipt.actionId,
      state: 'accepted' as const,
      ...(receipt.revision === undefined ? {} : { revision: receipt.revision }),
    })
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

/** Authenticated commit callback for non-task management actions. */
export async function commitOpenedManagementAction(
  input: Readonly<{
    store: ActionStateStore
    now: number
    fingerprintCanonicalRequest: (bytes: Uint8Array) => Promise<string>
  }>,
  request: Readonly<InboundFrameCommitRequest>,
): Promise<ManagementActionContext> {
  const message = request.message
  if (
    message.kind !== 'request'
    || (
      message.operation !== 'pairing.create'
      && message.operation !== 'device.rename'
      && message.operation !== 'device.revoke'
    )
    || request.requestId === undefined
    || request.taskId !== undefined
    || request.requestId !== message.params.actionId
  ) {
    throw new OpenedManagementActionError()
  }
  const canonical = encoder.encode(encodeApplicationMessage(message))
  const fingerprintInput = new Uint8Array(fingerprintDomain.byteLength + canonical.byteLength)
  fingerprintInput.set(fingerprintDomain)
  fingerprintInput.set(canonical, fingerprintDomain.byteLength)
  const requestFingerprint = await input.fingerprintCanonicalRequest(fingerprintInput)
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
  return Object.freeze({
    requestId: request.requestId,
    requestFingerprint,
    message,
    authority: request.authority,
  })
}

export async function completeOpenedManagementAction(
  input: Readonly<{
    state: Parameters<typeof getEstablishedSessionChannelInfo>[0]
    handlers?: ManagementActionHandlers
  }>,
  context: ManagementActionContext,
): Promise<
  | Readonly<{ state: 'pairing-create-receipt'; requestId: string; receipt: PairingCreateReceipt }>
  | Readonly<{
      state: 'action-receipt'
      requestId: string
      operation: 'device.rename' | 'device.revoke'
      receipt: StoredActionReceipt
    }>
> {
  const info = getEstablishedSessionChannelInfo(input.state)
  if (
    info.role !== 'host'
    || info.authority.hostId !== context.authority.hostId
    || info.authority.clientDeviceId !== context.authority.clientDeviceId
    || info.authority.authorizationId !== context.authority.authorizationId
    || info.authority.authorizationEpoch !== context.authority.authorizationEpoch
    || info.authority.connectionGeneration !== context.authority.connectionGeneration
  ) {
    throw new OpenedManagementActionError()
  }
  const message = context.message
  if (message.operation === 'pairing.create') {
    let receipt: PairingCreateReceipt
    try {
      receipt = input.handlers?.createPairing === undefined
        ? rejected(message.params.actionId, 'Pairing creation is unavailable.')
        : await input.handlers.createPairing(message.params, context)
    } catch {
      receipt = Object.freeze({ actionId: message.params.actionId, state: 'queued' as const })
    }
    return Object.freeze({ state: 'pairing-create-receipt', requestId: context.requestId, receipt })
  }

  let receipt: ActionReceipt
  if (
    message.operation === 'device.revoke'
    && message.params.deviceId === context.authority.clientDeviceId
  ) {
    receipt = rejected(message.params.actionId, 'The current remote device cannot revoke itself.')
  } else {
    try {
      if (message.operation === 'device.rename') {
        receipt = input.handlers?.renameDevice === undefined
          ? rejected(message.params.actionId, 'The device action is unavailable.')
          : await input.handlers.renameDevice(message.params, context)
      } else {
        receipt = input.handlers?.revokeDevice === undefined
          ? rejected(message.params.actionId, 'The device action is unavailable.')
          : await input.handlers.revokeDevice(message.params, context)
      }
    } catch {
      receipt = Object.freeze({ actionId: message.params.actionId, state: 'queued' as const })
    }
  }
  return Object.freeze({
    state: 'action-receipt',
    requestId: context.requestId,
    operation: message.operation,
    receipt: storedReceipt(receipt),
  })
}
