import { randomUUID } from 'node:crypto'

import type {
  ActionReceipt,
  ApprovalDecision,
  ApprovalRequestMessage,
  QuestionAnswer,
  QuestionMessage,
  TaskMessage,
} from '../../../packages/codex-serve-client/src/index.ts'

import type {
  JsonValue,
  ServerRequest,
  ServerRequestDecision,
} from './supervisor.ts'

const MAX_LIVE_REQUESTS = 32
const MAX_TEXT = 16 * 1024
const DEFAULT_TTL_MS = 115_000

type ApprovalKind = 'command' | 'file' | 'permissions'

interface ApprovalPending {
  readonly kind: 'approval'
  readonly approvalKind: ApprovalKind
  readonly requestedPermissions?: JsonValue
  readonly title: string
  readonly detail: string
  readonly command?: string
}

interface QuestionSpec {
  readonly id: string
  readonly prompt: string
  readonly detail?: string
  readonly choices?: readonly string[]
  readonly allowFreeform: boolean
}

interface QuestionPending {
  readonly kind: 'question'
  readonly title: string
  readonly detail: string
  readonly questions: readonly QuestionSpec[]
}

interface PendingBase {
  readonly requestId: string
  readonly requestNonce: string
  readonly taskId: string
  readonly turnId: string
  readonly issuedAt: string
  readonly expiresAt: string
  readonly expiresAtMs: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (decision: ServerRequestDecision) => void
  boundHostId?: string
  boundGeneration?: number
  boundClientDeviceId?: string
  boundAuthorizationId?: string
}

type PendingRequest = PendingBase & (ApprovalPending | QuestionPending)

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeText(value: unknown, maximum = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function optionalText(value: unknown, maximum = MAX_TEXT): string | undefined {
  return value === null || value === undefined ? undefined : safeText(value, maximum)
}

function safeJson(value: unknown): JsonValue | undefined {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_TEXT) return undefined
    return JSON.parse(serialized) as JsonValue
  } catch {
    return undefined
  }
}

function commonParams(value: unknown): Readonly<{
  value: Record<string, unknown>
  taskId: string
  turnId: string
}> | undefined {
  const params = record(value)
  const taskId = safeText(params?.threadId, 128)
  const turnId = safeText(params?.turnId, 128)
  const itemId = safeText(params?.itemId, 128)
  if (
    params === undefined
    || taskId === undefined
    || turnId === undefined
    || itemId === undefined
    || !Number.isSafeInteger(params.startedAtMs)
    || (params.startedAtMs as number) < 0
  ) return undefined
  return { value: params, taskId, turnId }
}

function parseApproval(request: ServerRequest): Readonly<{
  taskId: string
  turnId: string
  value: ApprovalPending
}> | undefined {
  const common = commonParams(request.params)
  if (common === undefined) return undefined
  const reason = optionalText(common.value.reason) ?? 'Codex 请求确认本次操作。'
  if (request.method === 'item/commandExecution/requestApproval') {
    if (!onlyKeys(common.value, new Set([
      'threadId', 'turnId', 'itemId', 'startedAtMs', 'approvalId', 'environmentId',
      'reason', 'networkApprovalContext', 'command', 'cwd', 'commandActions',
      'proposedExecpolicyAmendment', 'proposedNetworkPolicyAmendments',
    ]))) return undefined
    const command = optionalText(common.value.command, 256 * 1024)
    return {
      taskId: common.taskId,
      turnId: common.turnId,
      value: {
        kind: 'approval',
        approvalKind: 'command',
        title: '命令执行请求',
        detail: reason,
        ...(command === undefined ? {} : { command }),
      },
    }
  }
  if (request.method === 'item/fileChange/requestApproval') {
    if (!onlyKeys(common.value, new Set([
      'threadId', 'turnId', 'itemId', 'startedAtMs', 'reason', 'grantRoot',
    ]))) return undefined
    return {
      taskId: common.taskId,
      turnId: common.turnId,
      value: {
        kind: 'approval',
        approvalKind: 'file',
        title: '文件修改请求',
        detail: reason,
      },
    }
  }
  if (request.method === 'item/permissions/requestApproval') {
    if (!onlyKeys(common.value, new Set([
      'threadId', 'turnId', 'itemId', 'startedAtMs', 'environmentId', 'cwd', 'reason', 'permissions',
    ]))) return undefined
    const requested = record(common.value.permissions)
    if (
      requested === undefined
      || !onlyKeys(requested, new Set(['network', 'fileSystem']))
      || !Object.hasOwn(requested, 'network')
      || !Object.hasOwn(requested, 'fileSystem')
    ) return undefined
    const permissions: Record<string, JsonValue> = {}
    for (const key of ['network', 'fileSystem'] as const) {
      if (requested[key] === null) continue
      const value = safeJson(requested[key])
      if (value === undefined || record(value) === undefined) return undefined
      permissions[key] = value
    }
    return {
      taskId: common.taskId,
      turnId: common.turnId,
      value: {
        kind: 'approval',
        approvalKind: 'permissions',
        requestedPermissions: permissions,
        title: '本轮附加权限请求',
        detail: reason,
      },
    }
  }
  return undefined
}

function parseQuestion(request: ServerRequest): Readonly<{
  taskId: string
  turnId: string
  value: QuestionPending
}> | undefined {
  if (request.method !== 'item/tool/requestUserInput') return undefined
  const common = commonParams(request.params)
  if (
    common === undefined
    || !onlyKeys(common.value, new Set([
      'threadId', 'turnId', 'itemId', 'startedAtMs', 'questions', 'isBlocking', 'autoResolutionMs',
    ]))
    || common.value.isBlocking !== true
    || !Array.isArray(common.value.questions)
  ) {
    return undefined
  }
  const source = common.value.questions
  if (source.length < 1 || source.length > 32) return undefined
  const ids = new Set<string>()
  const questions: QuestionSpec[] = []
  for (const value of source) {
    const question = record(value)
    const id = safeText(question?.id, 128)
    const header = safeText(question?.header, 256)
    const prompt = safeText(question?.question)
    if (
      question === undefined
      || !onlyKeys(question, new Set(['id', 'header', 'question', 'isOther', 'isSecret', 'options']))
      || id === undefined
      || header === undefined
      || prompt === undefined
      || question.isSecret !== false
      || typeof question.isOther !== 'boolean'
      || ids.has(id)
      || (question.options !== null && !Array.isArray(question.options))
    ) return undefined
    ids.add(id)
    let choices: string[] | undefined
    if (Array.isArray(question.options)) {
      if (question.options.length > 64) return undefined
      choices = []
      for (const optionValue of question.options) {
        const option = record(optionValue)
        const label = safeText(option?.label)
        if (
          option === undefined
          || !onlyKeys(option, new Set(['label', 'description']))
          || label === undefined
          || safeText(option.description) === undefined
        ) return undefined
        choices.push(label)
      }
      if (new Set(choices).size !== choices.length) return undefined
    }
    if ((choices === undefined || choices.length === 0) && question.isOther !== true) return undefined
    questions.push(Object.freeze({
      id,
      prompt,
      detail: header,
      ...(choices === undefined ? {} : { choices: Object.freeze(choices) }),
      allowFreeform: question.isOther,
    }))
  }
  return {
    taskId: common.taskId,
    turnId: common.turnId,
    value: {
      kind: 'question',
      title: 'Codex 需要你的回答',
      detail: '回答只发送给当前 Windows Companion 持有的任务。',
      questions: Object.freeze(questions),
    },
  }
}

function safeServerError(): ServerRequestDecision {
  return Object.freeze({ error: Object.freeze({ code: -32601, message: 'Server request is not supported.' }) })
}

function rejected(actionId: string, code: Extract<ActionReceipt, { state: 'rejected' }>['rejection']['code'], message: string): ActionReceipt {
  return Object.freeze({ actionId, state: 'rejected' as const, rejection: Object.freeze({ code, message }) })
}

export interface LiveRequestAuthority {
  handleServerRequest(request: ServerRequest): Promise<ServerRequestDecision>
  messagesForTask(input: Readonly<{
    taskId: string
    activeTurnId: string | null
    hostId: string
    connectionGeneration: number
    clientDeviceId: string
    authorizationId: string
  }>): readonly TaskMessage[]
  resolve(
    request: ApprovalDecision | QuestionAnswer,
    input: Readonly<{
      hostId: string
      connectionGeneration: number
      clientDeviceId: string
      authorizationId: string
    }>,
  ): ActionReceipt
  cancelTask(taskId: string, turnId: string): void
}

export function createLiveRequestAuthority(options: Readonly<{
  isTaskOwned: (taskId: string, turnId: string) => boolean
  now?: () => number
  ttlMs?: number
}>): LiveRequestAuthority {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000) throw new TypeError('Invalid live request TTL.')
  const pending = new Map<string, PendingRequest>()
  const consumedNonces = new Set<string>()

  const finish = (entry: PendingRequest, decision: ServerRequestDecision): void => {
    if (pending.get(entry.requestId) !== entry) return
    pending.delete(entry.requestId)
    clearTimeout(entry.timer)
    consumedNonces.add(entry.requestNonce)
    entry.resolve(decision)
  }

  const authority: LiveRequestAuthority = {
    async handleServerRequest(request) {
      const parsed = request.method === 'item/tool/requestUserInput'
        ? parseQuestion(request)
        : parseApproval(request)
      if (
        parsed === undefined
        || !options.isTaskOwned(parsed.taskId, parsed.turnId)
        || pending.size >= MAX_LIVE_REQUESTS
      ) return safeServerError()
      const issuedAtMs = now()
      if (!Number.isSafeInteger(issuedAtMs) || issuedAtMs < 0) return safeServerError()
      const requestId = `live.${randomUUID()}`
      const requestNonce = `nonce.${randomUUID()}`
      const expiresAtMs = issuedAtMs + ttlMs
      return await new Promise<ServerRequestDecision>(resolve => {
        const timer = setTimeout(() => {
          const entry = pending.get(requestId)
          if (entry !== undefined) finish(entry, safeServerError())
        }, ttlMs)
        const entry: PendingRequest = {
          ...parsed.value,
          requestId,
          requestNonce,
          taskId: parsed.taskId,
          turnId: parsed.turnId,
          issuedAt: new Date(issuedAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
          timer,
          resolve,
        }
        pending.set(requestId, entry)
      })
    },

    messagesForTask(input) {
      const at = now()
      const messages: TaskMessage[] = []
      for (const entry of pending.values()) {
        if (entry.expiresAtMs <= at) {
          finish(entry, safeServerError())
          continue
        }
        if (entry.taskId !== input.taskId || entry.turnId !== input.activeTurnId) continue
        if (entry.boundHostId === undefined) {
          entry.boundHostId = input.hostId
          entry.boundGeneration = input.connectionGeneration
          entry.boundClientDeviceId = input.clientDeviceId
          entry.boundAuthorizationId = input.authorizationId
        }
        if (
          entry.boundHostId !== input.hostId
          || entry.boundGeneration !== input.connectionGeneration
          || entry.boundClientDeviceId !== input.clientDeviceId
          || entry.boundAuthorizationId !== input.authorizationId
        ) continue
        const base = {
          id: entry.requestId,
          createdAt: entry.issuedAt,
          requestId: entry.requestId,
          taskId: entry.taskId,
          turnId: entry.turnId,
          hostId: input.hostId,
          connectionGeneration: input.connectionGeneration,
          requestNonce: entry.requestNonce,
          issuedAt: entry.issuedAt,
          expiresAt: entry.expiresAt,
          title: entry.title,
          detail: entry.detail,
          state: 'pending' as const,
        }
        if (entry.kind === 'approval') {
          const message: ApprovalRequestMessage = {
            ...base,
            kind: 'approval',
            ...(entry.command === undefined ? {} : { command: entry.command }),
          }
          messages.push(Object.freeze(message))
        } else {
          const message: QuestionMessage = {
            ...base,
            kind: 'question',
            questions: entry.questions.map(question => ({
              id: question.id,
              prompt: question.prompt,
              ...(question.detail === undefined ? {} : { detail: question.detail }),
              ...(question.choices === undefined ? {} : { choices: [...question.choices] }),
              allowFreeform: question.allowFreeform,
            })),
          }
          messages.push(Object.freeze(message))
        }
      }
      return Object.freeze(messages)
    },

    resolve(request, input) {
      const entry = pending.get(request.requestId)
      if (entry === undefined) {
        return rejected(
          request.actionId,
          consumedNonces.has(request.requestNonce) ? 'request-already-resolved' : 'request-not-found',
          'The live request is unavailable.',
        )
      }
      if (
        entry.boundHostId !== input.hostId
        || entry.boundGeneration !== input.connectionGeneration
        || entry.boundClientDeviceId !== input.clientDeviceId
        || entry.boundAuthorizationId !== input.authorizationId
        || entry.taskId !== request.taskId
        || entry.turnId !== request.turnId
        || entry.requestNonce !== request.requestNonce
        || entry.issuedAt !== request.issuedAt
        || entry.expiresAt !== request.expiresAt
      ) return rejected(request.actionId, 'request-owner-mismatch', 'The live request authority changed.')
      if (entry.expiresAtMs <= now()) {
        finish(entry, safeServerError())
        return rejected(request.actionId, 'request-expired', 'The live request expired.')
      }
      if (request.type === 'approval') {
        if (entry.kind !== 'approval') {
          return rejected(request.actionId, 'request-owner-mismatch', 'The response type changed.')
        }
        const decision: ServerRequestDecision = entry.approvalKind === 'permissions'
          ? request.decision === 'approve-once'
            ? {
                result: {
                  permissions: entry.requestedPermissions as JsonValue,
                  scope: 'turn',
                },
              }
            : { result: { permissions: {}, scope: 'turn' } }
          : { result: { decision: request.decision === 'approve-once' ? 'accept' : 'decline' } }
        finish(entry, decision)
        return Object.freeze({ actionId: request.actionId, state: 'accepted' as const })
      }
      if (entry.kind !== 'question') {
        return rejected(request.actionId, 'request-owner-mismatch', 'The response type changed.')
      }
      if (request.answers.length !== entry.questions.length) {
        return rejected(request.actionId, 'invalid-input', 'Every live question requires an answer.')
      }
      const answerMap: Record<string, JsonValue> = {}
      const seen = new Set<string>()
      for (const answer of request.answers) {
        const question = entry.questions.find(candidate => candidate.id === answer.questionId)
        if (question === undefined || seen.has(answer.questionId) || answer.values.length !== 1) {
          return rejected(request.actionId, 'invalid-input', 'The live answers do not match the questions.')
        }
        if (
          !question.allowFreeform
          && (question.choices === undefined || !answer.values.every(value => question.choices?.includes(value)))
        ) return rejected(request.actionId, 'invalid-input', 'The live answer is not allowed.')
        seen.add(answer.questionId)
        answerMap[answer.questionId] = { answers: [...answer.values] }
      }
      finish(entry, { result: { answers: answerMap } })
      return Object.freeze({ actionId: request.actionId, state: 'accepted' as const })
    },

    cancelTask(taskId, turnId) {
      for (const entry of [...pending.values()]) {
        if (entry.taskId === taskId && entry.turnId === turnId) finish(entry, safeServerError())
      }
    },
  }
  return Object.freeze(authority)
}
