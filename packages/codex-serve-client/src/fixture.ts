import type {
  ActionReceipt,
  AssistantMessage,
  ActionRejectionCode,
  ApprovalDecision,
  CodexServeClient,
  ExpectedHostState,
  ExpectedTaskState,
  HostConnection,
  InlineAttachment,
  InteractiveRequestMessage,
  InterruptTurnInput,
  ManagementSnapshot,
  PairingCreateInput,
  PairingCreateReceipt,
  QuestionAnswer,
  QuestionMessage,
  RenameDeviceInput,
  RevokeDeviceInput,
  SendTurnInput,
  StartTaskInput,
  StartTaskReceipt,
  SteerTurnInput,
  TaskCapabilities,
  TaskEvent,
  TaskMessage,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
  TurnSettings,
  UserInput,
  UserMessage,
  WorkspaceSummary,
} from './contracts.ts'

const FIXTURE_HOST_ID = 'fixture-host'
const FIXTURE_GENERATION = 1
const now = new Date('2026-08-23T05:42:00.000Z').toISOString()
const requestExpiry = new Date('2099-01-01T00:00:00.000Z').toISOString()

export const fixtureManagementSnapshot: ManagementSnapshot = {
  generatedAt: Date.parse(now),
  hostId: FIXTURE_HOST_ID,
  connectionGeneration: FIXTURE_GENERATION,
  layers: {
    gateway: 'healthy',
    relaySocket: 'authenticated',
    host: 'online',
    e2ee: 'ready',
    companion: 'online',
    appServer: 'compatible',
  },
  devices: [
    {
      deviceId: 'fixture-browser-current',
      displayName: '这台浏览器',
      shortId: 'current',
      signingFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      authorizationId: 'fixture-authorization-current',
      authorizationEpoch: 2,
      status: 'active',
      presence: 'online',
      pairedAt: Date.parse('2026-08-22T09:10:00.000Z'),
      lastSeenAt: Date.parse(now),
      isCurrent: true,
    },
    {
      deviceId: 'fixture-tablet-active',
      displayName: '平板浏览器',
      shortId: 'tablet',
      signingFingerprint: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      authorizationId: 'fixture-authorization-tablet',
      authorizationEpoch: 1,
      status: 'active',
      presence: 'unknown',
      pairedAt: Date.parse('2026-08-21T10:30:00.000Z'),
      lastSeenAt: null,
      isCurrent: false,
    },
    {
      deviceId: 'fixture-phone-revoked',
      displayName: '旧手机',
      shortId: 'revoked',
      signingFingerprint: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
      authorizationId: 'fixture-authorization-revoked',
      authorizationEpoch: 3,
      status: 'revoked',
      presence: 'offline',
      pairedAt: Date.parse('2026-08-20T12:00:00.000Z'),
      lastSeenAt: null,
      isCurrent: false,
    },
  ],
  events: [
    { eventId: 'fixture-event-gateway', category: 'gateway', state: 'healthy', occurredAt: Date.parse(now) },
    { eventId: 'fixture-event-host', category: 'host', state: 'online', occurredAt: Date.parse(now) },
    { eventId: 'fixture-event-device', category: 'device', state: 'authenticated', occurredAt: Date.parse(now) },
    { eventId: 'fixture-event-app-server', category: 'app-server', state: 'compatible', occurredAt: Date.parse(now) },
  ],
}

const noCapabilities: TaskCapabilities = {
  sendTurn: false,
  steerTurn: false,
  interruptTurn: false,
  resolveApproval: false,
  answerQuestion: false,
}

const completedCapabilities: TaskCapabilities = {
  ...noCapabilities,
  sendTurn: true,
}

const runningCapabilities: TaskCapabilities = {
  ...noCapabilities,
  steerTurn: true,
  interruptTurn: true,
}

const approvalCapabilities: TaskCapabilities = {
  ...noCapabilities,
  interruptTurn: true,
  resolveApproval: true,
  answerQuestion: true,
}

function cursorFor(taskId: string, sequence: number): string {
  return `fixture:${taskId}:${sequence}`
}

function fixtureHost(state: HostConnection['state']): HostConnection {
  return { hostId: FIXTURE_HOST_ID, generation: FIXTURE_GENERATION, state }
}

export const fixtureWorkspaces: WorkspaceSummary[] = [
  {
    id: 'codex-plus',
    name: 'codex-plus',
    pathLabel: 'C:\\Projects\\codex-plus',
    hostId: FIXTURE_HOST_ID,
    connectionGeneration: FIXTURE_GENERATION,
    connection: 'online',
    capabilities: { startTask: true },
  },
  {
    id: 'web-client',
    name: 'web-client',
    pathLabel: 'C:\\Projects\\web-client',
    hostId: FIXTURE_HOST_ID,
    connectionGeneration: FIXTURE_GENERATION,
    connection: 'online',
    capabilities: { startTask: true },
  },
  {
    id: 'offline-demo',
    name: 'offline-demo',
    pathLabel: 'C:\\Projects\\offline-demo',
    hostId: FIXTURE_HOST_ID,
    connectionGeneration: FIXTURE_GENERATION,
    connection: 'offline',
    capabilities: { startTask: false },
  },
]

export const fixtureTasks: TaskSummary[] = [
  {
    id: 'ui-shell',
    workspaceId: 'codex-plus',
    title: '套用 DeepSeek Harness Desktop UI',
    status: 'running',
    updatedAt: '刚刚',
    revision: 1,
    activeTurnId: 'turn-ui-shell',
  },
  {
    id: 'mobile-flow',
    workspaceId: 'codex-plus',
    title: '手机端与多端互联',
    status: 'waiting-approval',
    updatedAt: '12 分钟前',
    revision: 1,
    activeTurnId: 'turn-mobile-flow',
  },
  {
    id: 'adapter',
    workspaceId: 'web-client',
    title: '实现 Codex Serve Adapter',
    status: 'completed',
    updatedAt: '昨天',
    revision: 1,
  },
  {
    id: 'offline-task',
    workspaceId: 'offline-demo',
    title: '上次离线任务',
    status: 'offline',
    updatedAt: '3 天前',
    revision: 1,
  },
]

function snapshotBase(
  task: TaskSummary,
  workspace: WorkspaceSummary,
  capabilities: TaskCapabilities,
): Pick<TaskSnapshot, 'authoritative' | 'host' | 'revision' | 'sequence' | 'cursor' | 'capabilities' | 'activeTurnId' | 'task' | 'workspace'> {
  const sequence = 1
  return {
    authoritative: true,
    host: fixtureHost(workspace.connection),
    revision: task.revision,
    sequence,
    cursor: cursorFor(task.id, sequence),
    capabilities,
    ...(task.activeTurnId === undefined ? {} : { activeTurnId: task.activeTurnId }),
    task,
    workspace,
  }
}

export const fixtureSnapshots: Record<string, TaskSnapshot> = {
  'ui-shell': {
    ...snapshotBase(fixtureTasks[0], fixtureWorkspaces[0], runningCapabilities),
    branch: 'main',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    permission: 'ask',
    sources: ['docs/DSH_UI_ADOPTION.md', 'apps/codex-web/src/App.tsx', 'vendor/deepseek-harness-ui/UPSTREAM.md'],
    messages: [
      { id: 'u1', kind: 'user', turnId: 'turn-ui-shell', createdAt: now, text: '直接采用 DeepSeek Harness Desktop 的 UI。核心仍然是远程操控 Codex，不运行第二套 Harness。' },
      { id: 'r1', kind: 'reasoning', turnId: 'turn-ui-shell', createdAt: now, title: '分析前端供体', summary: '核验 Anywhere Labs 与官方 DSH 的源码边界', state: 'completed' },
      { id: 't1', kind: 'tool', turnId: 'turn-ui-shell', createdAt: now, title: '读取上游源码', summary: '固定 UI 源码与 MIT 许可', command: 'inspect vendor/deepseek-harness-ui', state: 'completed' },
      { id: 'a1', kind: 'assistant', turnId: 'turn-ui-shell', createdAt: now, markdown: '路线已经收缩为一条：**DSH-derived Web UI → Codex Plus Relay → Windows Companion → 官方 `codex app-server`**。\n\n前端保留上游的侧栏、对话流、输入器、模型与审批视觉；DSH Agent、Host、LLM、凭据、更新和遥测全部排除。' },
      { id: 'd1', kind: 'diff', turnId: 'turn-ui-shell', createdAt: now, files: [
        { path: 'docs/DSH_UI_ADOPTION.md', additions: 146, deletions: 0 },
        { path: 'apps/codex-web/src/App.tsx', additions: 328, deletions: 0 },
        { path: 'scripts/verify-dsh-ui-boundary.mjs', additions: 72, deletions: 0 },
      ] },
    ],
  },
  'mobile-flow': {
    ...snapshotBase(fixtureTasks[1], fixtureWorkspaces[0], approvalCapabilities),
    branch: 'main',
    model: 'gpt-5.6-terra',
    effort: 'high',
    permission: 'ask',
    sources: ['docs/MOBILE_UI.md'],
    messages: [
      { id: 'u2', kind: 'user', turnId: 'turn-mobile-flow', createdAt: now, text: '手机端要继续保留抽屉、底部面板、安全区和返回键。' },
      {
        id: 'approval-1',
        kind: 'approval',
        createdAt: now,
        taskId: 'mobile-flow',
        turnId: 'turn-mobile-flow',
        hostId: FIXTURE_HOST_ID,
        connectionGeneration: FIXTURE_GENERATION,
        requestId: 'approval-1',
        requestNonce: 'fixture-approval-1-once',
        issuedAt: now,
        expiresAt: requestExpiry,
        title: '请求运行测试',
        detail: '只批准本次命令；不会改变以后任务的权限。',
        command: 'pnpm codex-web:test',
        state: 'pending',
      },
      {
        id: 'question-1',
        kind: 'question',
        createdAt: now,
        taskId: 'mobile-flow',
        turnId: 'turn-mobile-flow',
        hostId: FIXTURE_HOST_ID,
        connectionGeneration: FIXTURE_GENERATION,
        requestId: 'question-1',
        requestNonce: 'fixture-question-1-once',
        issuedAt: now,
        expiresAt: requestExpiry,
        title: 'Codex 需要你的回答',
        detail: '选择本次任务的展示方式。',
        questions: [{
          id: 'layout',
          prompt: '使用哪种手机布局？',
          detail: '布局',
          choices: ['紧凑', '舒展'],
          allowFreeform: false,
        }],
        state: 'pending',
      },
    ],
  },
  adapter: {
    ...snapshotBase(fixtureTasks[2], fixtureWorkspaces[1], completedCapabilities),
    model: 'gpt-5.6-luna',
    effort: 'medium',
    permission: 'read-only',
    sources: ['packages/codex-serve-client/src/contracts.ts'],
    messages: [
      { id: 'u3', kind: 'user', createdAt: now, text: '定义一个不依赖 DSH Host 的前端接口。' },
      { id: 'a3', kind: 'assistant', createdAt: now, markdown: '`CodexServeClient` 已定义 task、stream、turn、interrupt、approval 和 question 的窄动作。' },
    ],
  },
  'offline-task': {
    ...snapshotBase(fixtureTasks[3], fixtureWorkspaces[2], noCapabilities),
    model: 'gpt-5.5',
    effort: 'medium',
    permission: 'read-only',
    sources: [],
    messages: [
      { id: 'u4', kind: 'user', createdAt: now, text: '电脑离线时保留最后一次快照。' },
      { id: 'a4', kind: 'assistant', createdAt: now, markdown: '这是缓存的只读快照。重新连接前不会发送任何动作。' },
    ],
  },
}

type StoredReceipt = StartTaskReceipt | PairingCreateReceipt
type WakeListener = () => void

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value)
}

function inputIsValid(input: UserInput[], attachments: InlineAttachment[] = []): boolean {
  const refs = input.filter((item): item is Exclude<UserInput, { type: 'text' }> => item.type !== 'text')
  const byId = new Map(attachments.map(attachment => [attachment.attachmentId, attachment]))
  return input.length > 0 && refs.length === attachments.length && input.every(item => {
    if (item.type === 'text') return typeof item.text === 'string'
    const attachment = byId.get(item.attachmentId)
    return item.attachmentId.trim().length > 0
      && item.name.trim().length > 0
      && attachment?.name === item.name
      && attachment.mediaType.trim().length > 0
      && attachment.byteLength > 0
      && /^[A-Za-z0-9_-]+$/.test(attachment.contentBase64Url)
  })
}

function settingsAreValid(settings: TurnSettings): boolean {
  return settings.model.trim().length > 0
    && ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(settings.effort)
    && ['ask', 'read-only', 'full-access'].includes(settings.permission)
}

function messageText(input: UserInput[]): string {
  return input.filter((item): item is Extract<UserInput, { type: 'text' }> => item.type === 'text').map(item => item.text).join('')
}

export interface FixturePlaybackOptions { simulateReplies?: boolean }

class FixtureCodexServeClient implements CodexServeClient {
  async listModels() {
    return [{ id: 'gpt-6-astra', displayName: 'GPT-6 Astra', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], isDefault: true }]
  }
  private readonly management = clone(fixtureManagementSnapshot)
  private readonly workspaces = clone(fixtureWorkspaces)
  private readonly tasks = clone(fixtureTasks)
  private readonly snapshots = clone(fixtureSnapshots)
  private readonly events = new Map<string, TaskEvent[]>()
  private readonly listeners = new Map<string, Set<WakeListener>>()
  private readonly receipts = new Map<string, { fingerprint: string; receipt: StoredReceipt }>()
  private readonly consumedRequestNonces = new Set<string>()

  constructor(private readonly playback: FixturePlaybackOptions = {}) {
    if (playback.simulateReplies) {
      const opening = this.snapshots['ui-shell']
      delete opening.activeTurnId; delete opening.task.activeTurnId
      opening.task.status = 'completed'; opening.task.completionReason = 'completed'
      this.syncTask(opening.task)
    }
    for (const snapshot of Object.values(this.snapshots)) {
      this.events.set(snapshot.task.id, [])
      this.listeners.set(snapshot.task.id, new Set())
      this.refreshCapabilities(snapshot)
    }
  }

  async readManagement(): Promise<ManagementSnapshot> {
    return clone(this.management)
  }

  async createPairing(input: PairingCreateInput): Promise<PairingCreateReceipt> {
    return this.runIdempotent(input.actionId, ['createPairing', input], (): PairingCreateReceipt => {
      const rejected = this.checkManagementHost(input.actionId, input.expected)
      if (rejected !== undefined) return rejected as PairingCreateReceipt
      return {
        actionId: input.actionId,
        state: 'accepted',
        invitationFragment: 'Zml4dHVyZS1wYWlyaW5nLWludml0YXRpb24',
        expiresAt: this.management.generatedAt + 120_000,
      }
    })
  }

  async renameDevice(input: RenameDeviceInput): Promise<ActionReceipt> {
    return this.runIdempotent(input.actionId, ['renameDevice', input], () => {
      const rejected = this.checkManagementHost(input.actionId, input.expected)
      if (rejected !== undefined) return rejected
      const device = this.management.devices.find(candidate => (
        candidate.deviceId === input.deviceId
        && candidate.authorizationId === input.authorizationId
        && candidate.authorizationEpoch === input.authorizationEpoch
      ))
      if (device === undefined || device.status !== 'active' || input.displayName.trim() !== input.displayName) {
        return this.reject(input.actionId, 'stale-host', 'The device authority changed.')
      }
      device.displayName = input.displayName
      return { actionId: input.actionId, state: 'accepted' }
    })
  }

  async revokeDevice(input: RevokeDeviceInput): Promise<ActionReceipt> {
    return this.runIdempotent(input.actionId, ['revokeDevice', input], () => {
      const rejected = this.checkManagementHost(input.actionId, input.expected)
      if (rejected !== undefined) return rejected
      const device = this.management.devices.find(candidate => (
        candidate.deviceId === input.deviceId
        && candidate.authorizationId === input.authorizationId
        && candidate.authorizationEpoch === input.authorizationEpoch
      ))
      if (device === undefined || device.status !== 'active') {
        return this.reject(input.actionId, 'stale-host', 'The device authority changed.')
      }
      if (device.isCurrent) {
        return this.reject(input.actionId, 'capability-denied', 'The current remote device cannot revoke itself.')
      }
      device.status = 'revoked'
      device.presence = 'offline'
      device.authorizationEpoch += 1
      return { actionId: input.actionId, state: 'accepted' }
    })
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return clone(this.workspaces)
  }

  async listTasks(_cursor?: string): Promise<TaskPage> {
    return { tasks: clone(this.tasks) }
  }

  async readTask(taskId: string): Promise<TaskSnapshot> {
    const snapshot = this.snapshots[taskId]
    if (snapshot === undefined) throw new Error(`Fixture CodexServeClient: unknown task ${taskId}`)
    this.refreshCapabilities(snapshot)
    return clone(snapshot)
  }

  async *subscribe(taskId: string, cursor?: string): AsyncIterable<TaskEvent> {
    const snapshot = this.snapshots[taskId]
    if (snapshot === undefined) throw new Error(`Fixture CodexServeClient: unknown task ${taskId}`)

    let nextSequence: number
    if (cursor === undefined) {
      this.refreshCapabilities(snapshot)
      yield this.snapshotEvent(snapshot)
      nextSequence = snapshot.sequence + 1
    } else {
      nextSequence = this.sequenceAfterCursor(taskId, cursor)
    }

    while (true) {
      const pending = (this.events.get(taskId) ?? []).filter(event => event.sequence >= nextSequence)
      if (pending.length > 0) {
        for (const event of pending) {
          nextSequence = event.sequence + 1
          yield clone(event)
        }
        continue
      }
      await this.waitForEvent(taskId)
    }
  }

  async startTask(input: StartTaskInput): Promise<StartTaskReceipt> {
    return this.runIdempotent(input.actionId, ['startTask', input], () => {
      const workspace = this.workspaces.find(candidate => candidate.id === input.workspaceId)
      if (workspace === undefined) return this.reject(input.actionId, 'unknown-workspace', 'The workspace is not in the authoritative list.')
      const hostRejection = this.checkHost(input.actionId, workspace, input.expected)
      if (hostRejection !== undefined) return hostRejection
      if (!workspace.capabilities.startTask) return this.reject(input.actionId, 'capability-denied', 'Starting a task is not currently allowed.')
      if (!inputIsValid(input.input, input.attachments) || !settingsAreValid(input.settings)) {
        return this.reject(input.actionId, 'invalid-input', 'The task input or turn settings are invalid.')
      }

      const taskId = `fixture-task-${input.actionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 48)}`
      const turnId = `fixture-turn-${input.actionId}`
      const createdAt = new Date().toISOString()
      const task: TaskSummary = {
        id: taskId,
        workspaceId: workspace.id,
        title: messageText(input.input).slice(0, 80) || '新任务',
        status: 'running',
        updatedAt: createdAt,
        revision: 1,
        activeTurnId: turnId,
      }
      const message: UserMessage = {
        id: `fixture-user-${input.actionId}`,
        kind: 'user',
        turnId,
        createdAt,
        text: messageText(input.input),
        input: clone(input.input),
      }
      const snapshot: TaskSnapshot = {
        authoritative: true,
        host: fixtureHost(workspace.connection),
        revision: 1,
        sequence: 1,
        cursor: cursorFor(taskId, 1),
        capabilities: clone(runningCapabilities),
        activeTurnId: turnId,
        task,
        workspace: clone(workspace),
        model: input.settings.model,
        effort: input.settings.effort,
        permission: input.settings.permission,
        messages: [message],
        sources: [],
      }
      this.tasks.unshift(task)
      this.snapshots[taskId] = snapshot
      this.events.set(taskId, [])
      this.listeners.set(taskId, new Set())
      this.simulateReply(snapshot, turnId)
      return this.accept(input.actionId, snapshot, task)
    })
  }

  async sendTurn(taskId: string, input: SendTurnInput): Promise<ActionReceipt> {
    return this.runIdempotent(input.actionId, ['sendTurn', taskId, input], () => {
      const checked = this.checkTask(taskId, input.actionId, input.expected, 'sendTurn')
      if ('state' in checked) return checked
      if (!inputIsValid(input.input, input.attachments) || !settingsAreValid(input.settings)) {
        return this.reject(input.actionId, 'invalid-input', 'The turn input or settings are invalid.')
      }

      const snapshot = checked
      const turnId = `fixture-turn-${input.actionId}`
      const message: UserMessage = {
        id: `fixture-user-${input.actionId}`,
        kind: 'user',
        turnId,
        createdAt: new Date().toISOString(),
        text: messageText(input.input),
        input: clone(input.input),
      }
      snapshot.activeTurnId = turnId
      snapshot.task.activeTurnId = turnId
      snapshot.task.status = 'running'
      delete snapshot.task.completionReason
      snapshot.model = input.settings.model
      snapshot.effort = input.settings.effort
      snapshot.permission = input.settings.permission
      snapshot.messages.push(message)
      this.bumpRevision(snapshot)
      this.refreshCapabilities(snapshot)
      this.emitMessage(snapshot, message)
      this.emitTask(snapshot)
      this.simulateReply(snapshot, turnId)
      return this.accept(input.actionId, snapshot)
    })
  }

  async steerTurn(taskId: string, input: SteerTurnInput): Promise<ActionReceipt> {
    return this.runIdempotent(input.actionId, ['steerTurn', taskId, input], () => {
      const checked = this.checkTask(taskId, input.actionId, input.expected, 'steerTurn')
      if ('state' in checked) return checked
      if (!inputIsValid(input.input, input.attachments) || checked.activeTurnId === undefined) {
        return this.reject(input.actionId, 'invalid-input', 'Steering requires valid input and an active turn.')
      }

      const message: UserMessage = {
        id: `fixture-steer-${input.actionId}`,
        kind: 'user',
        turnId: checked.activeTurnId,
        createdAt: new Date().toISOString(),
        text: messageText(input.input),
        input: clone(input.input),
      }
      checked.messages.push(message)
      this.bumpRevision(checked)
      this.refreshCapabilities(checked)
      this.emitMessage(checked, message)
      return this.accept(input.actionId, checked)
    })
  }

  private simulateReply(snapshot: TaskSnapshot, turnId: string): void {
    if (!this.playback.simulateReplies) return
    const text = '这是一段离线模拟回复，用来观察手机界面的消息增长、滚动和操作反馈。\n\n**交互细节**\n\n打开任务栏、选择项目，再切换任务。每个任务会保留各自的草稿和阅读位置。菜单从底部轻轻展开，关闭后焦点回到原来的按钮。\n\n**阅读与滚动**\n\n当你靠近最新消息时，对话会跟随新增内容；如果向上阅读历史，界面会停在当前位置，并显示“回到最新”。这些文字会逐步出现，不等待整段回复结束。\n\n**保持轻快**\n\n动效主要使用透明度和位移。输入框会随多行文字调整，减少动态模式会关闭装饰运动。\n\n你现在也可以切换模型、推理强度与权限，或者停止这段模拟回复；所有操作仅修改本地预览数据。\n\n模拟回复已完成。'
    const message: AssistantMessage = { id: `fixture-reply-${turnId}`, kind: 'assistant', turnId, createdAt: new Date().toISOString(), markdown: '' }
    let length = 0
    const tick = () => {
      if (snapshot.activeTurnId !== turnId) return
      if (length === 0) snapshot.messages.push(message)
      length = Math.min(text.length, length + 5)
      message.markdown = text.slice(0, length)
      this.emitMessage(snapshot, message)
      if (length < text.length) { setTimeout(tick, 35); return }
      delete snapshot.activeTurnId; delete snapshot.task.activeTurnId
      snapshot.task.status = 'completed'; snapshot.task.completionReason = 'completed'
      this.bumpRevision(snapshot); this.refreshCapabilities(snapshot); this.emitTask(snapshot)
    }
    setTimeout(tick, 240)
  }

  async interruptTurn(taskId: string, input: InterruptTurnInput): Promise<ActionReceipt> {
    return this.runIdempotent(input.actionId, ['interruptTurn', taskId, input], () => {
      const checked = this.checkTask(taskId, input.actionId, input.expected, 'interruptTurn')
      if ('state' in checked) return checked
      if (checked.activeTurnId === undefined || checked.activeTurnId !== input.turnId) {
        return this.reject(input.actionId, 'turn-owner-mismatch', 'The active turn no longer matches this interrupt request.')
      }

      const cancelled: InteractiveRequestMessage[] = []
      for (const message of checked.messages) {
        if ((message.kind === 'approval' || message.kind === 'question') && message.state === 'pending') {
          message.state = 'cancelled'
          this.consumedRequestNonces.add(message.requestNonce)
          cancelled.push(message)
        }
      }
      delete checked.activeTurnId
      delete checked.task.activeTurnId
      checked.task.status = 'completed'
      checked.task.completionReason = 'interrupted'
      this.bumpRevision(checked)
      this.refreshCapabilities(checked)
      for (const message of cancelled) this.emitMessage(checked, message)
      this.emitTask(checked)
      return this.accept(input.actionId, checked)
    })
  }

  async resolveRequest(request: ApprovalDecision | QuestionAnswer): Promise<ActionReceipt> {
    return this.runIdempotent(request.actionId, ['resolveRequest', request], () => {
      const snapshot = this.snapshots[request.taskId]
      if (snapshot === undefined) return this.reject(request.actionId, 'unknown-task', 'The task does not exist.')
      const message = snapshot.messages.find((candidate): candidate is InteractiveRequestMessage =>
        (candidate.kind === 'approval' || candidate.kind === 'question') && candidate.requestId === request.requestId,
      )
      if (message === undefined) return this.reject(request.actionId, 'request-not-found', 'The request is not in the authoritative snapshot.')
      if (!this.requestAuthorityIsCurrent(snapshot, message)) {
        return this.reject(request.actionId, 'request-owner-mismatch', 'The authoritative request is not owned by the current task, turn, or host generation.')
      }
      if (this.consumedRequestNonces.has(request.requestNonce) || message.state !== 'pending') {
        return this.reject(request.actionId, 'request-already-resolved', 'The request nonce has already been consumed.')
      }
      if (!this.requestAuthorityMatches(message, request)) {
        return this.reject(request.actionId, 'request-owner-mismatch', 'The request owner or nonce does not match the authoritative request.')
      }
      const expiry = Date.parse(message.expiresAt)
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        message.state = 'expired'
        this.consumedRequestNonces.add(message.requestNonce)
        this.bumpRevision(snapshot)
        this.refreshCapabilities(snapshot)
        this.emitMessage(snapshot, message)
        this.emitTask(snapshot)
        return this.reject(request.actionId, 'request-expired', 'The request has expired.')
      }

      const capability = request.type === 'approval' ? 'resolveApproval' : 'answerQuestion'
      const checked = this.checkTask(request.taskId, request.actionId, request.expected, capability)
      if ('state' in checked) return checked
      if (request.type === 'approval') {
        if (message.kind !== 'approval') {
          return this.reject(request.actionId, 'request-owner-mismatch', 'The response type does not match the request type.')
        }
        this.consumedRequestNonces.add(message.requestNonce)
        message.state = request.decision === 'approve-once' ? 'approved' : 'denied'
        if (request.decision === 'deny') {
          delete checked.activeTurnId
          delete checked.task.activeTurnId
          checked.task.status = 'completed'
          checked.task.completionReason = 'denied'
        } else {
          checked.task.status = 'running'
          delete checked.task.completionReason
        }
      } else {
        if (message.kind !== 'question') {
          return this.reject(request.actionId, 'request-owner-mismatch', 'The response type does not match the request type.')
        }
        if (!this.answersAreValid(message, request)) {
          return this.reject(request.actionId, 'invalid-input', 'Question answers do not match the authoritative prompts.')
        }
        this.consumedRequestNonces.add(message.requestNonce)
        message.state = 'answered'
        checked.task.status = 'running'
        delete checked.task.completionReason
      }
      this.bumpRevision(checked)
      this.refreshCapabilities(checked)
      this.emitMessage(checked, message)
      this.emitTask(checked)
      return this.accept(request.actionId, checked)
    })
  }

  private runIdempotent<T extends StoredReceipt>(actionId: string, payload: unknown, action: () => T): T {
    if (actionId.trim().length === 0) return this.reject(actionId, 'invalid-input', 'A non-empty actionId is required.') as T
    const valueFingerprint = fingerprint(payload)
    const existing = this.receipts.get(actionId)
    if (existing !== undefined) {
      if (existing.fingerprint === valueFingerprint) return clone(existing.receipt) as T
      return this.reject(actionId, 'action-id-conflict', 'The actionId was already used for a different action.') as T
    }
    const receipt = action()
    this.receipts.set(actionId, { fingerprint: valueFingerprint, receipt: clone(receipt) })
    return receipt
  }

  private checkHost(actionId: string, workspace: WorkspaceSummary, expected: ExpectedHostState): ActionReceipt | undefined {
    if (workspace.connection !== 'online') return this.reject(actionId, 'offline', 'The authoritative host is not online.')
    if (expected.hostId !== workspace.hostId) return this.reject(actionId, 'stale-host', 'The expected host does not own this workspace.')
    if (expected.connectionGeneration !== workspace.connectionGeneration) {
      return this.reject(actionId, 'stale-connection-generation', 'The host connection generation changed.')
    }
    return undefined
  }

  private checkManagementHost(actionId: string, expected: ExpectedHostState): ActionReceipt | undefined {
    if (expected.hostId !== this.management.hostId) {
      return this.reject(actionId, 'stale-host', 'The expected Host changed.')
    }
    if (expected.connectionGeneration !== this.management.connectionGeneration) {
      return this.reject(actionId, 'stale-connection-generation', 'The Host generation changed.')
    }
    return undefined
  }

  private checkTask(
    taskId: string,
    actionId: string,
    expected: ExpectedTaskState,
    capability: keyof TaskCapabilities,
  ): TaskSnapshot | ActionReceipt {
    const snapshot = this.snapshots[taskId]
    if (snapshot === undefined) return this.reject(actionId, 'unknown-task', 'The task does not exist.')
    if (!this.snapshotAuthorityIsConsistent(taskId, snapshot)) {
      return this.reject(actionId, 'capability-denied', 'Task ownership, revision, or host generation is ambiguous.')
    }
    if (snapshot.host.state !== 'online') return this.reject(actionId, 'offline', 'The authoritative host is not online.')
    if (expected.hostId !== snapshot.host.hostId) return this.reject(actionId, 'stale-host', 'The expected host does not own this task.')
    if (expected.connectionGeneration !== snapshot.host.generation) {
      return this.reject(actionId, 'stale-connection-generation', 'The host connection generation changed.')
    }
    if (expected.revision !== snapshot.revision) return this.reject(actionId, 'stale-task-revision', 'The task revision changed.')
    this.refreshCapabilities(snapshot)
    if (!snapshot.capabilities[capability]) return this.reject(actionId, 'capability-denied', `Capability ${capability} is not authoritative for this task.`)
    return snapshot
  }

  private requestAuthorityMatches(message: InteractiveRequestMessage, request: ApprovalDecision | QuestionAnswer): boolean {
    return request.taskId === message.taskId
      && request.turnId === message.turnId
      && request.hostId === message.hostId
      && request.connectionGeneration === message.connectionGeneration
      && request.requestNonce === message.requestNonce
      && request.issuedAt === message.issuedAt
      && request.expiresAt === message.expiresAt
  }

  private requestAuthorityIsCurrent(snapshot: TaskSnapshot, message: InteractiveRequestMessage): boolean {
    return message.taskId === snapshot.task.id
      && message.turnId === snapshot.activeTurnId
      && message.hostId === snapshot.host.hostId
      && message.connectionGeneration === snapshot.host.generation
  }

  private snapshotAuthorityIsConsistent(taskId: string, snapshot: TaskSnapshot): boolean {
    return snapshot.authoritative === true
      && snapshot.task.id === taskId
      && snapshot.task.revision === snapshot.revision
      && snapshot.task.activeTurnId === snapshot.activeTurnId
      && snapshot.workspace.hostId === snapshot.host.hostId
      && snapshot.workspace.connectionGeneration === snapshot.host.generation
      && snapshot.workspace.connection === snapshot.host.state
  }

  private answersAreValid(message: QuestionMessage, request: QuestionAnswer): boolean {
    if (request.answers.length !== message.questions.length) return false
    const expectedIds = new Set(message.questions.map(question => question.id))
    const actualIds = new Set(request.answers.map(answer => answer.questionId))
    if (actualIds.size !== request.answers.length || actualIds.size !== expectedIds.size) return false
    return request.answers.every(answer =>
      expectedIds.has(answer.questionId)
      && answer.values.length > 0
      && answer.values.every(value => typeof value === 'string'),
    )
  }

  private refreshCapabilities(snapshot: TaskSnapshot): void {
    if (snapshot.host.state !== 'online' || !this.snapshotAuthorityIsConsistent(snapshot.task.id, snapshot)) {
      snapshot.capabilities = clone(noCapabilities)
      return
    }
    const pendingApproval = snapshot.messages.some(message =>
      message.kind === 'approval'
      && message.state === 'pending'
      && this.requestAuthorityIsCurrent(snapshot, message)
      && !this.requestIsExpired(message),
    )
    const pendingQuestion = snapshot.messages.some(message =>
      message.kind === 'question'
      && message.state === 'pending'
      && this.requestAuthorityIsCurrent(snapshot, message)
      && !this.requestIsExpired(message),
    )
    const pendingRequest = pendingApproval || pendingQuestion
    const active = snapshot.activeTurnId !== undefined
    snapshot.capabilities = {
      sendTurn: !active && !pendingRequest,
      steerTurn: active && !pendingRequest,
      interruptTurn: active,
      resolveApproval: pendingApproval,
      answerQuestion: pendingQuestion,
    }
  }

  private requestIsExpired(message: InteractiveRequestMessage): boolean {
    const expiresAt = Date.parse(message.expiresAt)
    return !Number.isFinite(expiresAt) || expiresAt <= Date.now() || this.consumedRequestNonces.has(message.requestNonce)
  }

  private bumpRevision(snapshot: TaskSnapshot): void {
    snapshot.revision += 1
    snapshot.task.revision = snapshot.revision
    snapshot.task.updatedAt = new Date().toISOString()
    this.syncTask(snapshot.task)
  }

  private syncTask(task: TaskSummary): void {
    const index = this.tasks.findIndex(candidate => candidate.id === task.id)
    if (index >= 0) this.tasks[index] = clone(task)
  }

  private emitMessage(snapshot: TaskSnapshot, message: TaskMessage): void {
    const base = this.nextEventBase(snapshot)
    this.publish({ ...base, type: 'message', message: clone(message) })
  }

  private emitTask(snapshot: TaskSnapshot): void {
    const base = this.nextEventBase(snapshot)
    this.publish({
      ...base,
      type: 'task',
      task: clone(snapshot.task),
      capabilities: clone(snapshot.capabilities),
      ...(snapshot.activeTurnId === undefined ? {} : { activeTurnId: snapshot.activeTurnId }),
    })
  }

  private nextEventBase(snapshot: TaskSnapshot): Omit<TaskEvent, 'type'> {
    snapshot.sequence += 1
    snapshot.cursor = cursorFor(snapshot.task.id, snapshot.sequence)
    return {
      taskId: snapshot.task.id,
      hostId: snapshot.host.hostId,
      connectionGeneration: snapshot.host.generation,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      cursor: snapshot.cursor,
      createdAt: new Date().toISOString(),
    } as Omit<TaskEvent, 'type'>
  }

  private snapshotEvent(snapshot: TaskSnapshot): TaskEvent {
    return {
      taskId: snapshot.task.id,
      hostId: snapshot.host.hostId,
      connectionGeneration: snapshot.host.generation,
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      cursor: snapshot.cursor,
      createdAt: new Date().toISOString(),
      type: 'snapshot',
      snapshot: clone(snapshot),
    }
  }

  private publish(event: TaskEvent): void {
    this.events.get(event.taskId)?.push(event)
    for (const wake of this.listeners.get(event.taskId) ?? []) wake()
  }

  private waitForEvent(taskId: string): Promise<void> {
    return new Promise(resolve => {
      const listeners = this.listeners.get(taskId)
      if (listeners === undefined) {
        resolve()
        return
      }
      const wake = () => {
        listeners.delete(wake)
        resolve()
      }
      listeners.add(wake)
    })
  }

  private sequenceAfterCursor(taskId: string, cursor: string): number {
    const prefix = `fixture:${taskId}:`
    if (!cursor.startsWith(prefix)) throw new Error('Fixture CodexServeClient: cursor belongs to another task.')
    const sequence = Number(cursor.slice(prefix.length))
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Fixture CodexServeClient: malformed cursor.')
    const currentSequence = this.snapshots[taskId]?.sequence
    if (currentSequence === undefined || sequence > currentSequence) {
      throw new Error('Fixture CodexServeClient: cursor is ahead of the authoritative task stream.')
    }
    return sequence + 1
  }

  private reject(actionId: string, code: ActionRejectionCode, message: string): ActionReceipt {
    return { actionId, state: 'rejected', rejection: { code, message } }
  }

  private accept(actionId: string, snapshot: TaskSnapshot, task?: TaskSummary): StoredReceipt {
    return {
      actionId,
      state: 'accepted',
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      cursor: snapshot.cursor,
      ...(task === undefined ? {} : { task: clone(task) }),
    }
  }
}

export function createFixtureCodexServeClient(options: FixturePlaybackOptions = {}): CodexServeClient {
  return new FixtureCodexServeClient(options)
}
