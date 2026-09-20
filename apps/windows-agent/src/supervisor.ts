import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { TextDecoder, types as nodeTypes } from 'node:util'

import {
  evaluateRuntimeBindingSource,
  isRuntimeCompatibilityCurrent,
  isSafeAbsoluteWindowsPath,
  type RuntimeBindingEvaluation,
  type RuntimeBindingSource,
  type RuntimeCompatibility,
} from './runtime-binding.ts'

export const APP_SERVER_METHODS = Object.freeze([
  'model/list',
  'thread/list',
  'thread/read',
  'thread/turns/list',
  'thread/loaded/list',
  'thread/start',
  'thread/resume',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
] as const)

export const HANDLED_SERVER_REQUEST_METHODS = Object.freeze([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
] as const)

export type AppServerMethod = (typeof APP_SERVER_METHODS)[number]
export type HandledServerRequestMethod = (typeof HANDLED_SERVER_REQUEST_METHODS)[number]
export type SupervisorState =
  | 'idle'
  | 'starting'
  | 'initializing'
  | 'ready'
  | 'closing'
  | 'closed'
  | 'failed'

export interface ChildCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd?: string
}

export interface ClientInfo {
  readonly name: string
  readonly title: string
  readonly version: string
}

export interface InitializeResult {
  readonly userAgent: string
  readonly platformFamily: string
  readonly platformOs: string
}

export interface Notification {
  readonly method: string
  readonly params?: unknown
}

export type NotificationListener = (notification: Notification) => void

export interface ServerRequest {
  readonly id: number | string
  readonly method: HandledServerRequestMethod
  readonly params?: unknown
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type ServerRequestDecision =
  | { readonly result: JsonValue }
  | {
      readonly error: {
        readonly code: number
        readonly message: string
        readonly data?: JsonValue
      }
    }

export type ServerRequestHandler = (
  request: ServerRequest,
) => ServerRequestDecision | Promise<ServerRequestDecision>

export interface SupervisorLimits {
  readonly maxLineBytes?: number
  readonly maxStderrBytes?: number
  readonly maxPendingRequests?: number
  readonly maxPendingServerRequests?: number
  readonly maxNotificationSubscribers?: number
  readonly maxBufferedNotifications?: number
  readonly maxWriteQueueBytes?: number
  readonly maxWriteQueueFrames?: number
  readonly initializationTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly serverRequestTimeoutMs?: number
  readonly shutdownGraceMs?: number
}

export type SupervisorLogEvent =
  | {
      readonly event: 'lifecycle'
      readonly generation: number
      readonly state: SupervisorState
      readonly outcome: 'entered' | 'failed'
      readonly code?: ErrorCode
      readonly detail?: ProtocolFailureDetail
      readonly pendingMethod?: AppServerMethod | 'initialize'
    }
  | {
      readonly event: 'request'
      readonly generation: number
      readonly method: AppServerMethod | 'initialize'
      readonly requestId: number
      readonly outcome: 'succeeded' | 'failed' | 'timed-out'
      readonly durationMs: number
    }
  | {
      readonly event: 'server-request'
      readonly generation: number
      readonly method: HandledServerRequestMethod | 'unsupported'
      readonly outcome: 'answered' | 'rejected'
    }

export interface SupervisorConfig {
  readonly command: ChildCommand
  readonly clientInfo: ClientInfo
  readonly allowedMethods: readonly AppServerMethod[]
  readonly limits?: SupervisorLimits
  readonly onServerRequest?: ServerRequestHandler
  readonly logger?: (event: SupervisorLogEvent) => void
}

type ErrorCode =
  | 'invalid-config'
  | 'invalid-state'
  | 'method-not-allowed'
  | 'capacity-exceeded'
  | 'request-timeout'
  | 'child-spawn-failed'
  | 'child-exited'
  | 'protocol-error'
  | 'write-failed'
  | 'closed'

type ProtocolFailureDetail =
  | 'stdout-incomplete-line'
  | 'stdout-line-too-large'
  | 'stdout-empty-line'
  | 'stdout-invalid-utf8'
  | 'stderr-too-large'
  | 'stdout-invalid-json'
  | 'stdout-invalid-object'
  | 'stdout-invalid-message'
  | 'response-invalid-id'
  | 'response-unexpected-id'
  | 'response-invalid-error'
  | 'response-invalid-result'
  | 'notification-before-initialize'
  | 'notification-overflow'

export class AppServerSupervisorError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'AppServerSupervisorError'
  }
}

export class AppServerRpcError extends Error {
  constructor(readonly code: number) {
    super('The app-server rejected the request.')
    this.name = 'AppServerRpcError'
  }
}

const CEILINGS = Object.freeze({
  maxLineBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  maxPendingRequests: 128,
  maxPendingServerRequests: 32,
  maxNotificationSubscribers: 32,
  maxBufferedNotifications: 512,
  maxWriteQueueBytes: 1024 * 1024,
  maxWriteQueueFrames: 128,
  initializationTimeoutMs: 30_000,
  requestTimeoutMs: 120_000,
  serverRequestTimeoutMs: 120_000,
  shutdownGraceMs: 10_000,
})

type EffectiveLimits = { [Key in keyof typeof CEILINGS]: number }

type PendingRequest = {
  readonly method: AppServerMethod | 'initialize'
  readonly startedAt: number
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
}

type WriteEntry = {
  readonly bytes: number
  readonly frame: string
  readonly resolve: () => void
  readonly reject: (reason: unknown) => void
}

type BoundTurnInput =
  | Readonly<{
      type: 'text'
      text: string
      text_elements: readonly Readonly<{
        byteRange: Readonly<{ start: number; end: number }>
        placeholder: string | null
      }>[]
    }>
  | Readonly<{ type: 'localImage'; path: string }>
  | Readonly<{ type: 'mention'; name: string; path: string }>

type BoundRuntimeWrite =
  | {
      readonly operation: 'list-loaded-threads'
      readonly limit: number
    }
  | {
      readonly operation: 'resume-thread'
      readonly threadId: string
    }
  | {
      readonly operation: 'start-thread'
      readonly cwd: string
      readonly model: string
      readonly permission: 'ask' | 'read-only' | 'full-access'
    }
  | {
      readonly operation: 'start-text-turn'
      readonly threadId: string
      readonly actionId: string
      readonly inputs: readonly BoundTurnInput[]
      readonly model: string
      readonly effort: string
      readonly permission: 'ask' | 'read-only' | 'full-access'
    }
  | {
      readonly operation: 'steer-text-turn'
      readonly threadId: string
      readonly turnId: string
      readonly actionId: string
      readonly inputs: readonly BoundTurnInput[]
    }
  | {
      readonly operation: 'interrupt-turn'
      readonly threadId: string
      readonly turnId: string
    }

const BOUND_RUNTIME_WRITE = Symbol('bound-runtime-write')

type InitializeEvidence = {
  readonly userAgent: string
  readonly platformFamily: string
  readonly platformOs: string
  readonly codexHomeValidated: true
}

type StrictInitializeSnapshot = {
  readonly result: InitializeResult
  readonly evidence: InitializeEvidence
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const APP_SERVER_METHOD_SET: ReadonlySet<string> = new Set(APP_SERVER_METHODS)
const READ_DISPATCH_METHOD_SET: ReadonlySet<AppServerMethod> = new Set([
  'model/list',
  'thread/list',
  'thread/read',
  'thread/turns/list',
])
const HANDLED_SERVER_REQUEST_METHOD_SET: ReadonlySet<string> = new Set(
  HANDLED_SERVER_REQUEST_METHODS,
)
let generationCounter = 0

function own(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRpcId(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256)
  )
}

function isJsonValue(
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: 131_072 },
): value is JsonValue {
  budget.remaining -= 1
  if (depth > 64 || budget.remaining < 0) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8') <= CEILINGS.maxLineBytes
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    if (value.length > 131_072 || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !own(descriptor, 'value')) return false
      if (!isJsonValue(descriptor.value, depth + 1, budget)) return false
    }
    return true
  }
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length > 131_072) return false
  for (const key of keys) {
    if (typeof key !== 'string' || Buffer.byteLength(key, 'utf8') > CEILINGS.maxLineBytes) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !own(descriptor, 'value')) return false
    if (!isJsonValue(descriptor.value, depth + 1, budget)) return false
  }
  return true
}

function positiveBoundedInteger(
  name: keyof EffectiveLimits,
  value: number | undefined,
): number {
  const ceiling = CEILINGS[name]
  const selected = value ?? ceiling
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > ceiling) {
    throw new AppServerSupervisorError(
      'invalid-config',
      `Supervisor limit ${name} must be a positive integer no greater than its fixed ceiling.`,
    )
  }
  return selected
}

function normalizeLimits(limits: SupervisorLimits | undefined): EffectiveLimits {
  return {
    maxLineBytes: positiveBoundedInteger('maxLineBytes', limits?.maxLineBytes),
    maxStderrBytes: positiveBoundedInteger('maxStderrBytes', limits?.maxStderrBytes),
    maxPendingRequests: positiveBoundedInteger(
      'maxPendingRequests',
      limits?.maxPendingRequests,
    ),
    maxPendingServerRequests: positiveBoundedInteger(
      'maxPendingServerRequests',
      limits?.maxPendingServerRequests,
    ),
    maxNotificationSubscribers: positiveBoundedInteger(
      'maxNotificationSubscribers',
      limits?.maxNotificationSubscribers,
    ),
    maxBufferedNotifications: positiveBoundedInteger(
      'maxBufferedNotifications',
      limits?.maxBufferedNotifications,
    ),
    maxWriteQueueBytes: positiveBoundedInteger(
      'maxWriteQueueBytes',
      limits?.maxWriteQueueBytes,
    ),
    maxWriteQueueFrames: positiveBoundedInteger(
      'maxWriteQueueFrames',
      limits?.maxWriteQueueFrames,
    ),
    initializationTimeoutMs: positiveBoundedInteger(
      'initializationTimeoutMs',
      limits?.initializationTimeoutMs,
    ),
    requestTimeoutMs: positiveBoundedInteger('requestTimeoutMs', limits?.requestTimeoutMs),
    serverRequestTimeoutMs: positiveBoundedInteger(
      'serverRequestTimeoutMs',
      limits?.serverRequestTimeoutMs,
    ),
    shutdownGraceMs: positiveBoundedInteger('shutdownGraceMs', limits?.shutdownGraceMs),
  }
}

function assertShortNonempty(name: string, value: string, maxBytes: number): void {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new AppServerSupervisorError(
      'invalid-config',
      `${name} must be a non-empty string within its fixed byte limit.`,
    )
  }
}

function snapshotDenseDataArray(value: unknown, maxItems: number): readonly unknown[] | undefined {
  if (
    nodeTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return undefined
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined ||
    !own(lengthDescriptor, 'value') ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0 ||
    (lengthDescriptor.value as number) > maxItems ||
    Reflect.ownKeys(value).length !== (lengthDescriptor.value as number) + 1
  ) {
    return undefined
  }
  const snapshot: unknown[] = []
  for (let index = 0; index < (lengthDescriptor.value as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !descriptor.enumerable || !own(descriptor, 'value')) {
      return undefined
    }
    snapshot.push(descriptor.value)
  }
  return Object.freeze(snapshot)
}

function normalizeConfig(config: SupervisorConfig): {
  command: ChildCommand
  clientInfo: ClientInfo
  allowedMethods: ReadonlySet<AppServerMethod>
  limits: EffectiveLimits
  onServerRequest?: ServerRequestHandler
  logger?: (event: SupervisorLogEvent) => void
} {
  try {
    const configProperties = readPlainDataProperties(config)
    const configKeys = new Set([
      'command',
      'clientInfo',
      'allowedMethods',
      'limits',
      'onServerRequest',
      'logger',
    ])
    if (
      configProperties === undefined ||
      !configProperties.has('command') ||
      !configProperties.has('clientInfo') ||
      !configProperties.has('allowedMethods') ||
      [...configProperties.keys()].some(
        (key) => typeof key !== 'string' || !configKeys.has(key),
      )
    ) {
      throw new AppServerSupervisorError('invalid-config', 'Supervisor configuration is invalid.')
    }

    const commandProperties = readPlainDataProperties(configProperties.get('command'))
    const commandKeys = new Set(['executable', 'args', 'cwd'])
    if (
      commandProperties === undefined ||
      commandProperties.size < 2 ||
      commandProperties.size > 3 ||
      !commandProperties.has('executable') ||
      !commandProperties.has('args') ||
      [...commandProperties.keys()].some(
        (key) => typeof key !== 'string' || !commandKeys.has(key),
      )
    ) {
      throw new AppServerSupervisorError('invalid-config', 'An explicit child command is required.')
    }
    const executable = commandProperties.get('executable')
    const args = snapshotDenseDataArray(commandProperties.get('args'), 128)
    const cwd = commandProperties.get('cwd')
    assertShortNonempty('command.executable', executable as string, 32 * 1024)
    if (args === undefined) {
      throw new AppServerSupervisorError('invalid-config', 'Child command arguments are invalid.')
    }
    for (const arg of args) assertShortNonempty('command.args item', arg as string, 32 * 1024)
    if (cwd !== undefined) assertShortNonempty('command.cwd', cwd as string, 32 * 1024)

    const clientProperties = readPlainDataProperties(configProperties.get('clientInfo'))
    if (
      clientProperties === undefined ||
      clientProperties.size !== 3 ||
      !clientProperties.has('name') ||
      !clientProperties.has('title') ||
      !clientProperties.has('version') ||
      [...clientProperties.keys()].some(
        (key) => (
          typeof key !== 'string' ||
          (key !== 'name' && key !== 'title' && key !== 'version')
        ),
      )
    ) {
      throw new AppServerSupervisorError('invalid-config', 'Client metadata is invalid.')
    }
    const name = clientProperties.get('name')
    const title = clientProperties.get('title')
    const version = clientProperties.get('version')
    assertShortNonempty('clientInfo.name', name as string, 128)
    assertShortNonempty('clientInfo.title', title as string, 256)
    assertShortNonempty('clientInfo.version', version as string, 128)
    if (name !== 'codex_plus') {
      throw new AppServerSupervisorError(
        'invalid-config',
        'The app-server client identity must be codex_plus.',
      )
    }

    const allowedMethodValues = snapshotDenseDataArray(
      configProperties.get('allowedMethods'),
      APP_SERVER_METHODS.length,
    )
    if (allowedMethodValues === undefined || allowedMethodValues.length === 0) {
      throw new AppServerSupervisorError('invalid-config', 'A non-empty method allowlist is required.')
    }
    const allowedMethods = new Set<AppServerMethod>()
    for (const method of allowedMethodValues) {
      if (typeof method !== 'string' || !APP_SERVER_METHOD_SET.has(method)) {
        throw new AppServerSupervisorError(
          'invalid-config',
          'The method allowlist contains an unknown method.',
        )
      }
      allowedMethods.add(method as AppServerMethod)
    }

    const limitValue = configProperties.get('limits')
    let limits: SupervisorLimits | undefined
    if (limitValue !== undefined) {
      const limitProperties = readPlainDataProperties(limitValue)
      if (
        limitProperties === undefined ||
        [...limitProperties.keys()].some(
          (key) => typeof key !== 'string' || !own(CEILINGS, key),
        )
      ) {
        throw new AppServerSupervisorError('invalid-config', 'Supervisor limits are invalid.')
      }
      const snapshot: Record<string, number | undefined> = {}
      for (const [key, value] of limitProperties) {
        if (typeof key !== 'string' || (value !== undefined && typeof value !== 'number')) {
          throw new AppServerSupervisorError('invalid-config', 'Supervisor limits are invalid.')
        }
        snapshot[key] = value as number | undefined
      }
      limits = Object.freeze(snapshot) as SupervisorLimits
    }

    const onServerRequest = configProperties.get('onServerRequest')
    const logger = configProperties.get('logger')
    if (onServerRequest !== undefined && typeof onServerRequest !== 'function') {
      throw new AppServerSupervisorError('invalid-config', 'The server-request handler must be callable.')
    }
    if (logger !== undefined && typeof logger !== 'function') {
      throw new AppServerSupervisorError('invalid-config', 'The logger must be callable.')
    }
    return {
      command: Object.freeze({
        executable: executable as string,
        args: Object.freeze(args as readonly string[]),
        ...(cwd === undefined ? {} : { cwd: cwd as string }),
      }),
      clientInfo: Object.freeze({
        name: name as string,
        title: title as string,
        version: version as string,
      }),
      allowedMethods,
      limits: normalizeLimits(limits),
      ...(onServerRequest === undefined ? {} : { onServerRequest: onServerRequest as ServerRequestHandler }),
      ...(logger === undefined ? {} : { logger: logger as (event: SupervisorLogEvent) => void }),
    }
  } catch (error) {
    if (error instanceof AppServerSupervisorError) throw error
    throw new AppServerSupervisorError('invalid-config', 'Supervisor configuration is invalid.')
  }
}

const SAFE_SERVER_ERROR: ServerRequestDecision = Object.freeze({
  error: Object.freeze({ code: -32601, message: 'Server request is not supported.' }),
})

function safeServerError(): ServerRequestDecision {
  return SAFE_SERVER_ERROR
}

function snapshotServerRequestDecision(value: unknown): ServerRequestDecision | undefined {
  const properties = readPlainDataProperties(value)
  if (properties === undefined || properties.size !== 1) return undefined
  if (properties.has('result')) {
    const result = properties.get('result')
    return isJsonValue(result) ? Object.freeze({ result }) : undefined
  }
  const errorProperties = readPlainDataProperties(properties.get('error'))
  if (
    errorProperties === undefined
    || errorProperties.size < 2
    || errorProperties.size > 3
    || [...errorProperties.keys()].some(key => key !== 'code' && key !== 'message' && key !== 'data')
  ) return undefined
  const code = errorProperties.get('code')
  const message = errorProperties.get('message')
  const data = errorProperties.get('data')
  if (
    !Number.isSafeInteger(code)
    || typeof message !== 'string'
    || message.length < 1
    || Buffer.byteLength(message, 'utf8') > 512
    || (errorProperties.has('data') && !isJsonValue(data))
  ) return undefined
  return Object.freeze({
    error: Object.freeze({
      code: code as number,
      message,
      ...(errorProperties.has('data') ? { data: data as JsonValue } : {}),
    }),
  })
}

function readPlainDataProperties(value: unknown): Map<PropertyKey, unknown> | undefined {
  if (nodeTypes.isProxy(value) || !isRecord(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length > 131_072) return undefined
  const properties = new Map<PropertyKey, unknown>()
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !own(descriptor, 'value')) {
      return undefined
    }
    properties.set(key, descriptor.value)
  }
  return properties
}

function snapshotInitializeResult(value: unknown): StrictInitializeSnapshot | undefined {
  try {
    const properties = readPlainDataProperties(value)
    const expectedKeys = new Set(['userAgent', 'codexHome', 'platformFamily', 'platformOs'])
    if (
      properties === undefined ||
      properties.size !== expectedKeys.size ||
      [...properties.keys()].some(
        (key) => typeof key !== 'string' || !expectedKeys.has(key),
      )
    ) {
      return undefined
    }
    const userAgent = properties.get('userAgent')
    const codexHome = properties.get('codexHome')
    const platformFamily = properties.get('platformFamily')
    const platformOs = properties.get('platformOs')
    if (
      typeof userAgent !== 'string' ||
      userAgent.length === 0 ||
      Buffer.byteLength(userAgent, 'utf8') > 4 * 1024 ||
      typeof codexHome !== 'string' ||
      Buffer.byteLength(codexHome, 'utf8') > 32 * 1024 ||
      !isSafeAbsoluteWindowsPath(codexHome) ||
      typeof platformFamily !== 'string' ||
      platformFamily.length === 0 ||
      Buffer.byteLength(platformFamily, 'utf8') > 128 ||
      typeof platformOs !== 'string' ||
      platformOs.length === 0 ||
      Buffer.byteLength(platformOs, 'utf8') > 128
    ) {
      return undefined
    }
    const result = Object.freeze({ userAgent, platformFamily, platformOs })
    const evidence = Object.freeze({
      userAgent,
      platformFamily,
      platformOs,
      codexHomeValidated: true as const,
    })
    return Object.freeze({ result, evidence })
  } catch {
    return undefined
  }
}

/** Package-private strict parser seam. It is deliberately absent from src/index.ts. */
export function isStrictInitializeResultForTest(value: unknown): boolean {
  return snapshotInitializeResult(value) !== undefined
}

export class AppServerSupervisor {
  readonly generation: number

  private readonly config: ReturnType<typeof normalizeConfig>
  private currentState: SupervisorState = 'idle'
  private child: ChildProcessWithoutNullStreams | undefined
  private childExited = true
  private nextRequestId = 1
  private initializedFrameQueued = false
  private stdoutBuffer = Buffer.alloc(0)
  private stderrBytes = 0
  private pending = new Map<number, PendingRequest>()
  private pendingServerRequestKeys = new Set<string>()
  private listeners = new Set<NotificationListener>()
  private bufferedNotifications: Notification[] = []
  private writeQueue: WriteEntry[] = []
  private writeQueueBytes = 0
  private writeActive = false
  private activeWrite: WriteEntry | undefined
  private closePromise: Promise<void> | undefined
  private resolveChildExit: (() => void) | undefined
  private initializeEvidence: InitializeEvidence | undefined

  constructor(config: SupervisorConfig) {
    this.config = normalizeConfig(config)
    generationCounter += 1
    if (!Number.isSafeInteger(generationCounter)) generationCounter = 1
    this.generation = generationCounter
  }

  get state(): SupervisorState {
    return this.currentState
  }

  get ownsLiveChild(): boolean {
    return this.child !== undefined && !this.childExited
  }

  async start(): Promise<InitializeResult> {
    if (this.currentState !== 'idle') {
      throw new AppServerSupervisorError('invalid-state', 'The supervisor can only be started once.')
    }
    this.setState('starting')
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.config.command.executable, [...this.config.command.args], {
        ...(this.config.command.cwd === undefined ? {} : { cwd: this.config.command.cwd }),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      this.failWithoutChild('child-spawn-failed')
      throw new AppServerSupervisorError('child-spawn-failed', 'The owned app-server child could not start.')
    }
    this.child = child
    this.childExited = false
    this.attachChild(child)
    this.setState('initializing')

    try {
      const result = await this.sendRequest(
        'initialize',
        {
          clientInfo: this.config.clientInfo,
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
          },
        },
        this.config.limits.initializationTimeoutMs,
      )
      const snapshot = snapshotInitializeResult(result)
      if (snapshot === undefined) throw new Error('invalid initialize result')
      this.initializedFrameQueued = true
      await this.enqueueFrame({ method: 'initialized' })
      if ((this.currentState as SupervisorState) !== 'initializing' || this.childExited) {
        throw new Error('initialization lifecycle changed')
      }
      this.initializeEvidence = snapshot.evidence
      this.setState('ready')
      return snapshot.result
    } catch (error) {
      const failedState = this.currentState as SupervisorState
      if (failedState !== 'failed' && failedState !== 'closing' && failedState !== 'closed') {
        this.failClosed('protocol-error', 'stdout-incomplete-line')
      }
      if (error instanceof AppServerSupervisorError || error instanceof AppServerRpcError) throw error
      throw new AppServerSupervisorError('protocol-error', 'The app-server initialization failed closed.')
    }
  }

  /** @internal Runtime bindings are issued only through establishRuntimeCompatibility(). */
  async evaluateRuntimeCompatibility(requester: object): Promise<RuntimeBindingEvaluation> {
    const evidence = this.initializeEvidence
    const source: RuntimeBindingSource = Object.freeze({
      owner: this,
      generation: this.generation,
      command: this.config.command,
      ...(evidence === undefined ? {} : { initialize: evidence }),
      isCurrent: () => (
        this.currentState === 'ready' &&
        this.child !== undefined &&
        !this.childExited &&
        this.initializeEvidence === evidence
      ),
    })
    return evaluateRuntimeBindingSource(requester, source)
  }

  async request<Result = unknown>(method: AppServerMethod, params: unknown): Promise<Result> {
    if (this.currentState !== 'ready') {
      throw new AppServerSupervisorError('invalid-state', 'The app-server is not ready.')
    }
    if (!this.config.allowedMethods.has(method)) {
      throw new AppServerSupervisorError('method-not-allowed', 'The app-server method is not allowed.')
    }
    if (!READ_DISPATCH_METHOD_SET.has(method)) {
      throw new AppServerSupervisorError(
        'method-not-allowed',
        'Mutating app-server methods remain disabled until durable action authority exists.',
      )
    }
    return (await this.sendRequest(method, params, this.config.limits.requestTimeoutMs)) as Result
  }

  /** @internal Called only by the package-private text-turn adapter below. */
  async [BOUND_RUNTIME_WRITE](
    compatibility: RuntimeCompatibility,
    write: BoundRuntimeWrite,
  ): Promise<unknown> {
    if (!isRuntimeCompatibilityCurrent(this, compatibility)) {
      throw new AppServerSupervisorError('invalid-state', 'The runtime compatibility is not current.')
    }
    const method: AppServerMethod = write.operation === 'list-loaded-threads'
      ? 'thread/loaded/list'
      : write.operation === 'resume-thread'
        ? 'thread/resume'
      : write.operation === 'start-thread'
        ? 'thread/start'
      : write.operation === 'start-text-turn'
        ? 'turn/start'
      : write.operation === 'steer-text-turn'
        ? 'turn/steer'
        : 'turn/interrupt'
    if (!this.config.allowedMethods.has(method)) {
      throw new AppServerSupervisorError('method-not-allowed', 'The app-server method is not allowed.')
    }
    const params = write.operation === 'list-loaded-threads'
      ? Object.freeze({ limit: write.limit })
      : write.operation === 'resume-thread'
        ? Object.freeze({ threadId: write.threadId, excludeTurns: true })
      : write.operation === 'start-thread'
        ? Object.freeze({
            cwd: write.cwd,
            model: write.model,
            serviceName: 'codex_plus',
            approvalPolicy: write.permission === 'ask' ? 'on-request' : 'never',
            sandbox: write.permission === 'read-only'
              ? 'read-only'
              : write.permission === 'full-access' ? 'danger-full-access' : 'workspace-write',
          })
      : write.operation === 'start-text-turn'
        ? Object.freeze({
          threadId: write.threadId,
          clientUserMessageId: write.actionId,
          input: write.inputs,
          model: write.model,
          effort: write.effort,
          ...(write.permission === 'read-only'
            ? {
                approvalPolicy: 'never',
                sandboxPolicy: Object.freeze({ type: 'readOnly', networkAccess: false }),
              }
            : write.permission === 'full-access'
              ? {
                  approvalPolicy: 'never',
                  sandboxPolicy: Object.freeze({ type: 'dangerFullAccess' }),
                }
              : {
                  approvalPolicy: 'on-request',
                  sandboxPolicy: Object.freeze({
                    type: 'workspaceWrite',
                    writableRoots: Object.freeze([]),
                    networkAccess: false,
                    excludeTmpdirEnvVar: false,
                    excludeSlashTmp: false,
                  }),
                }),
          })
      : write.operation === 'steer-text-turn'
        ? Object.freeze({
            threadId: write.threadId,
            expectedTurnId: write.turnId,
            clientUserMessageId: write.actionId,
            input: write.inputs,
          })
        : Object.freeze({ threadId: write.threadId, turnId: write.turnId })
    return this.sendRequest(method, params, this.config.limits.requestTimeoutMs)
  }

  onNotification(listener: NotificationListener): () => void {
    if (typeof listener !== 'function') {
      throw new AppServerSupervisorError('invalid-config', 'The notification listener must be callable.')
    }
    if (this.currentState === 'closing' || this.currentState === 'closed' || this.currentState === 'failed') {
      throw new AppServerSupervisorError('invalid-state', 'The supervisor cannot accept subscribers.')
    }
    if (this.listeners.size >= this.config.limits.maxNotificationSubscribers) {
      throw new AppServerSupervisorError('capacity-exceeded', 'The notification subscriber limit was reached.')
    }
    this.listeners.add(listener)
    const buffered = this.bufferedNotifications
    this.bufferedNotifications = []
    for (const notification of buffered) this.invokeListener(listener, notification)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.performClose()
    return this.closePromise
  }

  private async performClose(): Promise<void> {
    if (this.currentState === 'closed') return
    if (this.currentState === 'idle') {
      this.initializeEvidence = undefined
      this.setState('closed')
      return
    }
    if (this.currentState !== 'closing') this.setState('closing')
    this.initializeEvidence = undefined
    this.rejectAll(new AppServerSupervisorError('closed', 'The supervisor is closing.'))
    this.rejectQueuedWrites(new AppServerSupervisorError('closed', 'The supervisor is closing.'))
    this.listeners.clear()
    this.bufferedNotifications = []
    this.stdoutBuffer = Buffer.alloc(0)

    const child = this.child
    if (child === undefined || this.childExited) {
      this.setState('closed')
      return
    }
    const exited = new Promise<void>((resolve) => {
      this.resolveChildExit = resolve
    })
    child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.config.limits.shutdownGraceMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (!this.childExited) {
      try {
        child.kill()
      } catch {
        // The bounded post-termination check below remains authoritative.
      }
    }
    if (!this.childExited) {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, this.config.limits.shutdownGraceMs)),
      ])
    }
    if (!this.childExited) {
      this.currentState = 'failed'
      this.safeLog({
        event: 'lifecycle',
        generation: this.generation,
        state: 'failed',
        outcome: 'failed',
        code: 'child-exited',
      })
      throw new AppServerSupervisorError(
        'child-exited',
        'The owned child did not exit after bounded termination.',
      )
    }
    this.setState('closed')
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on('data', (chunk: Buffer) => this.consumeStdout(chunk))
    child.stderr.on('data', (chunk: Buffer) => this.consumeStderr(chunk))
    child.stdin.on('error', () => this.failClosed('write-failed'))
    child.on('error', () => this.failClosed('child-spawn-failed'))
    const handleTermination = () => {
      if (this.childExited) return
      this.childExited = true
      this.resolveChildExit?.()
      this.resolveChildExit = undefined
      if (this.currentState === 'closing' || this.currentState === 'closed') return
      if (this.stdoutBuffer.length > 0) {
        this.failClosed('protocol-error', 'stdout-incomplete-line')
        return
      }
      this.failClosed('child-exited')
    }
    child.on('exit', handleTermination)
    child.on('close', handleTermination)
  }

  private consumeStdout(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk) || this.isTerminalOrClosing()) return
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a)
      if (newline < 0) break
      const rawLine = this.stdoutBuffer.subarray(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      if (rawLine.length > this.config.limits.maxLineBytes) {
        this.failClosed('protocol-error', 'stdout-line-too-large')
        return
      }
      const content = rawLine.length > 0 && rawLine.at(-1) === 0x0d
        ? rawLine.subarray(0, rawLine.length - 1)
        : rawLine
      if (content.length === 0) {
        this.failClosed('protocol-error', 'stdout-empty-line')
        return
      }
      let line: string
      try {
        line = utf8Decoder.decode(content)
      } catch {
        this.failClosed('protocol-error', 'stdout-invalid-utf8')
        return
      }
      this.consumeLine(line)
      if (this.isTerminalOrClosing()) return
    }
    if (this.stdoutBuffer.length > this.config.limits.maxLineBytes) {
      this.failClosed('protocol-error', 'stdout-line-too-large')
      return
    }
    this.stdoutBuffer = this.stdoutBuffer.length === 0
      ? Buffer.alloc(0)
      : Buffer.from(this.stdoutBuffer)
  }

  private consumeStderr(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk) || this.isTerminalOrClosing()) return
    this.stderrBytes += chunk.length
    if (this.stderrBytes > this.config.limits.maxStderrBytes) {
      this.failClosed('protocol-error', 'stderr-too-large')
    }
  }

  private consumeLine(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.failClosed('protocol-error', 'stdout-invalid-json')
      return
    }
    if (!isRecord(value)) {
      this.failClosed('protocol-error', 'stdout-invalid-object')
      return
    }
    const hasId = own(value, 'id')
    const hasMethod = own(value, 'method')
    const hasResult = own(value, 'result')
    const hasError = own(value, 'error')

    if (hasId && !hasMethod && hasResult !== hasError) {
      this.consumeResponse(value)
      return
    }
    if (hasMethod && typeof value.method === 'string' && value.method.length > 0 && !hasResult && !hasError) {
      if (hasId) this.consumeServerRequest(value)
      else this.consumeNotification(value)
      return
    }
    this.failClosed('protocol-error', 'stdout-invalid-message')
  }

  private consumeResponse(value: Record<string, unknown>): void {
    if (!Number.isSafeInteger(value.id) || (value.id as number) <= 0) {
      this.failClosed('protocol-error', 'response-invalid-id')
      return
    }
    const id = value.id as number
    const pending = this.pending.get(id)
    if (pending === undefined) {
      this.failClosed('protocol-error', 'response-unexpected-id')
      return
    }
    if (own(value, 'error')) {
      if (
        !isRecord(value.error) ||
        !Number.isSafeInteger(value.error.code) ||
        typeof value.error.message !== 'string'
      ) {
        this.failClosed('protocol-error', 'response-invalid-error')
        return
      }
      this.pending.delete(id)
      clearTimeout(pending.timer)
      this.safeLog({
        event: 'request',
        generation: this.generation,
        method: pending.method,
        requestId: id,
        outcome: 'failed',
        durationMs: Math.max(0, Date.now() - pending.startedAt),
      })
      pending.reject(new AppServerRpcError(value.error.code as number))
      return
    }
    if (!isJsonValue(value.result)) {
      this.failClosed('protocol-error', 'response-invalid-result')
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    this.safeLog({
      event: 'request',
      generation: this.generation,
      method: pending.method,
      requestId: id,
      outcome: 'succeeded',
      durationMs: Math.max(0, Date.now() - pending.startedAt),
    })
    pending.resolve(value.result)
  }

  private consumeNotification(value: Record<string, unknown>): void {
    if (!this.initializedFrameQueued) {
      const initializeStillPending = [...this.pending.values()].some(
        pending => pending.method === 'initialize',
      )
      if (this.currentState !== 'initializing' || initializeStillPending) {
        this.failClosed('protocol-error', 'notification-before-initialize')
        return
      }
    }
    const notification: Notification = Object.freeze({
      method: value.method as string,
      ...(own(value, 'params') ? { params: value.params } : {}),
    })
    if (this.listeners.size === 0) {
      if (this.bufferedNotifications.length >= this.config.limits.maxBufferedNotifications) {
        this.failClosed('protocol-error', 'notification-overflow')
        return
      }
      this.bufferedNotifications.push(notification)
      return
    }
    for (const listener of this.listeners) this.invokeListener(listener, notification)
  }

  private consumeServerRequest(value: Record<string, unknown>): void {
    if (!this.initializedFrameQueued) {
      this.failClosed('protocol-error')
      return
    }
    if (!isRpcId(value.id)) {
      this.failClosed('protocol-error')
      return
    }
    const key = `${typeof value.id}:${String(value.id)}`
    if (this.pendingServerRequestKeys.has(key)) {
      this.failClosed('protocol-error')
      return
    }
    if (this.pendingServerRequestKeys.size >= this.config.limits.maxPendingServerRequests) {
      this.failClosed('capacity-exceeded')
      return
    }
    this.pendingServerRequestKeys.add(key)
    const method = value.method as string
    void this.answerServerRequest(key, value.id, method, own(value, 'params') ? value.params : undefined)
  }

  private async answerServerRequest(
    key: string,
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handledMethod = HANDLED_SERVER_REQUEST_METHOD_SET.has(method)
      ? method as HandledServerRequestMethod
      : undefined
    let decision = safeServerError()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (handledMethod !== undefined && this.config.onServerRequest !== undefined) {
        const request: ServerRequest = Object.freeze({
          id,
          method: handledMethod,
          ...(params === undefined ? {} : { params }),
        })
        const timeout = new Promise<ServerRequestDecision>(resolve => {
          timer = setTimeout(() => resolve(safeServerError()), this.config.limits.serverRequestTimeoutMs)
        })
        const handled = Promise.resolve()
          .then(() => this.config.onServerRequest!(request))
          .then(value => snapshotServerRequestDecision(value) ?? safeServerError())
          .catch(() => safeServerError())
        decision = await Promise.race([handled, timeout])
      }
      await this.enqueueFrame({ id, ...decision })
      this.safeLog({
        event: 'server-request',
        generation: this.generation,
        method: handledMethod ?? 'unsupported',
        outcome: 'result' in decision ? 'answered' : 'rejected',
      })
    } catch {
      // The write path already failed closed or the generation is closing.
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.pendingServerRequestKeys.delete(key)
    }
  }

  private sendRequest(
    method: AppServerMethod | 'initialize',
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.pending.size >= this.config.limits.maxPendingRequests) {
      throw new AppServerSupervisorError('capacity-exceeded', 'The pending request limit was reached.')
    }
    const id = this.nextRequestId
    if (!Number.isSafeInteger(id) || id <= 0) {
      this.failClosed('protocol-error')
      throw new AppServerSupervisorError('protocol-error', 'The request id space was exhausted.')
    }
    this.nextRequestId += 1
    const startedAt = Date.now()
    let resolvePending!: (value: unknown) => void
    let rejectPending!: (reason: unknown) => void
    const response = new Promise<unknown>((resolve, reject) => {
      resolvePending = resolve
      rejectPending = reject
    })
    const timer = setTimeout(() => {
      const pending = this.pending.get(id)
      if (pending === undefined) return
      this.pending.delete(id)
      this.safeLog({
        event: 'request',
        generation: this.generation,
        method,
        requestId: id,
        outcome: 'timed-out',
        durationMs: Math.max(0, Date.now() - startedAt),
      })
      pending.reject(new AppServerSupervisorError('request-timeout', 'The app-server request timed out.'))
      this.failClosed('request-timeout')
    }, timeoutMs)
    this.pending.set(id, {
      method,
      startedAt,
      resolve: resolvePending,
      reject: rejectPending,
      timer,
    })
    void this.enqueueFrame({ id, method, params }).catch((error: unknown) => {
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        this.pending.delete(id)
        clearTimeout(timer)
        pending.reject(error)
      }
    })
    return response
  }

  private enqueueFrame(value: unknown): Promise<void> {
    if (this.child === undefined || this.childExited || this.isTerminalOrClosing()) {
      return Promise.reject(new AppServerSupervisorError('closed', 'The owned child is not writable.'))
    }
    let validJson = false
    try {
      validJson = isJsonValue(value)
    } catch {
      validJson = false
    }
    if (!validJson) {
      return Promise.reject(new AppServerSupervisorError('protocol-error', 'The JSONL frame is invalid.'))
    }
    let serialized: string
    try {
      serialized = `${JSON.stringify(value)}\n`
    } catch {
      this.failClosed('protocol-error')
      return Promise.reject(new AppServerSupervisorError('protocol-error', 'The JSONL frame is invalid.'))
    }
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes - 1 > this.config.limits.maxLineBytes) {
      return Promise.reject(new AppServerSupervisorError('capacity-exceeded', 'The JSONL frame is too large.'))
    }
    if (
      this.writeQueue.length + (this.activeWrite === undefined ? 0 : 1) >=
        this.config.limits.maxWriteQueueFrames ||
      this.writeQueueBytes + bytes > this.config.limits.maxWriteQueueBytes
    ) {
      this.failClosed('write-failed')
      return Promise.reject(new AppServerSupervisorError('capacity-exceeded', 'The child write queue limit was reached.'))
    }
    return new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ bytes, frame: serialized, resolve, reject })
      this.writeQueueBytes += bytes
      this.pumpWrites()
    })
  }

  private pumpWrites(): void {
    if (this.writeActive || this.writeQueue.length === 0) return
    const child = this.child
    if (child === undefined || this.childExited || this.isTerminalOrClosing()) {
      this.rejectQueuedWrites(new AppServerSupervisorError('closed', 'The owned child is not writable.'))
      return
    }
    const entry = this.writeQueue.shift()
    if (entry === undefined) return
    this.writeActive = true
    this.activeWrite = entry
    const complete = (error?: Error | null) => {
      this.writeActive = false
      this.activeWrite = undefined
      this.writeQueueBytes -= entry.bytes
      if (error !== null && error !== undefined) {
        entry.reject(new AppServerSupervisorError('write-failed', 'The owned child write failed.'))
        this.failClosed('write-failed')
        return
      }
      entry.resolve()
      this.pumpWrites()
    }
    try {
      child.stdin.write(entry.frame, 'utf8', complete)
    } catch (error) {
      complete(error instanceof Error ? error : new Error('write failed'))
    }
  }

  private rejectAll(error: AppServerSupervisorError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private rejectQueuedWrites(error: AppServerSupervisorError): void {
    const queued = this.writeQueue
    this.writeQueue = []
    this.writeQueueBytes = this.activeWrite?.bytes ?? 0
    for (const entry of queued) entry.reject(error)
  }

  private failWithoutChild(code: ErrorCode): void {
    this.initializeEvidence = undefined
    this.currentState = 'failed'
    this.safeLog({
      event: 'lifecycle',
      generation: this.generation,
      state: 'failed',
      outcome: 'failed',
      code,
    })
    this.rejectAll(new AppServerSupervisorError(code, 'The app-server supervisor failed closed.'))
  }

  private failClosed(code: ErrorCode, detail?: ProtocolFailureDetail): void {
    if (this.currentState === 'failed' || this.currentState === 'closed') return
    if (this.currentState === 'closing') return
    this.initializeEvidence = undefined
    this.currentState = 'failed'
    this.safeLog({
      event: 'lifecycle',
      generation: this.generation,
      state: 'failed',
      outcome: 'failed',
      code,
      ...(detail === undefined ? {} : { detail }),
      ...(() => {
        const methods = new Set([...this.pending.values()].map(value => value.method))
        return methods.size === 1 ? { pendingMethod: [...methods][0]! } : {}
      })(),
    })
    const error = new AppServerSupervisorError(code, 'The app-server supervisor failed closed.')
    this.rejectAll(error)
    this.rejectQueuedWrites(error)
    this.listeners.clear()
    this.bufferedNotifications = []
    this.stdoutBuffer = Buffer.alloc(0)
    const child = this.child
    if (child !== undefined && !this.childExited) {
      child.stdin.destroy()
      try {
        child.kill()
      } catch {
        // close() reports a bounded termination failure instead of claiming success.
      }
    }
  }

  private setState(state: SupervisorState): void {
    this.currentState = state
    this.safeLog({
      event: 'lifecycle',
      generation: this.generation,
      state,
      outcome: 'entered',
    })
  }

  private safeLog(event: SupervisorLogEvent): void {
    const logger = this.config.logger
    if (logger === undefined) return
    const safeEvent = Object.freeze({ ...event }) as SupervisorLogEvent
    queueMicrotask(() => {
      try {
        logger(safeEvent)
      } catch {
        // Observability cannot influence the security state machine.
      }
    })
  }

  private invokeListener(listener: NotificationListener, notification: Notification): void {
    try {
      listener(notification)
    } catch {
      // A local observer cannot influence transport correctness.
    }
  }

  private isTerminalOrClosing(): boolean {
    return (
      this.currentState === 'failed' ||
      this.currentState === 'closing' ||
      this.currentState === 'closed'
    )
  }
}

/** Package-private fixed write bridge. It is deliberately absent from src/index.ts. */
export function dispatchBoundRuntimeWrite(
  supervisor: AppServerSupervisor,
  compatibility: RuntimeCompatibility,
  write: BoundRuntimeWrite,
): Promise<unknown> {
  return supervisor[BOUND_RUNTIME_WRITE](compatibility, write)
}
