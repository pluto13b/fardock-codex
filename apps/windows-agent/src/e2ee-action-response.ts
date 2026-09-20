import {
  getEstablishedSessionChannelInfo,
  sealEstablishedApplication,
  type AssertSessionAuthorizationActive,
  type EstablishedSessionChannel,
  type OutboundFrameCommitRequest,
  type OutboundSequenceReservationRequest,
  type SessionAuthority,
} from '../../../packages/e2ee/src/index.ts'
import {
  ApplicationResponseSchema,
  PROTOCOL_VERSION,
  ProtocolViolation,
} from '../../../packages/protocol/src/index.ts'

import {
  type ActionStateStore,
  type StoredActionReceipt,
} from './action-state.ts'
import type { PairingCreateReceipt, StartTaskReceipt } from '../../../packages/codex-serve-client/src/index.ts'

const ACTION_RESPONSE_TTL_MS = 30_000

export interface ActionReceiptContext {
  readonly state: 'action-receipt'
  readonly requestId: string
  readonly taskId?: string
  readonly operation: 'device.rename' | 'device.revoke' | 'turn.send' | 'turn.steer' | 'turn.interrupt' | 'request.resolve'
  readonly receipt: StoredActionReceipt
}

export interface PairingCreateReceiptContext {
  readonly state: 'pairing-create-receipt'
  readonly requestId: string
  readonly receipt: PairingCreateReceipt
}

export interface StartTaskReceiptContext {
  readonly state: 'start-task-receipt'
  readonly requestId: string
  readonly receipt: StartTaskReceipt
}

export interface EncryptedActionResponse {
  readonly state: 'encrypted-response'
  readonly operation: 'pairing.create' | 'device.rename' | 'device.revoke' | 'turn.send' | 'turn.steer' | 'turn.interrupt' | 'request.resolve' | 'task.start'
  readonly requestId: string
  readonly taskId?: string
  readonly wireText: string
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

function protocolActionResponse(context: ActionReceiptContext | PairingCreateReceiptContext | StartTaskReceiptContext): unknown {
  if (context.state === 'start-task-receipt') {
    return ApplicationResponseSchema.parse({
      kind: 'response', operation: 'task.start', ok: true, result: context.receipt,
    })
  }
  if (context.state === 'pairing-create-receipt') {
    return ApplicationResponseSchema.parse({
      kind: 'response', operation: 'pairing.create', ok: true, result: context.receipt,
    })
  }
  const stored = context.receipt
  const result = stored.state === 'accepted'
    ? {
        actionId: stored.actionId,
        state: 'accepted' as const,
        ...(stored.revision === undefined ? {} : { revision: stored.revision }),
      }
    : stored.state === 'rejected'
      ? {
          actionId: stored.actionId,
          state: 'rejected' as const,
          rejection: {
            code: stored.rejection.code,
            message: stored.rejection.message,
          },
        }
      : {
          actionId: stored.actionId,
          state: 'queued' as const,
        }

  return ApplicationResponseSchema.parse({
    kind: 'response',
    operation: context.operation,
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ok: true,
    result,
  })
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

/** Package-private outbound boundary; intentionally not root-exported. */
export async function sealEncryptedActionReceipt(input: {
  readonly state: EstablishedSessionChannel
  readonly context: ActionReceiptContext | PairingCreateReceiptContext | StartTaskReceiptContext
  readonly now: number
  readonly store: ActionStateStore
  readonly assertAuthorizationActive: AssertSessionAuthorizationActive
}): Promise<EncryptedActionResponse> {
  const info = getEstablishedSessionChannelInfo(input.state)
  if (info.role !== 'host') throw new ProtocolViolation('stale-authority')

  const context = Object.freeze({ ...input.context })
  const message = protocolActionResponse(context)
  const taskId = context.state === 'start-task-receipt'
    && context.receipt.state === 'accepted'
    && context.receipt.task !== undefined
    ? context.receipt.task.id
    : context.state === 'action-receipt' ? context.taskId : undefined
  const channelIdentity = Object.freeze({
    hostId: info.authority.hostId,
    authorizationId: info.authority.authorizationId,
    authorizationEpoch: info.authority.authorizationEpoch,
    connectionGeneration: info.authority.connectionGeneration,
    inboundKeyId: info.inboundKeyId,
  })
  const expected = Object.freeze({
    authority: info.authority,
    outboundKeyId: info.outboundKeyId,
    requestId: context.requestId,
    taskId,
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
      ...(taskId === undefined ? {} : { taskId }),
      sentAt: input.now,
      expiresAt: input.now + ACTION_RESPONSE_TTL_MS,
      messageType: 'response',
    },
    message,
    now: input.now,
    assertAuthorizationActive: input.assertAuthorizationActive,
    persistence: {
      reserveSequence: async request => {
        requireReservation(request, expected)
        const channel = input.store.getChannelState(channelIdentity)
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
          authority: expected.authority,
          outboundKeyId: expected.outboundKeyId,
          sequence: reservedSequence,
        })
        input.store.commitOutboundFrame({
          ...channelIdentity,
          outboundKeyId: info.outboundKeyId,
          sequence: reservedSequence,
          encryptedWireText: request.wireText,
        })
      },
    },
  })

  return Object.freeze({
    state: 'encrypted-response' as const,
    operation: context.state === 'start-task-receipt'
      ? 'task.start' as const
      : context.state === 'pairing-create-receipt' ? 'pairing.create' as const : context.operation,
    requestId: context.requestId,
    ...(taskId === undefined ? {} : { taskId }),
    wireText: sealed.wireText,
  })
}
