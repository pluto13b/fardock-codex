import type {
  ActionReceipt,
  ApprovalDecision,
  CodexServeClient,
  HostConnection,
  InterruptTurnInput,
  ManagementSnapshot,
  PairingCreateInput,
  PairingCreateReceipt,
  QuestionAnswer,
  RenameDeviceInput,
  RevokeDeviceInput,
  SendTurnInput,
  StartTaskInput,
  StartTaskReceipt,
  SteerTurnInput,
  TaskEvent,
  TaskPage,
  TaskSnapshot,
  WorkspaceSummary,
} from '@codex-plus/serve-client'
import * as z from 'zod'

import { decodeBase64Url } from './base64url.ts'
import { decodeCanonicalJson, encodeCanonicalJson } from './codec.ts'
import { protocolErrorCodes, ProtocolViolation } from './errors.ts'
import { Hash32Schema } from './pairing.ts'
import { SessionConfirmControlSchema, SessionReadyControlSchema } from './session.ts'
import {
  CursorSchema,
  Base64UrlSchema,
  MAX_APPLICATION_BYTES,
  OpaqueIdentifierSchema,
  PositiveSafeIntegerSchema,
  SafeIntegerSchema,
  type EnvelopeMessageType,
  type RoutedEnvelope,
} from './schemas.ts'

const shortText = z.string().max(256)
const detailText = z.string().max(16 * 1024)
const largeText = z.string().max(256 * 1024)
const isoTimestamp = z.string().datetime({ offset: true })
const textEncoder = new TextEncoder()
export const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1024
export const MAX_INLINE_ATTACHMENT_TOTAL_BYTES = 256 * 1024
const MAX_INLINE_ATTACHMENT_CHARACTERS = Math.ceil(MAX_INLINE_ATTACHMENT_BYTES * 4 / 3) + 4
const inlineAttachmentData = Base64UrlSchema.max(MAX_INLINE_ATTACHMENT_CHARACTERS).refine(
  value => (decodeBase64Url(value)?.byteLength ?? Number.POSITIVE_INFINITY) <= MAX_INLINE_ATTACHMENT_BYTES,
)

export const HostConnectionSchema = z.strictObject({
  hostId: OpaqueIdentifierSchema,
  generation: PositiveSafeIntegerSchema,
  state: z.enum(['online', 'reconnecting', 'offline']),
})

export const ManagementLayersSchema = z.strictObject({
  gateway: z.literal('healthy'),
  relaySocket: z.literal('authenticated'),
  host: z.literal('online'),
  e2ee: z.literal('ready'),
  companion: z.literal('online'),
  appServer: z.enum(['compatible', 'read-only', 'unavailable']),
})

export const ManagedDeviceSchema = z.strictObject({
  deviceId: OpaqueIdentifierSchema,
  displayName: z.string().min(1).max(80),
  shortId: z.string().min(1).max(32).regex(/^[A-Za-z0-9._~-]+$/),
  signingFingerprint: Hash32Schema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
  status: z.enum(['active', 'revoked']),
  presence: z.enum(['online', 'offline', 'unknown']),
  pairedAt: SafeIntegerSchema,
  lastSeenAt: SafeIntegerSchema.nullable(),
  isCurrent: z.boolean(),
})

const managementEventCommon = {
  eventId: OpaqueIdentifierSchema,
  occurredAt: SafeIntegerSchema,
}

export const ManagementEventSchema = z.discriminatedUnion('category', [
  z.strictObject({ ...managementEventCommon, category: z.literal('gateway'), state: z.literal('healthy') }),
  z.strictObject({ ...managementEventCommon, category: z.literal('relay'), state: z.literal('authenticated') }),
  z.strictObject({ ...managementEventCommon, category: z.literal('host'), state: z.literal('online') }),
  z.strictObject({ ...managementEventCommon, category: z.literal('e2ee'), state: z.literal('ready') }),
  z.strictObject({ ...managementEventCommon, category: z.literal('companion'), state: z.literal('online') }),
  z.strictObject({
    ...managementEventCommon,
    category: z.literal('app-server'),
    state: z.enum(['compatible', 'read-only', 'unavailable']),
  }),
  z.strictObject({ ...managementEventCommon, category: z.literal('device'), state: z.literal('authenticated') }),
])

export const ManagementSnapshotSchema = z.strictObject({
  generatedAt: SafeIntegerSchema,
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  layers: ManagementLayersSchema,
  devices: z.array(ManagedDeviceSchema).max(64),
  events: z.array(ManagementEventSchema).max(64),
}).superRefine((snapshot, context) => {
  const current = snapshot.devices.filter(device => device.isCurrent)
  if (
    current.length !== 1
    || current[0]?.status !== 'active'
    || current[0]?.presence !== 'online'
  ) {
    context.addIssue({ code: 'custom', path: ['devices'], message: 'Current device authority is ambiguous.' })
  }
  if (
    new Set(snapshot.devices.map(device => device.deviceId)).size !== snapshot.devices.length
    || new Set(snapshot.devices.map(device => device.authorizationId)).size !== snapshot.devices.length
  ) {
    context.addIssue({ code: 'custom', path: ['devices'], message: 'Management device authority is duplicated.' })
  }
})

export const WorkspaceSummarySchema = z.strictObject({
  id: OpaqueIdentifierSchema,
  name: shortText,
  pathLabel: z.string().max(1024),
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  connection: z.enum(['online', 'reconnecting', 'offline']),
  capabilities: z.strictObject({ startTask: z.boolean() }),
})

export const TaskSummarySchema = z.strictObject({
  id: OpaqueIdentifierSchema,
  workspaceId: OpaqueIdentifierSchema,
  title: shortText,
  status: z.enum([
    'syncing',
    'running',
    'waiting-approval',
    'completed',
    'failed',
    'unknown',
    'offline',
  ]),
  updatedAt: z.string().min(1).max(128),
  revision: SafeIntegerSchema,
  activeTurnId: OpaqueIdentifierSchema.optional(),
  completionReason: z.enum(['completed', 'interrupted', 'denied', 'failed']).optional(),
})

export const TaskCapabilitiesSchema = z.strictObject({
  sendTurn: z.boolean(),
  steerTurn: z.boolean(),
  interruptTurn: z.boolean(),
  resolveApproval: z.boolean(),
  answerQuestion: z.boolean(),
})

export const UserInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().max(128 * 1024) }),
  z.strictObject({
    type: z.literal('localImage'),
    attachmentId: OpaqueIdentifierSchema,
    name: shortText,
  }),
  z.strictObject({
    type: z.literal('file'),
    attachmentId: OpaqueIdentifierSchema,
    name: shortText,
  }),
])

export const InlineAttachmentSchema = z.strictObject({
  attachmentId: OpaqueIdentifierSchema,
  name: shortText,
  mediaType: shortText.min(1),
  byteLength: SafeIntegerSchema,
  contentBase64Url: inlineAttachmentData,
}).superRefine((attachment, context) => {
  const decoded = decodeBase64Url(attachment.contentBase64Url)
  if (attachment.byteLength < 1 || decoded?.byteLength !== attachment.byteLength) {
    context.addIssue({ code: 'custom', message: 'Inline attachment byte length is invalid.' })
  }
})

export const TurnSettingsSchema = z.strictObject({
  model: shortText.min(1),
  effort: z.string().min(1).max(32).regex(/^[a-z][a-z0-9-]*$/),
  permission: z.enum(['ask', 'read-only', 'full-access']),
})

export const ExpectedHostStateSchema = z.strictObject({
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
})

export const ExpectedTaskStateSchema = z.strictObject({
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  revision: SafeIntegerSchema,
})

export const ModelOptionSchema = z.strictObject({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  displayName: z.string().min(1).max(128),
  defaultReasoningEffort: TurnSettingsSchema.shape.effort,
  supportedReasoningEfforts: z.array(TurnSettingsSchema.shape.effort).min(1).max(16),
  isDefault: z.boolean(),
}).refine(model => model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
  && new Set(model.supportedReasoningEfforts).size === model.supportedReasoningEfforts.length)
export const ModelCatalogSchema = z.array(ModelOptionSchema).min(1).max(128)
  .refine(models => new Set(models.map(model => model.id)).size === models.length)

const actionId = OpaqueIdentifierSchema

export const PairingCreateInputSchema = z.strictObject({
  actionId,
  expected: ExpectedHostStateSchema,
})

const managedDeviceTarget = {
  deviceId: OpaqueIdentifierSchema,
  authorizationId: OpaqueIdentifierSchema,
  authorizationEpoch: PositiveSafeIntegerSchema,
}

export const RenameDeviceInputSchema = z.strictObject({
  actionId,
  ...managedDeviceTarget,
  displayName: z.string().min(1).max(80).refine(value => (
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
  )),
  expected: ExpectedHostStateSchema,
})

export const RevokeDeviceInputSchema = z.strictObject({
  actionId,
  ...managedDeviceTarget,
  expected: ExpectedHostStateSchema,
})

const userInputs = z.array(UserInputSchema).min(1).max(16)
const inlineAttachments = z.array(InlineAttachmentSchema).max(4)

function validateAttachmentBindings(
  value: Readonly<{
    input: z.infer<typeof userInputs>
    attachments?: z.infer<typeof inlineAttachments>
  }>,
  context: z.RefinementCtx,
): void {
  const attachments = value.attachments ?? []
  let total = 0
  let textTotal = 0
  const byId = new Map<string, (typeof attachments)[number]>()
  for (const attachment of attachments) {
    total += attachment.byteLength
    if (byId.has(attachment.attachmentId)) {
      context.addIssue({ code: 'custom', message: 'Duplicate inline attachment id.' })
    }
    byId.set(attachment.attachmentId, attachment)
  }
  if (total > MAX_INLINE_ATTACHMENT_TOTAL_BYTES) {
    context.addIssue({ code: 'custom', message: 'Inline attachment batch exceeds its byte limit.' })
  }
  for (const input of value.input) if (input.type === 'text') textTotal += textEncoder.encode(input.text).byteLength
  if (textTotal > 128 * 1024) {
    context.addIssue({ code: 'custom', message: 'Turn text exceeds its aggregate byte limit.' })
  }
  const refs = value.input.filter((input): input is Exclude<(typeof value.input)[number], { type: 'text' }> => input.type !== 'text')
  if (refs.length !== attachments.length) {
    context.addIssue({ code: 'custom', message: 'Inline attachment references do not match their sidecar.' })
    return
  }
  for (const ref of refs) {
    const attachment = byId.get(ref.attachmentId)
    if (
      attachment === undefined
      || attachment.name !== ref.name
      || (ref.type === 'localImage' && !['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mediaType))
    ) {
      context.addIssue({ code: 'custom', message: 'Inline attachment metadata does not match its input reference.' })
    }
  }
}

export const StartTaskInputSchema = z.strictObject({
  actionId,
  workspaceId: OpaqueIdentifierSchema,
  input: userInputs,
  attachments: inlineAttachments.optional(),
  settings: TurnSettingsSchema,
  expected: ExpectedHostStateSchema,
}).superRefine(validateAttachmentBindings)

export const SendTurnInputSchema = z.strictObject({
  actionId,
  input: userInputs,
  attachments: inlineAttachments.optional(),
  settings: TurnSettingsSchema,
  expected: ExpectedTaskStateSchema,
}).superRefine(validateAttachmentBindings)

export const SteerTurnInputSchema = z.strictObject({
  actionId,
  input: userInputs,
  attachments: inlineAttachments.optional(),
  expected: ExpectedTaskStateSchema,
}).superRefine(validateAttachmentBindings)

export const InterruptTurnInputSchema = z.strictObject({
  actionId,
  turnId: OpaqueIdentifierSchema,
  expected: ExpectedTaskStateSchema,
})

export const RequestAuthoritySchema = z.strictObject({
  requestId: OpaqueIdentifierSchema,
  taskId: OpaqueIdentifierSchema,
  turnId: OpaqueIdentifierSchema,
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  requestNonce: OpaqueIdentifierSchema,
  issuedAt: isoTimestamp,
  expiresAt: isoTimestamp,
})

const requestResolutionBase = {
  requestId: OpaqueIdentifierSchema,
  taskId: OpaqueIdentifierSchema,
  turnId: OpaqueIdentifierSchema,
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  requestNonce: OpaqueIdentifierSchema,
  issuedAt: isoTimestamp,
  expiresAt: isoTimestamp,
  actionId,
  expected: ExpectedTaskStateSchema,
}

export const ApprovalDecisionSchema = z.strictObject({
  ...requestResolutionBase,
  type: z.literal('approval'),
  decision: z.enum(['approve-once', 'deny']),
})

export const QuestionAnswerSchema = z.strictObject({
  ...requestResolutionBase,
  type: z.literal('question'),
  answers: z.array(z.strictObject({
    questionId: OpaqueIdentifierSchema,
    values: z.array(z.string().max(16 * 1024)).min(1).max(64),
  })).min(1).max(32),
})

const messageBase = {
  id: OpaqueIdentifierSchema,
  createdAt: isoTimestamp.nullable(),
  turnId: OpaqueIdentifierSchema.optional(),
}

const interactiveBase = {
  id: OpaqueIdentifierSchema,
  createdAt: isoTimestamp,
  title: shortText,
  detail: detailText,
  command: largeText.optional(),
  requestId: OpaqueIdentifierSchema,
  taskId: OpaqueIdentifierSchema,
  turnId: OpaqueIdentifierSchema,
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  requestNonce: OpaqueIdentifierSchema,
  issuedAt: isoTimestamp,
  expiresAt: isoTimestamp,
}

export const TaskMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...messageBase,
    kind: z.literal('user'),
    text: z.string().max(128 * 1024),
    input: userInputs.optional(),
  }),
  z.strictObject({ ...messageBase, kind: z.literal('assistant'), markdown: largeText }),
  z.strictObject({
    ...messageBase,
    kind: z.literal('reasoning'),
    title: shortText,
    summary: detailText,
    state: z.enum(['running', 'completed']),
  }),
  z.strictObject({
    ...messageBase,
    kind: z.literal('tool'),
    title: shortText,
    summary: detailText,
    command: largeText.optional(),
    output: largeText.optional(),
    state: z.enum(['running', 'completed', 'failed']),
  }),
  z.strictObject({
    ...messageBase,
    kind: z.literal('diff'),
    files: z.array(z.strictObject({
      path: z.string().min(1).max(1024),
      additions: SafeIntegerSchema,
      deletions: SafeIntegerSchema,
    })).max(256),
  }),
  z.strictObject({
    ...interactiveBase,
    kind: z.literal('approval'),
    state: z.enum(['pending', 'approved', 'denied', 'expired', 'cancelled']),
  }),
  z.strictObject({
    ...interactiveBase,
    kind: z.literal('question'),
    questions: z.array(z.strictObject({
      id: OpaqueIdentifierSchema,
      prompt: detailText,
      detail: detailText.optional(),
      choices: z.array(detailText).max(64).optional(),
      multiple: z.boolean().optional(),
      allowFreeform: z.boolean().optional(),
    })).min(1).max(32),
    state: z.enum(['pending', 'answered', 'denied', 'expired', 'cancelled']),
  }),
])

export const TaskSnapshotSchema = z.strictObject({
  authoritative: z.literal(true),
  host: HostConnectionSchema,
  revision: SafeIntegerSchema,
  sequence: SafeIntegerSchema,
  cursor: CursorSchema,
  capabilities: TaskCapabilitiesSchema,
  activeTurnId: OpaqueIdentifierSchema.optional(),
  task: TaskSummarySchema,
  workspace: WorkspaceSummarySchema,
  branch: shortText.optional(),
  model: shortText.min(1),
  effort: TurnSettingsSchema.shape.effort,
  permission: z.enum(['ask', 'read-only', 'full-access']),
  messages: z.array(TaskMessageSchema).max(2048),
  sources: z.array(z.string().max(1024)).max(256),
}).superRefine((snapshot, context) => {
  const interactiveConsistent = snapshot.messages.every(message => (
    (message.kind !== 'approval' && message.kind !== 'question')
    || (
      message.taskId === snapshot.task.id
      && message.hostId === snapshot.host.hostId
      && message.connectionGeneration === snapshot.host.generation
    )
  ))
  const consistent = snapshot.task.revision === snapshot.revision
    && snapshot.task.activeTurnId === snapshot.activeTurnId
    && snapshot.workspace.hostId === snapshot.host.hostId
    && snapshot.workspace.connectionGeneration === snapshot.host.generation
    && snapshot.workspace.connection === snapshot.host.state
    && interactiveConsistent
  if (!consistent) context.addIssue({ code: 'custom', message: 'Snapshot authority is inconsistent.' })
})

const taskEventBase = {
  taskId: OpaqueIdentifierSchema,
  hostId: OpaqueIdentifierSchema,
  connectionGeneration: PositiveSafeIntegerSchema,
  revision: SafeIntegerSchema,
  sequence: SafeIntegerSchema,
  cursor: CursorSchema,
  createdAt: isoTimestamp,
}

export const TaskEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...taskEventBase, type: z.literal('snapshot'), snapshot: TaskSnapshotSchema }),
  z.strictObject({ ...taskEventBase, type: z.literal('message'), message: TaskMessageSchema }),
  z.strictObject({
    ...taskEventBase,
    type: z.literal('task'),
    task: TaskSummarySchema,
    capabilities: TaskCapabilitiesSchema,
    activeTurnId: OpaqueIdentifierSchema.optional(),
  }),
  z.strictObject({ ...taskEventBase, type: z.literal('connection'), connection: HostConnectionSchema }),
]).superRefine((event, context) => {
  let consistent = true
  if (event.type === 'snapshot') {
    consistent = event.taskId === event.snapshot.task.id
      && event.hostId === event.snapshot.host.hostId
      && event.connectionGeneration === event.snapshot.host.generation
      && event.revision === event.snapshot.revision
      && event.sequence === event.snapshot.sequence
      && event.cursor === event.snapshot.cursor
  } else if (event.type === 'task') {
    consistent = event.taskId === event.task.id
      && event.revision === event.task.revision
      && event.activeTurnId === event.task.activeTurnId
  } else if (event.type === 'connection') {
    consistent = event.hostId === event.connection.hostId
      && event.connectionGeneration === event.connection.generation
  } else if (
    event.type === 'message'
    && (event.message.kind === 'approval' || event.message.kind === 'question')
  ) {
    consistent = event.taskId === event.message.taskId
      && event.hostId === event.message.hostId
      && event.connectionGeneration === event.message.connectionGeneration
  }
  if (!consistent) context.addIssue({ code: 'custom', message: 'Event authority is inconsistent.' })
})

export const TaskPageSchema = z.strictObject({
  tasks: z.array(TaskSummarySchema).max(100),
  nextCursor: CursorSchema.optional(),
})

export const ActionRejectionSchema = z.strictObject({
  code: z.enum([
    'unknown-workspace',
    'unknown-task',
    'offline',
    'stale-host',
    'stale-connection-generation',
    'stale-task-revision',
    'capability-denied',
    'invalid-input',
    'turn-owner-mismatch',
    'request-not-found',
    'request-owner-mismatch',
    'request-expired',
    'request-already-resolved',
    'action-id-conflict',
  ]),
  message: z.string().max(512),
})

const QueuedActionReceiptSchema = z.strictObject({
  actionId,
  state: z.literal('queued'),
})

const AcceptedActionReceiptSchema = z.strictObject({
  actionId,
  state: z.literal('accepted'),
  revision: SafeIntegerSchema.optional(),
  sequence: SafeIntegerSchema.optional(),
  cursor: CursorSchema.optional(),
})

const RejectedActionReceiptSchema = z.strictObject({
  actionId,
  state: z.literal('rejected'),
  rejection: ActionRejectionSchema,
})

export const ActionReceiptSchema = z.discriminatedUnion('state', [
  QueuedActionReceiptSchema,
  AcceptedActionReceiptSchema,
  RejectedActionReceiptSchema,
])

export const StartTaskReceiptSchema = z.discriminatedUnion('state', [
  QueuedActionReceiptSchema,
  AcceptedActionReceiptSchema.extend({ task: TaskSummarySchema.optional() }),
  RejectedActionReceiptSchema,
])

export const PairingCreateReceiptSchema = z.discriminatedUnion('state', [
  QueuedActionReceiptSchema,
  z.strictObject({
    actionId,
    state: z.literal('accepted'),
    invitationFragment: Base64UrlSchema.max(16 * 1024),
    expiresAt: SafeIntegerSchema,
  }),
  RejectedActionReceiptSchema,
])

export const CodexOperationSchema = z.enum([
  'model.list',
  'manage.read',
  'pairing.create',
  'device.rename',
  'device.revoke',
  'workspace.list',
  'task.list',
  'task.read',
  'task.subscribe',
  'task.unsubscribe',
  'task.start',
  'turn.send',
  'turn.steer',
  'turn.interrupt',
  'request.resolve',
])

export type CodexOperation = z.infer<typeof CodexOperationSchema>

const requestSchemas = [
  z.strictObject({ kind: z.literal('request'), operation: z.literal('model.list'), params: z.strictObject({}) }),
  z.strictObject({ kind: z.literal('request'), operation: z.literal('manage.read'), params: z.strictObject({}) }),
  z.strictObject({ kind: z.literal('request'), operation: z.literal('pairing.create'), params: PairingCreateInputSchema }),
  z.strictObject({ kind: z.literal('request'), operation: z.literal('device.rename'), params: RenameDeviceInputSchema }),
  z.strictObject({ kind: z.literal('request'), operation: z.literal('device.revoke'), params: RevokeDeviceInputSchema }),
  z.strictObject({ kind: z.literal('request'), operation: z.literal('workspace.list'), params: z.strictObject({}) }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('task.list'),
    params: z.strictObject({ cursor: CursorSchema.optional() }),
  }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('task.read'),
    params: z.strictObject({ taskId: OpaqueIdentifierSchema }),
  }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('task.subscribe'),
    params: z.strictObject({ taskId: OpaqueIdentifierSchema, cursor: CursorSchema.optional() }),
  }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('task.unsubscribe'),
    params: z.strictObject({ taskId: OpaqueIdentifierSchema }),
  }),
  z.strictObject({ kind: z.literal('request'), operation: z.literal('task.start'), params: StartTaskInputSchema }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('turn.send'),
    params: z.strictObject({ taskId: OpaqueIdentifierSchema, input: SendTurnInputSchema }),
  }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('turn.steer'),
    params: z.strictObject({ taskId: OpaqueIdentifierSchema, input: SteerTurnInputSchema }),
  }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('turn.interrupt'),
    params: z.strictObject({ taskId: OpaqueIdentifierSchema, input: InterruptTurnInputSchema }),
  }),
  z.strictObject({
    kind: z.literal('request'),
    operation: z.literal('request.resolve'),
    params: z.union([ApprovalDecisionSchema, QuestionAnswerSchema]),
  }),
] as const

export const ApplicationRequestSchema = z.union(requestSchemas)

const protocolError = z.strictObject({
  code: z.enum(protocolErrorCodes),
  message: z.string().max(512),
})

const nonTaskScopedProtocolFailure = z.strictObject({
  kind: z.literal('response'),
  operation: z.enum([
    'model.list',
    'manage.read',
    'pairing.create',
    'device.rename',
    'device.revoke',
    'workspace.list',
    'task.list',
    'task.start',
  ]),
  ok: z.literal(false),
  error: protocolError,
})

const taskScopedProtocolFailure = z.strictObject({
  kind: z.literal('response'),
  operation: z.enum([
    'task.read',
    'task.subscribe',
    'task.unsubscribe',
    'turn.send',
    'turn.steer',
    'turn.interrupt',
    'request.resolve',
  ]),
  taskId: OpaqueIdentifierSchema,
  ok: z.literal(false),
  error: protocolError,
})

const responseSchemas = [
  z.strictObject({ kind: z.literal('response'), operation: z.literal('model.list'), ok: z.literal(true), result: ModelCatalogSchema }),
  z.strictObject({
    kind: z.literal('response'),
    operation: z.literal('manage.read'),
    ok: z.literal(true),
    result: ManagementSnapshotSchema,
  }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('pairing.create'), ok: z.literal(true), result: PairingCreateReceiptSchema }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('device.rename'), ok: z.literal(true), result: ActionReceiptSchema }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('device.revoke'), ok: z.literal(true), result: ActionReceiptSchema }),
  z.strictObject({
    kind: z.literal('response'),
    operation: z.literal('workspace.list'),
    ok: z.literal(true),
    result: z.array(WorkspaceSummarySchema).max(128),
  }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('task.list'), ok: z.literal(true), result: TaskPageSchema }),
  z.strictObject({
    kind: z.literal('response'),
    operation: z.literal('task.read'),
    taskId: OpaqueIdentifierSchema,
    ok: z.literal(true),
    result: TaskSnapshotSchema,
  }).superRefine((response, context) => {
    if (response.taskId !== response.result.task.id) {
      context.addIssue({ code: 'custom', message: 'Response task authority is inconsistent.' })
    }
  }),
  z.strictObject({
    kind: z.literal('response'),
    operation: z.literal('task.subscribe'),
    taskId: OpaqueIdentifierSchema,
    ok: z.literal(true),
    result: z.strictObject({ mode: z.enum(['replay', 'snapshot']) }),
  }),
  z.strictObject({
    kind: z.literal('response'),
    operation: z.literal('task.unsubscribe'),
    taskId: OpaqueIdentifierSchema,
    ok: z.literal(true),
    result: z.strictObject({ unsubscribed: z.literal(true) }),
  }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('task.start'), ok: z.literal(true), result: StartTaskReceiptSchema }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('turn.send'), taskId: OpaqueIdentifierSchema, ok: z.literal(true), result: ActionReceiptSchema }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('turn.steer'), taskId: OpaqueIdentifierSchema, ok: z.literal(true), result: ActionReceiptSchema }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('turn.interrupt'), taskId: OpaqueIdentifierSchema, ok: z.literal(true), result: ActionReceiptSchema }),
  z.strictObject({ kind: z.literal('response'), operation: z.literal('request.resolve'), taskId: OpaqueIdentifierSchema, ok: z.literal(true), result: ActionReceiptSchema }),
  nonTaskScopedProtocolFailure,
  taskScopedProtocolFailure,
] as const

export const ApplicationResponseSchema = z.union(responseSchemas)

export const ApplicationEventSchema = z.strictObject({
  kind: z.literal('event'),
  eventId: OpaqueIdentifierSchema,
  event: TaskEventSchema,
})

export const ApplicationSnapshotSchema = z.strictObject({
  kind: z.literal('snapshot'),
  snapshot: TaskSnapshotSchema,
})

export const ApplicationControlSchema = z.union([
  z.strictObject({ kind: z.literal('control'), operation: z.literal('ping'), timestamp: SafeIntegerSchema }),
  z.strictObject({ kind: z.literal('control'), operation: z.literal('pong'), timestamp: SafeIntegerSchema }),
  z.strictObject({
    kind: z.literal('control'),
    operation: z.literal('resync'),
    taskId: OpaqueIdentifierSchema,
    cursor: CursorSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('control'),
    operation: z.literal('error'),
    error: z.strictObject({ code: z.enum(protocolErrorCodes), message: z.string().max(512) }),
  }),
  SessionConfirmControlSchema,
  SessionReadyControlSchema,
])

export const ApplicationMessageSchema = z.union([
  ApplicationRequestSchema,
  ApplicationResponseSchema,
  ApplicationEventSchema,
  ApplicationSnapshotSchema,
  ApplicationControlSchema,
])

export type ApplicationRequest = z.infer<typeof ApplicationRequestSchema>
export type ApplicationResponse = z.infer<typeof ApplicationResponseSchema>
export type ApplicationEvent = z.infer<typeof ApplicationEventSchema>
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>
export type ApplicationControl = z.infer<typeof ApplicationControlSchema>
export type ApplicationMessage = z.infer<typeof ApplicationMessageSchema>

export function applicationEnvelopeType(message: ApplicationMessage): Exclude<EnvelopeMessageType, 'attachment'> {
  return message.kind
}

export function encodeApplicationMessage(message: unknown): string {
  return encodeCanonicalJson(ApplicationMessageSchema, message, MAX_APPLICATION_BYTES)
}

export function decodeApplicationMessage(
  frame: string | Uint8Array,
  expectedMessageType?: EnvelopeMessageType,
): ApplicationMessage {
  const message = decodeCanonicalJson(ApplicationMessageSchema, frame, MAX_APPLICATION_BYTES)
  if (expectedMessageType !== undefined && applicationEnvelopeType(message) !== expectedMessageType) {
    throw new ProtocolViolation('schema-invalid')
  }
  return message
}

function requestTaskId(request: ApplicationRequest): string | undefined {
  switch (request.operation) {
    case 'model.list':
    case 'manage.read':
    case 'pairing.create':
    case 'device.rename':
    case 'device.revoke':
    case 'workspace.list':
    case 'task.list':
    case 'task.start':
      return undefined
    case 'task.read':
    case 'task.subscribe':
    case 'task.unsubscribe':
    case 'turn.send':
    case 'turn.steer':
    case 'turn.interrupt':
      return request.params.taskId
    case 'request.resolve':
      return request.params.taskId
  }
}

function requestActionId(request: ApplicationRequest): string | undefined {
  switch (request.operation) {
    case 'pairing.create':
    case 'device.rename':
    case 'device.revoke':
    case 'task.start':
      return request.params.actionId
    case 'turn.send':
    case 'turn.steer':
    case 'turn.interrupt':
      return request.params.input.actionId
    case 'request.resolve':
      return request.params.actionId
    default:
      return undefined
  }
}

function responseTaskId(response: ApplicationResponse): string | undefined {
  return 'taskId' in response ? response.taskId : undefined
}

function assertHostAuthority(
  envelope: RoutedEnvelope,
  hostId: string,
  connectionGeneration: number,
): void {
  if (
    envelope.hostId !== hostId
    || envelope.connectionGeneration !== connectionGeneration
  ) {
    throw new ProtocolViolation('stale-authority')
  }
}

function assertTaskAuthority(envelope: RoutedEnvelope, taskId: string): void {
  if (envelope.taskId !== taskId) throw new ProtocolViolation('stale-authority')
}

function validateRequestAuthority(
  envelope: RoutedEnvelope,
  request: ApplicationRequest,
): void {
  const action = requestActionId(request)
  if (action !== undefined && action !== envelope.requestId) {
    throw new ProtocolViolation('stale-authority')
  }

  switch (request.operation) {
    case 'pairing.create':
    case 'device.rename':
    case 'device.revoke':
      assertHostAuthority(
        envelope,
        request.params.expected.hostId,
        request.params.expected.connectionGeneration,
      )
      return
    case 'task.start':
      assertHostAuthority(
        envelope,
        request.params.expected.hostId,
        request.params.expected.connectionGeneration,
      )
      return
    case 'turn.send':
    case 'turn.steer':
    case 'turn.interrupt':
      assertHostAuthority(
        envelope,
        request.params.input.expected.hostId,
        request.params.input.expected.connectionGeneration,
      )
      return
    case 'request.resolve':
      assertHostAuthority(
        envelope,
        request.params.hostId,
        request.params.connectionGeneration,
      )
      assertHostAuthority(
        envelope,
        request.params.expected.hostId,
        request.params.expected.connectionGeneration,
      )
      return
    default:
      return
  }
}

function validateInteractiveAuthority(
  envelope: RoutedEnvelope,
  message: z.infer<typeof TaskMessageSchema>,
): void {
  if (message.kind !== 'approval' && message.kind !== 'question') return
  assertTaskAuthority(envelope, message.taskId)
  assertHostAuthority(envelope, message.hostId, message.connectionGeneration)
}

function validateEventAuthority(
  envelope: RoutedEnvelope,
  message: ApplicationEvent,
): void {
  if (envelope.requestId !== message.eventId) {
    throw new ProtocolViolation('stale-authority')
  }
  assertTaskAuthority(envelope, message.event.taskId)
  assertHostAuthority(
    envelope,
    message.event.hostId,
    message.event.connectionGeneration,
  )
  if (message.event.type === 'message') {
    validateInteractiveAuthority(envelope, message.event.message)
  }
}

function validateSnapshotAuthority(
  envelope: RoutedEnvelope,
  snapshot: z.infer<typeof TaskSnapshotSchema>,
): void {
  assertTaskAuthority(envelope, snapshot.task.id)
  assertHostAuthority(envelope, snapshot.host.hostId, snapshot.host.generation)
  for (const message of snapshot.messages) {
    validateInteractiveAuthority(envelope, message)
  }
}

function validateResponseAuthority(
  envelope: RoutedEnvelope,
  response: ApplicationResponse,
): void {
  if (!response.ok) return
  switch (response.operation) {
    case 'manage.read':
      assertHostAuthority(
        envelope,
        response.result.hostId,
        response.result.connectionGeneration,
      )
      return
    case 'pairing.create':
    case 'device.rename':
    case 'device.revoke':
      if (response.result.actionId !== envelope.requestId) {
        throw new ProtocolViolation('stale-authority')
      }
      return
    case 'workspace.list':
      for (const workspace of response.result) {
        assertHostAuthority(
          envelope,
          workspace.hostId,
          workspace.connectionGeneration,
        )
      }
      return
    case 'task.read':
      validateSnapshotAuthority(envelope, response.result)
      return
    case 'task.start':
      if (response.result.actionId !== envelope.requestId) {
        throw new ProtocolViolation('stale-authority')
      }
      if (response.result.state === 'accepted' && response.result.task !== undefined) {
        assertTaskAuthority(envelope, response.result.task.id)
      }
      return
    case 'turn.send':
    case 'turn.steer':
    case 'turn.interrupt':
    case 'request.resolve':
      if (response.result.actionId !== envelope.requestId) {
        throw new ProtocolViolation('stale-authority')
      }
      return
    default:
      return
  }
}

/** Validate authenticated header/body authority before consuming envelope seq/ack. */
export function validateEnvelopeApplicationBinding(
  envelope: RoutedEnvelope,
  message: ApplicationMessage,
): void {
  if (applicationEnvelopeType(message) !== envelope.messageType) throw new ProtocolViolation('stale-authority')

  let bodyTaskId: string | undefined
  if (message.kind === 'request') bodyTaskId = requestTaskId(message)
  else if (message.kind === 'event') bodyTaskId = message.event.taskId
  else if (message.kind === 'snapshot') bodyTaskId = message.snapshot.task.id
  else if (message.kind === 'response') {
    bodyTaskId = responseTaskId(message)
    if (
      bodyTaskId === undefined
      && message.ok
      && message.operation === 'task.start'
      && message.result.state === 'accepted'
      && message.result.task !== undefined
    ) {
      bodyTaskId = message.result.task.id
    }
  }

  if (bodyTaskId !== undefined && envelope.taskId !== bodyTaskId) throw new ProtocolViolation('stale-authority')
  if (
    bodyTaskId === undefined
    && (message.kind === 'request' || message.kind === 'response')
    && envelope.taskId !== undefined
  ) {
    throw new ProtocolViolation('stale-authority')
  }

  if (message.kind === 'request') validateRequestAuthority(envelope, message)
  else if (message.kind === 'event') validateEventAuthority(envelope, message)
  else if (message.kind === 'snapshot') validateSnapshotAuthority(envelope, message.snapshot)
  else if (message.kind === 'response') validateResponseAuthority(envelope, message)
  else if (
    (message.operation === 'session.confirm' || message.operation === 'session.ready')
    && message.connectionGeneration !== envelope.connectionGeneration
  ) {
    throw new ProtocolViolation('stale-authority')
  } else if (message.operation === 'resync') {
    assertTaskAuthority(envelope, message.taskId)
  }
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot {
  return TaskSnapshotSchema.parse(value) as TaskSnapshot
}

export function parseTaskEvent(value: unknown): TaskEvent {
  return TaskEventSchema.parse(value) as TaskEvent
}

export function parseTaskPage(value: unknown): TaskPage {
  return TaskPageSchema.parse(value) as TaskPage
}

export function parseManagementSnapshot(value: unknown): ManagementSnapshot {
  return ManagementSnapshotSchema.parse(value) as ManagementSnapshot
}

// Compile-time compatibility checks with the UI boundary. These create no runtime dependency.
const _hostConnectionCompatibility: HostConnection = {} as z.infer<typeof HostConnectionSchema>
const _managementCompatibility: ManagementSnapshot = {} as z.infer<typeof ManagementSnapshotSchema>
const _pairingInputCompatibility: PairingCreateInput = {} as z.infer<typeof PairingCreateInputSchema>
const _renameDeviceCompatibility: RenameDeviceInput = {} as z.infer<typeof RenameDeviceInputSchema>
const _revokeDeviceCompatibility: RevokeDeviceInput = {} as z.infer<typeof RevokeDeviceInputSchema>
const _pairingReceiptCompatibility: PairingCreateReceipt = {} as z.infer<typeof PairingCreateReceiptSchema>
const _workspaceCompatibility: WorkspaceSummary = {} as z.infer<typeof WorkspaceSummarySchema>
const _startTaskCompatibility: StartTaskInput = {} as z.infer<typeof StartTaskInputSchema>
const _sendTurnCompatibility: SendTurnInput = {} as z.infer<typeof SendTurnInputSchema>
const _steerTurnCompatibility: SteerTurnInput = {} as z.infer<typeof SteerTurnInputSchema>
const _interruptCompatibility: InterruptTurnInput = {} as z.infer<typeof InterruptTurnInputSchema>
const _approvalCompatibility: ApprovalDecision = {} as z.infer<typeof ApprovalDecisionSchema>
const _questionCompatibility: QuestionAnswer = {} as z.infer<typeof QuestionAnswerSchema>
const _receiptCompatibility: ActionReceipt = {} as z.infer<typeof ActionReceiptSchema>
const _startReceiptCompatibility: StartTaskReceipt = {} as z.infer<typeof StartTaskReceiptSchema>
const _clientCompatibility: Pick<CodexServeClient, 'sendTurn'> | undefined = undefined

void _hostConnectionCompatibility
void _managementCompatibility
void _pairingInputCompatibility
void _renameDeviceCompatibility
void _revokeDeviceCompatibility
void _pairingReceiptCompatibility
void _workspaceCompatibility
void _startTaskCompatibility
void _sendTurnCompatibility
void _steerTurnCompatibility
void _interruptCompatibility
void _approvalCompatibility
void _questionCompatibility
void _receiptCompatibility
void _startReceiptCompatibility
void _clientCompatibility
