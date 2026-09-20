import type {
  ActionReceipt,
  ApprovalDecision,
  CodexServeClient,
  InterruptTurnInput,
  ManagementSnapshot,
  ModelOption,
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
} from './contracts.ts'

export type CodexServeTransportRequest =
  | { operation: 'model.list' }
  | { operation: 'manage.read' }
  | { operation: 'pairing.create'; input: PairingCreateInput }
  | { operation: 'device.rename'; input: RenameDeviceInput }
  | { operation: 'device.revoke'; input: RevokeDeviceInput }
  | { operation: 'workspace.list' }
  | { operation: 'task.list'; cursor?: string }
  | { operation: 'task.read'; taskId: string }
  | { operation: 'task.subscribe'; taskId: string; cursor?: string }
  | { operation: 'task.start'; input: StartTaskInput }
  | { operation: 'turn.send'; taskId: string; input: SendTurnInput }
  | { operation: 'turn.steer'; taskId: string; input: SteerTurnInput }
  | { operation: 'turn.interrupt'; taskId: string; input: InterruptTurnInput }
  | { operation: 'request.resolve'; request: ApprovalDecision | QuestionAnswer }

export type CodexServeTransportUnaryRequest = Exclude<
  CodexServeTransportRequest,
  { operation: 'task.subscribe' }
>

export type CodexServeTransportStreamRequest = Extract<
  CodexServeTransportRequest,
  { operation: 'task.subscribe' }
>

export type CodexServeTransportResult =
  | { operation: 'model.list'; value: ModelOption[] }
  | { operation: 'manage.read'; value: ManagementSnapshot }
  | { operation: 'pairing.create'; value: PairingCreateReceipt }
  | { operation: 'device.rename'; value: ActionReceipt }
  | { operation: 'device.revoke'; value: ActionReceipt }
  | { operation: 'workspace.list'; value: WorkspaceSummary[] }
  | { operation: 'task.list'; value: TaskPage }
  | { operation: 'task.read'; taskId: string; value: TaskSnapshot }
  | { operation: 'task.subscribe'; taskId: string; value: TaskEvent }
  | { operation: 'task.start'; value: StartTaskReceipt }
  | { operation: 'turn.send'; taskId: string; value: ActionReceipt }
  | { operation: 'turn.steer'; taskId: string; value: ActionReceipt }
  | { operation: 'turn.interrupt'; taskId: string; value: ActionReceipt }
  | { operation: 'request.resolve'; taskId: string; value: ActionReceipt }

export type CodexServeTransportOperation = CodexServeTransportRequest['operation']

/**
 * I/O boundary used by a future Relay implementation.
 *
 * The transport must authenticate and runtime-validate untrusted data before
 * returning it. Transport failures reject/throw; they are never converted into
 * an accepted Codex action receipt by this adapter.
 */
export interface CodexServeTransport {
  request(request: CodexServeTransportUnaryRequest): Promise<CodexServeTransportResult>
  stream(request: CodexServeTransportStreamRequest): AsyncIterable<CodexServeTransportResult>
}

export class CodexServeTransportOperationError extends Error {
  readonly expectedOperation: CodexServeTransportOperation
  readonly receivedOperation: CodexServeTransportOperation

  constructor(
    expectedOperation: CodexServeTransportOperation,
    receivedOperation: CodexServeTransportOperation,
  ) {
    super(`Codex Serve transport returned ${receivedOperation} for ${expectedOperation}.`)
    this.name = 'CodexServeTransportOperationError'
    this.expectedOperation = expectedOperation
    this.receivedOperation = receivedOperation
  }
}

export class CodexServeTransportTaskError extends Error {
  readonly expectedTaskId: string
  readonly receivedTaskId: string

  constructor(expectedTaskId: string, receivedTaskId: string) {
    super(`Codex Serve transport returned task ${receivedTaskId} for ${expectedTaskId}.`)
    this.name = 'CodexServeTransportTaskError'
    this.expectedTaskId = expectedTaskId
    this.receivedTaskId = receivedTaskId
  }
}

function assertOperation<Operation extends CodexServeTransportOperation>(
  expectedOperation: Operation,
  result: CodexServeTransportResult,
): asserts result is Extract<CodexServeTransportResult, { operation: Operation }> {
  if (result.operation !== expectedOperation) {
    throw new CodexServeTransportOperationError(expectedOperation, result.operation)
  }
}

function assertTaskId(
  expectedTaskId: string,
  result: Extract<CodexServeTransportResult, { taskId: string }>,
): void {
  if (result.taskId !== expectedTaskId) {
    throw new CodexServeTransportTaskError(expectedTaskId, result.taskId)
  }
}

class TransportCodexServeClient implements CodexServeClient {
  private readonly taskReads = new Map<string, Promise<TaskSnapshot>>()
  constructor(private readonly transport: CodexServeTransport) {}

  async listModels(): Promise<ModelOption[]> {
    const result = await this.transport.request({ operation: 'model.list' })
    assertOperation('model.list', result)
    return result.value
  }

  async readManagement(): Promise<ManagementSnapshot> {
    const result = await this.transport.request({ operation: 'manage.read' })
    assertOperation('manage.read', result)
    return result.value
  }

  async createPairing(input: PairingCreateInput): Promise<PairingCreateReceipt> {
    const result = await this.transport.request({ operation: 'pairing.create', input })
    assertOperation('pairing.create', result)
    return result.value
  }

  async renameDevice(input: RenameDeviceInput): Promise<ActionReceipt> {
    const result = await this.transport.request({ operation: 'device.rename', input })
    assertOperation('device.rename', result)
    return result.value
  }

  async revokeDevice(input: RevokeDeviceInput): Promise<ActionReceipt> {
    const result = await this.transport.request({ operation: 'device.revoke', input })
    assertOperation('device.revoke', result)
    return result.value
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const result = await this.transport.request({ operation: 'workspace.list' })
    assertOperation('workspace.list', result)
    return result.value
  }

  async listTasks(cursor?: string): Promise<TaskPage> {
    const result = await this.transport.request({
      operation: 'task.list',
      ...(cursor === undefined ? {} : { cursor }),
    })
    assertOperation('task.list', result)
    return result.value
  }

  readTask(taskId: string): Promise<TaskSnapshot> {
    const current = this.taskReads.get(taskId)
    if (current) return current
    const request = this.transport.request({ operation: 'task.read', taskId }).then(result => {
      assertOperation('task.read', result)
      assertTaskId(taskId, result)
      return result.value
    })
    this.taskReads.set(taskId, request)
    const release = () => { if (this.taskReads.get(taskId) === request) this.taskReads.delete(taskId) }
    void request.then(release, release)
    return request
  }

  async *subscribe(taskId: string, cursor?: string): AsyncIterable<TaskEvent> {
    const stream = this.transport.stream({
      operation: 'task.subscribe',
      taskId,
      ...(cursor === undefined ? {} : { cursor }),
    })
    for await (const result of stream) {
      assertOperation('task.subscribe', result)
      assertTaskId(taskId, result)
      yield result.value
    }
  }

  async startTask(input: StartTaskInput): Promise<StartTaskReceipt> {
    const result = await this.transport.request({ operation: 'task.start', input })
    assertOperation('task.start', result)
    return result.value
  }

  async sendTurn(taskId: string, input: SendTurnInput): Promise<ActionReceipt> {
    this.taskReads.delete(taskId)
    const result = await this.transport.request({ operation: 'turn.send', taskId, input })
    this.taskReads.delete(taskId)
    assertOperation('turn.send', result)
    assertTaskId(taskId, result)
    return result.value
  }

  async steerTurn(taskId: string, input: SteerTurnInput): Promise<ActionReceipt> {
    this.taskReads.delete(taskId)
    const result = await this.transport.request({ operation: 'turn.steer', taskId, input })
    this.taskReads.delete(taskId)
    assertOperation('turn.steer', result)
    assertTaskId(taskId, result)
    return result.value
  }

  async interruptTurn(taskId: string, input: InterruptTurnInput): Promise<ActionReceipt> {
    const result = await this.transport.request({ operation: 'turn.interrupt', taskId, input })
    assertOperation('turn.interrupt', result)
    assertTaskId(taskId, result)
    return result.value
  }

  async resolveRequest(request: ApprovalDecision | QuestionAnswer): Promise<ActionReceipt> {
    const result = await this.transport.request({ operation: 'request.resolve', request })
    assertOperation('request.resolve', result)
    assertTaskId(request.taskId, result)
    return result.value
  }
}

export function createTransportCodexServeClient(transport: CodexServeTransport): CodexServeClient {
  return new TransportCodexServeClient(transport)
}
