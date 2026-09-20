import { VisibleDeadlines } from './visible-deadlines.ts'
import type {
  CodexServeTransport,
  CodexServeTransportResult,
  CodexServeTransportStreamRequest,
  CodexServeTransportUnaryRequest,
} from '@codex-plus/serve-client'
import {
  getEstablishedSessionChannelInfo,
  invalidateEstablishedSession,
  openEstablishedApplication,
  sealEstablishedApplication,
  type AssertSessionAuthorizationActive,
  type CommitInboundFrame,
  type EstablishedSessionChannel,
  type OutboundFramePersistenceAdapter,
} from '@codex-plus/e2ee'
import {
  MAX_ENVELOPE_TTL_MS,
  PROTOCOL_VERSION,
  type ApplicationRequest,
  type ApplicationResponse,
  type EnvelopeHeader,
  type RelayReceipt,
} from '@codex-plus/protocol'

const DEFAULT_ENVELOPE_TTL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_PENDING_REQUESTS = 16
const MAX_RECORDED_RECEIPTS = 128
const MAX_INBOUND_QUEUE_FRAMES = 16
const MAX_INBOUND_QUEUE_BYTES = 8 * 1024 * 1024
const textEncoder = new TextEncoder()

type RawEnvelope = string | Uint8Array
type SupportedOperation =
  | 'model.list'
  | 'manage.read'
  | 'pairing.create'
  | 'device.rename'
  | 'device.revoke'
  | 'workspace.list'
  | 'task.list'
  | 'task.read'
  | 'task.start'
  | 'turn.send'
  | 'turn.steer'
  | 'turn.interrupt'
  | 'request.resolve'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

interface PendingRequest extends Deferred<CodexServeTransportResult> {
  readonly requestId: string
  readonly operation: SupportedOperation
  readonly taskId?: string
  readonly actionId?: string
  readonly timer: { cancel(): void }
  phase: 'queued' | 'sealing' | 'sent'
}

interface PreparedRequest {
  readonly requestId: string
  readonly operation: SupportedOperation
  readonly taskId?: string
  readonly actionId?: string
  readonly message: ApplicationRequest
}

/**
 * Authenticated Relay I/O only. Pairing and socket authentication deliberately
 * stay outside this transport.
 */
export interface RelayEnvelopeCarrier {
  sendEnvelope(frame: RawEnvelope): Promise<RelayReceipt>
  subscribe(
    listener: (frame: RawEnvelope) => void | Promise<void>,
  ): () => void
}

export interface RelayCodexServeTransportOptions {
  readonly channel: EstablishedSessionChannel
  readonly carrier: RelayEnvelopeCarrier
  readonly assertAuthorizationActive: AssertSessionAuthorizationActive
  readonly outboundPersistence: OutboundFramePersistenceAdapter
  readonly commitInbound: CommitInboundFrame
  readonly now?: () => number
  readonly createRequestId?: () => string
  readonly envelopeTtlMs?: number
  readonly requestTimeoutMs?: number
  readonly onRelayReceipt?: (receipt: Readonly<RelayReceipt>) => void
}

export type RelayCodexServeTransportErrorCode =
  | 'invalid-options'
  | 'unsupported-operation'
  | 'duplicate-request'
  | 'capacity-exceeded'
  | 'request-timeout'
  | 'outcome-unknown'
  | 'relay-unavailable'
  | 'remote-rejected'
  | 'response-mismatch'
  | 'closed'
  | 'page-suspended'

export class RelayCodexServeTransportError extends Error {
  constructor(
    readonly code: RelayCodexServeTransportErrorCode,
    readonly remoteCode?: string,
  ) {
    super(`Relay Codex Serve transport failed: ${code}.`)
    this.name = 'RelayCodexServeTransportError'
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function requireDuration(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RelayCodexServeTransportError('invalid-options')
  }
  return resolved
}

function defaultRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new RelayCodexServeTransportError('invalid-options')
  }
  return `web.${globalThis.crypto.randomUUID()}`
}

function prepareRequest(
  request: CodexServeTransportUnaryRequest,
  createRequestId: () => string,
): PreparedRequest {
  switch (request.operation) {
    case 'model.list':
    case 'manage.read':
    case 'workspace.list': {
      return {
        operation: request.operation,
        requestId: createRequestId(),
        message: { kind: 'request', operation: request.operation, params: {} },
      }
    }
    case 'pairing.create': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        actionId: request.input.actionId,
        message: { kind: 'request', operation: request.operation, params: request.input },
      }
    }
    case 'device.rename': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        actionId: request.input.actionId,
        message: { kind: 'request', operation: request.operation, params: request.input },
      }
    }
    case 'device.revoke': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        actionId: request.input.actionId,
        message: { kind: 'request', operation: request.operation, params: request.input },
      }
    }
    case 'task.list': {
      return {
        operation: request.operation,
        requestId: createRequestId(),
        message: {
          kind: 'request',
          operation: request.operation,
          params: request.cursor === undefined ? {} : { cursor: request.cursor },
        },
      }
    }
    case 'task.read': {
      return {
        operation: request.operation,
        requestId: createRequestId(),
        taskId: request.taskId,
        message: {
          kind: 'request',
          operation: request.operation,
          params: { taskId: request.taskId },
        },
      }
    }
    case 'task.start': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        actionId: request.input.actionId,
        message: { kind: 'request', operation: request.operation, params: request.input },
      }
    }
    case 'turn.send': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        taskId: request.taskId,
        actionId: request.input.actionId,
        message: {
          kind: 'request',
          operation: request.operation,
          params: { taskId: request.taskId, input: request.input },
        },
      }
    }
    case 'turn.steer': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        taskId: request.taskId,
        actionId: request.input.actionId,
        message: {
          kind: 'request',
          operation: request.operation,
          params: { taskId: request.taskId, input: request.input },
        },
      }
    }
    case 'turn.interrupt': {
      return {
        operation: request.operation,
        requestId: request.input.actionId,
        taskId: request.taskId,
        actionId: request.input.actionId,
        message: {
          kind: 'request',
          operation: request.operation,
          params: { taskId: request.taskId, input: request.input },
        },
      }
    }
    case 'request.resolve': {
      return {
        operation: request.operation,
        requestId: request.request.actionId,
        taskId: request.request.taskId,
        actionId: request.request.actionId,
        message: { kind: 'request', operation: request.operation, params: request.request },
      }
    }
    default:
      throw new RelayCodexServeTransportError('unsupported-operation')
  }
}

function successfulResult(
  response: Extract<ApplicationResponse, { ok: true }>,
): CodexServeTransportResult {
  switch (response.operation) {
    case 'model.list':
      return { operation: response.operation, value: response.result }
    case 'manage.read':
      return { operation: response.operation, value: response.result }
    case 'pairing.create':
      return { operation: response.operation, value: response.result }
    case 'device.rename':
      return { operation: response.operation, value: response.result }
    case 'device.revoke':
      return { operation: response.operation, value: response.result }
    case 'workspace.list':
      return { operation: response.operation, value: response.result }
    case 'task.list':
      return { operation: response.operation, value: response.result }
    case 'task.read':
      return {
        operation: response.operation,
        taskId: response.taskId,
        value: response.result,
      }
    case 'task.start':
      return { operation: response.operation, value: response.result }
    case 'turn.send':
    case 'turn.steer':
    case 'turn.interrupt':
    case 'request.resolve':
      return {
        operation: response.operation,
        taskId: response.taskId,
        value: response.result,
      }
    default:
      throw new RelayCodexServeTransportError('response-mismatch')
  }
}

export class RelayCodexServeTransport implements CodexServeTransport {
  private readonly failureListeners = new Set<(error: Error) => void>()

  onUnexpectedDisconnect(listener: (error: Error) => void): () => void {
    this.requireOpen()
    this.failureListeners.add(listener)
    return () => { this.failureListeners.delete(listener) }
  }
  private readonly channel: EstablishedSessionChannel
  private carrier: RelayEnvelopeCarrier
  private readonly assertAuthorizationActive: AssertSessionAuthorizationActive
  private readonly outboundPersistence: OutboundFramePersistenceAdapter
  private readonly commitInbound: CommitInboundFrame
  private readonly now: () => number
  private readonly createRequestId: () => string
  private readonly envelopeTtlMs: number
  private readonly requestTimeoutMs: number
  private readonly onRelayReceipt?: (receipt: Readonly<RelayReceipt>) => void
  private readonly pending = new Map<string, PendingRequest>()
  private readonly receipts = new Map<string, RelayReceipt>()
  private sealTail: Promise<void> = Promise.resolve()
  private inboundTail: Promise<void> = Promise.resolve()
  private inboundQueueFrames = 0
  private inboundQueueBytes = 0
  private unsubscribe: (() => void) | undefined
  private readonly deadlines = new VisibleDeadlines()
  private paused = false
  private closed = false

  constructor(options: RelayCodexServeTransportOptions) {
    const info = getEstablishedSessionChannelInfo(options.channel)
    if (info.role !== 'client') {
      throw new RelayCodexServeTransportError('invalid-options')
    }
    if (
      typeof options.carrier?.sendEnvelope !== 'function'
      || typeof options.carrier?.subscribe !== 'function'
      || typeof options.assertAuthorizationActive !== 'function'
      || typeof options.outboundPersistence?.reserveSequence !== 'function'
      || typeof options.outboundPersistence?.commitFrame !== 'function'
      || typeof options.commitInbound !== 'function'
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.createRequestId !== undefined && typeof options.createRequestId !== 'function')
      || (options.onRelayReceipt !== undefined && typeof options.onRelayReceipt !== 'function')
    ) {
      throw new RelayCodexServeTransportError('invalid-options')
    }

    this.channel = options.channel
    this.carrier = options.carrier
    this.assertAuthorizationActive = options.assertAuthorizationActive
    this.outboundPersistence = options.outboundPersistence
    this.commitInbound = options.commitInbound
    this.now = options.now ?? Date.now
    this.createRequestId = options.createRequestId ?? defaultRequestId
    this.envelopeTtlMs = requireDuration(
      options.envelopeTtlMs,
      DEFAULT_ENVELOPE_TTL_MS,
      MAX_ENVELOPE_TTL_MS,
    )
    this.requestTimeoutMs = requireDuration(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_ENVELOPE_TTL_MS,
    )
    this.onRelayReceipt = options.onRelayReceipt
    this.unsubscribe = this.carrier.subscribe(frame => this.enqueueInbound(frame))
  }

  setPageVisible(visible: boolean): void { this.paused = !visible; this.deadlines.setActive(visible) }
  canResume(): boolean {
    if (this.closed || this.pending.size !== 0 || this.inboundQueueFrames !== 0) return false
    try {
      const state = getEstablishedSessionChannelInfo(this.channel).sequenceState
      return state.lastPeerAck === state.maxSentSequence
    } catch { return false }
  }
  replaceCarrier(carrier: RelayEnvelopeCarrier): void {
    if (!this.canResume()) throw new RelayCodexServeTransportError('closed')
    this.unsubscribe?.()
    this.carrier = carrier
    this.unsubscribe = carrier.subscribe(frame => this.enqueueInbound(frame))
  }

  async request(
    request: CodexServeTransportUnaryRequest,
  ): Promise<CodexServeTransportResult> {
    this.requireOpen()
    if (this.paused && request.operation !== 'workspace.list') throw new RelayCodexServeTransportError('page-suspended')
    const prepared = prepareRequest(request, this.createRequestId)
    if (this.pending.has(prepared.requestId)) {
      throw new RelayCodexServeTransportError('duplicate-request')
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new RelayCodexServeTransportError('capacity-exceeded')
    }

    const operation = deferred<CodexServeTransportResult>()
    const timer = this.deadlines.after(this.requestTimeoutMs, () => {
      const pending = this.pending.get(prepared.requestId)
      if (pending === undefined) return
      if (pending.phase !== 'queued') {
        this.failClosed(new RelayCodexServeTransportError(
          pending.actionId !== undefined ? 'outcome-unknown' : 'request-timeout',
        ))
        return
      }
      this.pending.delete(prepared.requestId)
      pending.reject(new RelayCodexServeTransportError('request-timeout'))
    })
    const pending: PendingRequest = {
      ...operation,
      requestId: prepared.requestId,
      operation: prepared.operation,
      ...(prepared.taskId === undefined ? {} : { taskId: prepared.taskId }),
      ...(prepared.actionId === undefined ? {} : { actionId: prepared.actionId }),
      timer,
      phase: 'queued',
    }
    this.pending.set(prepared.requestId, pending)
    void this.dispatch(prepared, pending).catch(error => {
      this.failClosed(this.asError(error))
    })
    return await operation.promise
  }

  async *stream(
    _request: CodexServeTransportStreamRequest,
  ): AsyncIterable<CodexServeTransportResult> {
    throw new RelayCodexServeTransportError('unsupported-operation')
  }

  relayReceipt(requestId: string): Readonly<RelayReceipt> | undefined {
    return this.receipts.get(requestId)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failureListeners.clear()
    this.unsubscribe?.()
    this.unsubscribe = undefined
    try {
      invalidateEstablishedSession(this.channel)
    } catch {
      // A protocol failure may already have invalidated the opaque channel.
    }
    const error = new RelayCodexServeTransportError('closed')
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error)
  }

  private async dispatch(prepared: PreparedRequest, pending: PendingRequest): Promise<void> {
    const sealed = await this.withSealLock(async () => {
      if (this.pending.get(prepared.requestId) !== pending) return undefined
      this.requireOpen()
      pending.phase = 'sealing'
      const info = getEstablishedSessionChannelInfo(this.channel)
      const sentAt = this.now()
      const header: Omit<EnvelopeHeader, 'seq' | 'ack'> = {
        protocolVersion: PROTOCOL_VERSION,
        connectionGeneration: info.authority.connectionGeneration,
        fromDeviceId: info.authority.clientDeviceId,
        toDeviceId: info.authority.hostDeviceId,
        hostId: info.authority.hostId,
        keyId: info.outboundKeyId,
        requestId: prepared.requestId,
        ...(prepared.taskId === undefined ? {} : { taskId: prepared.taskId }),
        sentAt,
        expiresAt: sentAt + this.envelopeTtlMs,
        messageType: 'request',
      }
      return await sealEstablishedApplication({
        state: this.channel,
        header,
        message: prepared.message,
        now: sentAt,
        assertAuthorizationActive: this.assertAuthorizationActive,
        persistence: this.outboundPersistence,
      })
    })
    if (sealed === undefined || this.closed) return

    pending.phase = 'sent'
    const receipt = await this.carrier.sendEnvelope(sealed.wireText)
    if (
      receipt.connectionGeneration !== sealed.envelope.connectionGeneration
      || receipt.requestId !== sealed.envelope.requestId
      || receipt.seq !== sealed.envelope.seq
    ) {
      this.failClosed(new RelayCodexServeTransportError('response-mismatch'))
      return
    }
    if (!this.receipts.has(receipt.requestId) && this.receipts.size >= MAX_RECORDED_RECEIPTS) {
      const oldest = this.receipts.keys().next().value as string | undefined
      if (oldest !== undefined) this.receipts.delete(oldest)
    }
    this.receipts.set(receipt.requestId, receipt)
    try {
      this.onRelayReceipt?.(receipt)
    } catch {
      // A presentation callback cannot alter authenticated transport state.
    }
    if (receipt.state !== 'relayed') {
      this.failClosed(new RelayCodexServeTransportError('relay-unavailable', receipt.code))
    }
  }

  private withSealLock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.sealTail
    const next = prior.then(operation, operation)
    this.sealTail = next.then(() => undefined, () => undefined)
    return next
  }

  private enqueueInbound(frame: RawEnvelope): Promise<void> {
    if (this.closed) return Promise.resolve()
    const ownedFrame = typeof frame === 'string' ? frame : new Uint8Array(frame)
    const byteLength = typeof ownedFrame === 'string'
      ? textEncoder.encode(ownedFrame).byteLength
      : ownedFrame.byteLength
    if (
      this.inboundQueueFrames >= MAX_INBOUND_QUEUE_FRAMES
      || this.inboundQueueBytes + byteLength > MAX_INBOUND_QUEUE_BYTES
    ) {
      this.failClosed(new RelayCodexServeTransportError('response-mismatch'))
      return Promise.resolve()
    }
    this.inboundQueueFrames += 1
    this.inboundQueueBytes += byteLength
    const next = this.inboundTail.then(async () => {
      if (this.closed) return
      await this.handleInbound(ownedFrame)
    }).finally(() => {
      this.inboundQueueFrames -= 1
      this.inboundQueueBytes -= byteLength
    })
    this.inboundTail = next.catch(error => {
      this.failClosed(this.asError(error))
    })
    return this.inboundTail
  }

  private async handleInbound(frame: RawEnvelope): Promise<void> {
    const opened = await openEstablishedApplication({
      state: this.channel,
      frame,
      now: this.now(),
      assertAuthorizationActive: this.assertAuthorizationActive,
      commitInbound: this.commitInbound,
    })
    if (opened.message.kind !== 'response') {
      throw new RelayCodexServeTransportError('response-mismatch')
    }

    const response = opened.message
    const pending = this.pending.get(opened.envelope.requestId)
    if (pending === undefined || response.operation !== pending.operation) {
      throw new RelayCodexServeTransportError('response-mismatch')
    }
    const responseTaskId = 'taskId' in response ? response.taskId : undefined
    if (pending.operation === 'task.start') {
      const createdTaskId = response.operation === 'task.start' && response.ok && response.result.state === 'accepted' ? response.result.task?.id : undefined
      if (responseTaskId !== undefined || opened.envelope.taskId !== createdTaskId) {
        throw new RelayCodexServeTransportError('response-mismatch')
      }
    } else if (responseTaskId !== pending.taskId || opened.envelope.taskId !== pending.taskId) {
      throw new RelayCodexServeTransportError('response-mismatch')
    }
    if (
      pending.actionId !== undefined
      && (
        (
          response.operation !== 'pairing.create'
          && response.operation !== 'device.rename'
          && response.operation !== 'device.revoke'
          && response.operation !== 'turn.send'
          && response.operation !== 'turn.steer'
          && response.operation !== 'turn.interrupt'
          && response.operation !== 'request.resolve'
          && response.operation !== 'task.start'
        )
        || (response.ok && response.result.actionId !== pending.actionId)
      )
    ) {
      throw new RelayCodexServeTransportError('response-mismatch')
    }

    if (!response.ok) {
      this.rejectPending(
        pending.requestId,
        new RelayCodexServeTransportError('remote-rejected', response.error.code),
      )
      return
    }
    const result = successfulResult(response)
    this.pending.delete(pending.requestId)
    pending.timer.cancel()
    pending.resolve(result)
  }

  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    pending.timer.cancel()
    pending.reject(error)
  }

  private failClosed(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    try {
      invalidateEstablishedSession(this.channel)
    } catch {
      // openEstablishedApplication invalidates on cryptographic/protocol failure.
    }
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, error)
    const listeners = [...this.failureListeners]
    this.failureListeners.clear()
    for (const listener of listeners) {
      try { listener(error) } catch { /* observers do not change authority */ }
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new RelayCodexServeTransportError('closed')
  }

  private asError(error: unknown): Error {
    return error instanceof Error
      ? error
      : new RelayCodexServeTransportError('closed')
  }
}

export function createRelayCodexServeTransport(
  options: RelayCodexServeTransportOptions,
): RelayCodexServeTransport {
  return new RelayCodexServeTransport(options)
}
