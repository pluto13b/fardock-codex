export type ConnectionState = 'online' | 'reconnecting' | 'offline'
export type TaskStatus =
  | 'syncing'
  | 'running'
  | 'waiting-approval'
  | 'completed'
  | 'failed'
  | 'unknown'
  | 'offline'
export type PermissionMode = 'ask' | 'read-only' | 'full-access'
/** Opaque bounded effort id from the owned app-server model catalog. */
export type ReasoningEffort = string
export interface ModelOption {
  id: string
  displayName: string
  defaultReasoningEffort: ReasoningEffort
  supportedReasoningEfforts: ReasoningEffort[]
  isDefault: boolean
}
export const MAX_INLINE_ATTACHMENT_BYTES = 256 * 1024
export const MAX_INLINE_ATTACHMENT_TOTAL_BYTES = 256 * 1024

export interface HostConnection {
  hostId: string
  generation: number
  state: ConnectionState
}

export interface ManagementLayers {
  gateway: 'healthy'
  relaySocket: 'authenticated'
  host: 'online'
  e2ee: 'ready'
  companion: 'online'
  appServer: 'compatible' | 'read-only' | 'unavailable'
}

export interface ManagedDevice {
  deviceId: string
  displayName: string
  shortId: string
  signingFingerprint: string
  authorizationId: string
  authorizationEpoch: number
  status: 'active' | 'revoked'
  presence: 'online' | 'offline' | 'unknown'
  pairedAt: number
  lastSeenAt: number | null
  isCurrent: boolean
}

export type ManagementEvent =
  | { eventId: string; category: 'gateway'; state: 'healthy'; occurredAt: number }
  | { eventId: string; category: 'relay'; state: 'authenticated'; occurredAt: number }
  | { eventId: string; category: 'host'; state: 'online'; occurredAt: number }
  | { eventId: string; category: 'e2ee'; state: 'ready'; occurredAt: number }
  | { eventId: string; category: 'companion'; state: 'online'; occurredAt: number }
  | { eventId: string; category: 'app-server'; state: ManagementLayers['appServer']; occurredAt: number }
  | { eventId: string; category: 'device'; state: 'authenticated'; occurredAt: number }

export interface ManagementSnapshot {
  generatedAt: number
  hostId: string
  connectionGeneration: number
  layers: ManagementLayers
  devices: ManagedDevice[]
  events: ManagementEvent[]
}

export interface PairingCreateInput {
  actionId: string
  expected: ExpectedHostState
}

export interface ManagedDeviceTarget {
  deviceId: string
  authorizationId: string
  authorizationEpoch: number
}

export interface RenameDeviceInput extends ManagedDeviceTarget {
  actionId: string
  displayName: string
  expected: ExpectedHostState
}

export interface RevokeDeviceInput extends ManagedDeviceTarget {
  actionId: string
  expected: ExpectedHostState
}

export type PairingCreateReceipt =
  | { actionId: string; state: 'queued' }
  | { actionId: string; state: 'accepted'; invitationFragment: string; expiresAt: number }
  | { actionId: string; state: 'rejected'; rejection: ActionRejection }

export interface WorkspaceCapabilities {
  startTask: boolean
}

export interface WorkspaceSummary {
  id: string
  name: string
  pathLabel: string
  hostId: string
  connectionGeneration: number
  connection: ConnectionState
  capabilities: WorkspaceCapabilities
}

export interface TaskSummary {
  id: string
  workspaceId: string
  title: string
  status: TaskStatus
  updatedAt: string
  revision: number
  activeTurnId?: string
  completionReason?: 'completed' | 'interrupted' | 'denied' | 'failed'
}

export interface TaskCapabilities {
  sendTurn: boolean
  steerTurn: boolean
  interruptTurn: boolean
  resolveApproval: boolean
  answerQuestion: boolean
}

export interface MessageBase {
  id: string
  createdAt: string | null
  turnId?: string
}

export interface UserMessage extends MessageBase {
  kind: 'user'
  text: string
  input?: UserInput[]
}

export interface AssistantMessage extends MessageBase {
  kind: 'assistant'
  markdown: string
}

export interface ReasoningMessage extends MessageBase {
  kind: 'reasoning'
  title: string
  summary: string
  state: 'running' | 'completed'
}

export interface ToolMessage extends MessageBase {
  kind: 'tool'
  title: string
  summary: string
  command?: string
  output?: string
  state: 'running' | 'completed' | 'failed'
}

export interface DiffMessage extends MessageBase {
  kind: 'diff'
  files: Array<{ path: string; additions: number; deletions: number }>
}

/** Authority that must be echoed to resolve an interactive request. */
export interface RequestAuthority {
  requestId: string
  taskId: string
  turnId: string
  hostId: string
  connectionGeneration: number
  requestNonce: string
  issuedAt: string
  expiresAt: string
}

interface InteractiveRequestBase extends RequestAuthority {
  id: string
  createdAt: string
  title: string
  detail: string
  command?: string
}

export interface ApprovalRequestMessage extends InteractiveRequestBase {
  kind: 'approval'
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled'
}

export interface QuestionPrompt {
  id: string
  prompt: string
  detail?: string
  choices?: string[]
  multiple?: boolean
  allowFreeform?: boolean
}

export interface QuestionMessage extends InteractiveRequestBase {
  kind: 'question'
  questions: QuestionPrompt[]
  state: 'pending' | 'answered' | 'denied' | 'expired' | 'cancelled'
}

export type InteractiveRequestMessage = ApprovalRequestMessage | QuestionMessage

/**
 * Compatibility name used by the first UI slice. New code should narrow
 * `InteractiveRequestMessage.kind` before rendering the request body.
 */
export type ApprovalMessage = InteractiveRequestMessage

export type TaskMessage =
  | UserMessage
  | AssistantMessage
  | ReasoningMessage
  | ToolMessage
  | DiffMessage
  | InteractiveRequestMessage

export interface TaskSnapshot {
  authoritative: true
  host: HostConnection
  revision: number
  sequence: number
  cursor: string
  capabilities: TaskCapabilities
  activeTurnId?: string
  task: TaskSummary
  workspace: WorkspaceSummary
  branch?: string
  model: string
  effort: ReasoningEffort
  permission: PermissionMode
  messages: TaskMessage[]
  sources: string[]
}

export interface TaskPage {
  tasks: TaskSummary[]
  nextCursor?: string
}

export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; attachmentId: string; name: string }
  | { type: 'file'; attachmentId: string; name: string }

export interface InlineAttachment {
  attachmentId: string
  name: string
  mediaType: string
  byteLength: number
  contentBase64Url: string
}

export interface TurnSettings {
  model: string
  effort: ReasoningEffort
  permission: PermissionMode
}

export interface ExpectedHostState {
  hostId: string
  connectionGeneration: number
}

export interface ExpectedTaskState extends ExpectedHostState {
  revision: number
}

export interface StartTaskInput {
  actionId: string
  workspaceId: string
  input: UserInput[]
  attachments?: InlineAttachment[]
  settings: TurnSettings
  expected: ExpectedHostState
}

export interface SendTurnInput {
  actionId: string
  input: UserInput[]
  attachments?: InlineAttachment[]
  settings: TurnSettings
  expected: ExpectedTaskState
}

export interface SteerTurnInput {
  actionId: string
  input: UserInput[]
  attachments?: InlineAttachment[]
  expected: ExpectedTaskState
}

export interface InterruptTurnInput {
  actionId: string
  turnId: string
  expected: ExpectedTaskState
}

export type ActionRejectionCode =
  | 'unknown-workspace'
  | 'unknown-task'
  | 'offline'
  | 'stale-host'
  | 'stale-connection-generation'
  | 'stale-task-revision'
  | 'capability-denied'
  | 'invalid-input'
  | 'turn-owner-mismatch'
  | 'request-not-found'
  | 'request-owner-mismatch'
  | 'request-expired'
  | 'request-already-resolved'
  | 'action-id-conflict'

export interface ActionRejection {
  code: ActionRejectionCode
  message: string
}

export interface QueuedActionReceipt {
  actionId: string
  state: 'queued'
}

export interface AcceptedActionReceipt {
  actionId: string
  state: 'accepted'
  revision?: number
  sequence?: number
  cursor?: string
}

export interface RejectedActionReceipt {
  actionId: string
  state: 'rejected'
  rejection: ActionRejection
}

export type ActionReceipt =
  | QueuedActionReceipt
  | AcceptedActionReceipt
  | RejectedActionReceipt

export type StartTaskReceipt =
  | QueuedActionReceipt
  | (AcceptedActionReceipt & { task?: TaskSummary })
  | RejectedActionReceipt

interface RequestResolutionBase extends RequestAuthority {
  actionId: string
  expected: ExpectedTaskState
}

export interface ApprovalDecision extends RequestResolutionBase {
  type: 'approval'
  decision: 'approve-once' | 'deny'
}

export interface QuestionAnswerValue {
  questionId: string
  values: string[]
}

export interface QuestionAnswer extends RequestResolutionBase {
  type: 'question'
  answers: QuestionAnswerValue[]
}

interface TaskEventBase {
  taskId: string
  hostId: string
  connectionGeneration: number
  revision: number
  sequence: number
  cursor: string
  createdAt: string
}

export type TaskEvent =
  | (TaskEventBase & { type: 'snapshot'; snapshot: TaskSnapshot })
  | (TaskEventBase & { type: 'message'; message: TaskMessage })
  | (TaskEventBase & { type: 'task'; task: TaskSummary; capabilities: TaskCapabilities; activeTurnId?: string })
  | (TaskEventBase & { type: 'connection'; connection: HostConnection })

export interface CodexServeClient {
  listModels(): Promise<ModelOption[]>
  readManagement(): Promise<ManagementSnapshot>
  createPairing(input: PairingCreateInput): Promise<PairingCreateReceipt>
  renameDevice(input: RenameDeviceInput): Promise<ActionReceipt>
  revokeDevice(input: RevokeDeviceInput): Promise<ActionReceipt>
  listWorkspaces(): Promise<WorkspaceSummary[]>
  listTasks(cursor?: string): Promise<TaskPage>
  readTask(taskId: string): Promise<TaskSnapshot>
  subscribe(taskId: string, cursor?: string): AsyncIterable<TaskEvent>
  startTask(input: StartTaskInput): Promise<StartTaskReceipt>
  sendTurn(taskId: string, input: SendTurnInput): Promise<ActionReceipt>
  steerTurn(taskId: string, input: SteerTurnInput): Promise<ActionReceipt>
  interruptTurn(taskId: string, input: InterruptTurnInput): Promise<ActionReceipt>
  resolveRequest(request: ApprovalDecision | QuestionAnswer): Promise<ActionReceipt>
}
