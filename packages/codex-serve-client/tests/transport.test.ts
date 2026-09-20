import { describe, expect, it } from 'vitest'

import type {
  ActionReceipt,
  ApprovalDecision,
  InterruptTurnInput,
  ManagementSnapshot,
  PairingCreateInput,
  RenameDeviceInput,
  RevokeDeviceInput,
  SendTurnInput,
  StartTaskInput,
  StartTaskReceipt,
  SteerTurnInput,
  TaskEvent,
  TaskSnapshot,
  TaskSummary,
  WorkspaceSummary,
} from '../src/contracts.ts'
import {
  CodexServeTransportOperationError,
  CodexServeTransportTaskError,
  createTransportCodexServeClient,
  type CodexServeTransport,
  type CodexServeTransportResult,
  type CodexServeTransportStreamRequest,
  type CodexServeTransportUnaryRequest,
} from '../src/transport.ts'

const workspace: WorkspaceSummary = {
  id: 'workspace-1',
  name: 'workspace',
  pathLabel: 'workspace',
  hostId: 'host-1',
  connectionGeneration: 3,
  connection: 'online',
  capabilities: { startTask: true },
}

const task: TaskSummary = {
  id: 'task-1',
  workspaceId: workspace.id,
  title: 'Transport adapter',
  status: 'completed',
  updatedAt: '2026-08-23T00:00:00.000Z',
  revision: 7,
  completionReason: 'completed',
}

const snapshot: TaskSnapshot = {
  authoritative: true,
  host: { hostId: workspace.hostId, generation: workspace.connectionGeneration, state: 'online' },
  revision: task.revision,
  sequence: 11,
  cursor: 'cursor-11',
  capabilities: {
    sendTurn: true,
    steerTurn: false,
    interruptTurn: false,
    resolveApproval: false,
    answerQuestion: false,
  },
  task,
  workspace,
  model: 'gpt-5.6-sol',
  effort: 'high',
  permission: 'ask',
  messages: [],
  sources: [],
}

const management: ManagementSnapshot = {
  generatedAt: Date.parse('2026-08-23T00:00:00.000Z'),
  hostId: workspace.hostId,
  connectionGeneration: workspace.connectionGeneration,
  layers: {
    gateway: 'healthy',
    relaySocket: 'authenticated',
    host: 'online',
    e2ee: 'ready',
    companion: 'online',
    appServer: 'compatible',
  },
  devices: [],
  events: [],
}

const pairingInput: PairingCreateInput = {
  actionId: 'pairing-create',
  expected: { hostId: workspace.hostId, connectionGeneration: workspace.connectionGeneration },
}

const renameInput: RenameDeviceInput = {
  actionId: 'device-rename',
  deviceId: 'client-old',
  authorizationId: 'authorization-old',
  authorizationEpoch: 2,
  displayName: '旧手机',
  expected: pairingInput.expected,
}

const revokeInput: RevokeDeviceInput = {
  actionId: 'device-revoke',
  deviceId: renameInput.deviceId,
  authorizationId: renameInput.authorizationId,
  authorizationEpoch: renameInput.authorizationEpoch,
  expected: pairingInput.expected,
}

const expectedTaskState = {
  hostId: workspace.hostId,
  connectionGeneration: workspace.connectionGeneration,
  revision: task.revision,
}

const startInput: StartTaskInput = {
  actionId: 'action-start',
  workspaceId: workspace.id,
  input: [{ type: 'text', text: '  新任务\n```ts\nconst emoji = "🚀"\n```  ' }],
  settings: { model: 'gpt-5.6-sol', effort: 'high', permission: 'ask' },
  expected: {
    hostId: workspace.hostId,
    connectionGeneration: workspace.connectionGeneration,
  },
}

const sendInput: SendTurnInput = {
  actionId: 'action-send',
  input: [{ type: 'text', text: '  原文\n"quoted" 🚀  ' }],
  settings: { model: 'gpt-5.6-sol', effort: 'high', permission: 'ask' },
  expected: expectedTaskState,
}

const steerInput: SteerTurnInput = {
  actionId: 'action-steer',
  input: [{ type: 'text', text: '补充' }],
  expected: expectedTaskState,
}

const interruptInput: InterruptTurnInput = {
  actionId: 'action-interrupt',
  turnId: 'turn-1',
  expected: expectedTaskState,
}

const approval: ApprovalDecision = {
  type: 'approval',
  actionId: 'action-resolve',
  decision: 'approve-once',
  requestId: 'approval-1',
  taskId: task.id,
  turnId: 'turn-1',
  hostId: workspace.hostId,
  connectionGeneration: workspace.connectionGeneration,
  requestNonce: 'nonce-1',
  issuedAt: '2026-08-23T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  expected: expectedTaskState,
}

const accepted: ActionReceipt = {
  actionId: 'action',
  state: 'accepted',
  revision: task.revision,
  sequence: snapshot.sequence,
  cursor: snapshot.cursor,
}

const startReceipt: StartTaskReceipt = {
  ...accepted,
  actionId: startInput.actionId,
  task,
}

const event: TaskEvent = {
  type: 'snapshot',
  taskId: task.id,
  hostId: workspace.hostId,
  connectionGeneration: workspace.connectionGeneration,
  revision: snapshot.revision,
  sequence: snapshot.sequence,
  cursor: snapshot.cursor,
  createdAt: '2026-08-23T00:00:00.000Z',
  snapshot,
}

class RecordingTransport implements CodexServeTransport {
  readonly requestCalls: CodexServeTransportUnaryRequest[] = []
  readonly streamCalls: CodexServeTransportStreamRequest[] = []

  constructor(
    private readonly requestResults: CodexServeTransportResult[],
    private readonly streamResults: CodexServeTransportResult[] = [],
  ) {}

  async request(request: CodexServeTransportUnaryRequest): Promise<CodexServeTransportResult> {
    this.requestCalls.push(request)
    const result = this.requestResults.shift()
    if (result === undefined) throw new Error('Test transport has no queued result.')
    return result
  }

  async *stream(request: CodexServeTransportStreamRequest): AsyncIterable<CodexServeTransportResult> {
    this.streamCalls.push(request)
    for (const result of this.streamResults) yield result
  }
}

describe('createTransportCodexServeClient', () => {
  it('delegates every query and action through the fixed operation whitelist', async () => {
    const transport = new RecordingTransport([
      { operation: 'manage.read', value: management },
      {
        operation: 'pairing.create',
        value: {
          actionId: pairingInput.actionId,
          state: 'accepted',
          invitationFragment: 'cGFpcmluZw',
          expiresAt: management.generatedAt + 120_000,
        },
      },
      { operation: 'device.rename', value: { actionId: renameInput.actionId, state: 'accepted' } },
      { operation: 'device.revoke', value: { actionId: revokeInput.actionId, state: 'accepted' } },
      { operation: 'workspace.list', value: [workspace] },
      { operation: 'task.list', value: { tasks: [task], nextCursor: 'tasks-next' } },
      { operation: 'task.read', taskId: task.id, value: snapshot },
      { operation: 'task.start', value: startReceipt },
      { operation: 'turn.send', taskId: task.id, value: { ...accepted, actionId: sendInput.actionId } },
      { operation: 'turn.steer', taskId: task.id, value: { ...accepted, actionId: steerInput.actionId } },
      { operation: 'turn.interrupt', taskId: task.id, value: { ...accepted, actionId: interruptInput.actionId } },
      { operation: 'request.resolve', taskId: task.id, value: { ...accepted, actionId: approval.actionId } },
    ])
    const client = createTransportCodexServeClient(transport)

    await expect(client.readManagement()).resolves.toBe(management)
    await expect(client.createPairing(pairingInput)).resolves.toMatchObject({ state: 'accepted' })
    await expect(client.renameDevice(renameInput)).resolves.toMatchObject({ state: 'accepted' })
    await expect(client.revokeDevice(revokeInput)).resolves.toMatchObject({ state: 'accepted' })
    await expect(client.listWorkspaces()).resolves.toEqual([workspace])
    await expect(client.listTasks('tasks-current')).resolves.toEqual({
      tasks: [task],
      nextCursor: 'tasks-next',
    })
    await expect(client.readTask(task.id)).resolves.toBe(snapshot)
    await expect(client.startTask(startInput)).resolves.toBe(startReceipt)
    await expect(client.sendTurn(task.id, sendInput)).resolves.toMatchObject({
      actionId: sendInput.actionId,
      state: 'accepted',
    })
    await expect(client.steerTurn(task.id, steerInput)).resolves.toMatchObject({
      actionId: steerInput.actionId,
      state: 'accepted',
    })
    await expect(client.interruptTurn(task.id, interruptInput)).resolves.toMatchObject({
      actionId: interruptInput.actionId,
      state: 'accepted',
    })
    await expect(client.resolveRequest(approval)).resolves.toMatchObject({
      actionId: approval.actionId,
      state: 'accepted',
    })

    expect(transport.requestCalls).toEqual([
      { operation: 'manage.read' },
      { operation: 'pairing.create', input: pairingInput },
      { operation: 'device.rename', input: renameInput },
      { operation: 'device.revoke', input: revokeInput },
      { operation: 'workspace.list' },
      { operation: 'task.list', cursor: 'tasks-current' },
      { operation: 'task.read', taskId: task.id },
      { operation: 'task.start', input: startInput },
      { operation: 'turn.send', taskId: task.id, input: sendInput },
      { operation: 'turn.steer', taskId: task.id, input: steerInput },
      { operation: 'turn.interrupt', taskId: task.id, input: interruptInput },
      { operation: 'request.resolve', request: approval },
    ])
    expect(sendInput.input[0]).toEqual({ type: 'text', text: '  原文\n"quoted" 🚀  ' })
  })

  it('passes subscription cursor and yields only tagged task events', async () => {
    const transport = new RecordingTransport([], [
      { operation: 'task.subscribe', taskId: task.id, value: event },
    ])
    const client = createTransportCodexServeClient(transport)
    const received: TaskEvent[] = []

    for await (const item of client.subscribe(task.id, 'cursor-10')) received.push(item)

    expect(transport.streamCalls).toEqual([
      { operation: 'task.subscribe', taskId: task.id, cursor: 'cursor-10' },
    ])
    expect(received).toEqual([event])
  })

  it('rejects a mismatched unary result instead of returning another operation value', async () => {
    const transport = new RecordingTransport([
      { operation: 'task.list', value: { tasks: [] } },
    ])
    const client = createTransportCodexServeClient(transport)

    await expect(client.listWorkspaces()).rejects.toEqual(expect.objectContaining({
      name: 'CodexServeTransportOperationError',
      expectedOperation: 'workspace.list',
      receivedOperation: 'task.list',
    }))
  })

  it('rejects a mismatched stream item before yielding it', async () => {
    const transport = new RecordingTransport([], [
      { operation: 'turn.send', taskId: task.id, value: accepted },
    ])
    const client = createTransportCodexServeClient(transport)

    const read = async () => {
      for await (const item of client.subscribe(task.id)) return item
      return undefined
    }

    await expect(read()).rejects.toBeInstanceOf(CodexServeTransportOperationError)
  })

  it('rejects task-scoped unary and stream results bound to another task', async () => {
    const unaryTransport = new RecordingTransport([
      { operation: 'task.read', taskId: 'task-other', value: snapshot },
    ])
    const unaryClient = createTransportCodexServeClient(unaryTransport)
    await expect(unaryClient.readTask(task.id)).rejects.toEqual(expect.objectContaining({
      name: 'CodexServeTransportTaskError',
      expectedTaskId: task.id,
      receivedTaskId: 'task-other',
    }))

    const streamTransport = new RecordingTransport([], [
      { operation: 'task.subscribe', taskId: 'task-other', value: event },
    ])
    const streamClient = createTransportCodexServeClient(streamTransport)
    const read = async () => {
      for await (const item of streamClient.subscribe(task.id)) return item
      return undefined
    }
    await expect(read()).rejects.toBeInstanceOf(CodexServeTransportTaskError)
  })

  it('propagates transport failures without synthesizing an accepted receipt', async () => {
    const failure = new Error('transport offline')
    const transport: CodexServeTransport = {
      async request() {
        throw failure
      },
      async *stream() {
        throw failure
      },
    }
    const client = createTransportCodexServeClient(transport)

    await expect(client.sendTurn(task.id, sendInput)).rejects.toBe(failure)
  })
})
