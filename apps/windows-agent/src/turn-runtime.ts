import { requireModelSettings } from './model-catalog.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'
import { TextDecoder, types as nodeTypes } from 'node:util'

import {
  dispatchBoundRuntimeWrite,
  AppServerRpcError,
  type AppServerSupervisor,
} from './supervisor.ts'
import {
  isRuntimeCompatibilityCurrent,
  type RuntimeCompatibility,
} from './runtime-binding.ts'

export type TextTurnRuntimeErrorCode =
  | 'invalid-input'
  | 'runtime-not-current'
  | 'app-server-failed'
  | 'response-invalid'
  | 'catalog-unavailable'
  | 'loaded-list-failed'
  | 'resume-failed'
  | 'turn-rejected'

export class TextTurnRuntimeError extends Error {
  constructor(readonly code: TextTurnRuntimeErrorCode, readonly submission: 'not-submitted' | 'rejected' | 'unknown' = 'unknown') {
    super('The text turn was not accepted by the app-server.')
    this.name = 'TextTurnRuntimeError'
  }
}

export interface TextTurnRequest {
  readonly threadId: string
  readonly actionId: string
  readonly text: string
  readonly settings?: TextTurnSettings
  readonly attachments?: readonly TextTurnAttachment[]
  readonly attachmentDirectory?: string
  readonly allowFullAccess?: boolean
}

export interface TextTurnAttachment {
  readonly kind: 'localImage' | 'file'
  readonly attachmentId: string
  readonly name: string
  readonly mediaType: string
  readonly byteLength: number
  readonly contentBase64Url: string
}

export interface TextTurnSettings {
  readonly model: string
  readonly effort: string
  readonly permission: 'ask' | 'read-only' | 'full-access'
}

const DEFAULT_SETTINGS: TextTurnSettings = Object.freeze({
  model: 'gpt-5.6-sol', effort: 'xhigh', permission: 'ask',
})
const ACTIVE_TEXT_TURNS = new WeakMap<AppServerSupervisor, Map<string, string>>()
const MAX_ATTACHMENT_BYTES = 256 * 1024
const MAX_ATTACHMENT_COUNT = 4
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export function isSupportedTextTurnSettings(value: unknown, allowFullAccess = false): value is TextTurnSettings {
  const properties = plainData(value)
  if (properties === undefined || properties.size !== 3) return false
  const model = properties.get('model')
  const effort = properties.get('effort')
  const permission = properties.get('permission')
  return typeof model === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)
    && typeof effort === 'string'
    && /^[a-z][a-z0-9-]{0,31}$/.test(effort)
    && (permission === 'ask' || permission === 'read-only' || (allowFullAccess && permission === 'full-access'))
}

export interface AcceptedTextTurn {
  readonly state: 'accepted-by-app-server'
  readonly threadId: string
  readonly actionId: string
  readonly turnId: string
}

export interface InterruptTurnRequest {
  readonly threadId: string
  readonly turnId: string
}

export interface StartTaskRequest {
  readonly workspacePath: string
  readonly actionId: string
  readonly text: string
  readonly settings: TextTurnSettings
  readonly attachments?: readonly TextTurnAttachment[]
  readonly attachmentDirectory?: string
  readonly allowFullAccess?: boolean
  readonly onThreadStarted?: (threadId: string) => void
}

export interface StartedTaskTurn extends AcceptedTextTurn {
  readonly workspacePath: string
}

function plainData(value: unknown): Map<string, unknown> | undefined {
  if (nodeTypes.isProxy(value) || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const result = new Map<string, unknown>()
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
      result.set(key, descriptor.value)
    }
    return result
  } catch {
    return undefined
  }
}

function denseArray(value: unknown, maxItems: number): readonly unknown[] | undefined {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maxItems) return undefined
  try {
    const snapshot: unknown[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return undefined
      snapshot.push(descriptor.value)
    }
    return snapshot
  } catch {
    return undefined
  }
}

type SnapshotTextTurnRequest = Readonly<{
  threadId: string
  actionId: string
  text: string
  settings: TextTurnSettings
  attachments: readonly TextTurnAttachment[]
  attachmentDirectory?: string
  allowFullAccess: boolean
}>

function snapshotAttachments(value: unknown): readonly TextTurnAttachment[] | undefined {
  if (value === undefined) return Object.freeze([])
  const values = denseArray(value, MAX_ATTACHMENT_COUNT)
  if (values === undefined) return undefined
  const result: TextTurnAttachment[] = []
  const ids = new Set<string>()
  let total = 0
  for (const candidate of values) {
    const properties = plainData(candidate)
    if (properties === undefined || properties.size !== 6) return undefined
    const kind = properties.get('kind')
    const attachmentId = properties.get('attachmentId')
    const name = properties.get('name')
    const mediaType = properties.get('mediaType')
    const byteLength = properties.get('byteLength')
    const contentBase64Url = properties.get('contentBase64Url')
    if (
      (kind !== 'localImage' && kind !== 'file')
      || typeof attachmentId !== 'string'
      || attachmentId.length === 0
      || Buffer.byteLength(attachmentId, 'utf8') > 512
      || typeof name !== 'string'
      || name.length === 0
      || Buffer.byteLength(name, 'utf8') > 256
      || /[\u0000-\u001f\u007f]/.test(name)
      || typeof mediaType !== 'string'
      || mediaType.length === 0
      || Buffer.byteLength(mediaType, 'utf8') > 256
      || !Number.isSafeInteger(byteLength)
      || (byteLength as number) < 1
      || (byteLength as number) > MAX_ATTACHMENT_BYTES
      || typeof contentBase64Url !== 'string'
      || !/^[A-Za-z0-9_-]+$/.test(contentBase64Url)
    ) return undefined
    const bytes = Buffer.from(contentBase64Url, 'base64url')
    if (bytes.byteLength !== byteLength || bytes.toString('base64url') !== contentBase64Url) return undefined
    if (ids.has(attachmentId)) return undefined
    ids.add(attachmentId)
    if (kind === 'localImage' && !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) return undefined
    total += bytes.byteLength
    if (total > MAX_ATTACHMENT_BYTES) return undefined
    result.push(Object.freeze({ kind, attachmentId, name, mediaType, byteLength, contentBase64Url }))
  }
  return Object.freeze(result)
}

function snapshotRequest(value: TextTurnRequest): SnapshotTextTurnRequest | undefined {
  const properties = plainData(value)
  const allowedKeys = new Set(['threadId', 'actionId', 'text', 'settings', 'attachments', 'attachmentDirectory', 'allowFullAccess'])
  if (
    properties === undefined ||
    [...properties.keys()].some(key => !allowedKeys.has(key)) ||
    !properties.has('threadId') ||
    !properties.has('actionId') ||
    !properties.has('text')
  ) {
    return undefined
  }
  const threadId = properties.get('threadId')
  const actionId = properties.get('actionId')
  const text = properties.get('text')
  const settings = properties.has('settings') ? properties.get('settings') : DEFAULT_SETTINGS
  const attachments = snapshotAttachments(properties.get('attachments'))
  const attachmentDirectory = properties.get('attachmentDirectory')
  const allowFullAccess = properties.get('allowFullAccess') === true
  if (
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    Buffer.byteLength(threadId, 'utf8') > 512 ||
    typeof actionId !== 'string' ||
    actionId.length === 0 ||
    Buffer.byteLength(actionId, 'utf8') > 512 ||
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > 1024 * 1024 ||
    !isSupportedTextTurnSettings(settings, allowFullAccess) ||
    attachments === undefined ||
    (attachments.length > 0 && (
      typeof attachmentDirectory !== 'string'
      || !windowsPath.isAbsolute(attachmentDirectory)
    )) ||
    (attachmentDirectory !== undefined && typeof attachmentDirectory !== 'string')
  ) {
    return undefined
  }
  return Object.freeze({
    threadId,
    actionId,
    text,
    settings: Object.freeze({
      model: settings.model,
      effort: settings.effort,
      permission: settings.permission,
    }),
    attachments,
    allowFullAccess,
    ...(typeof attachmentDirectory === 'string' ? { attachmentDirectory: windowsPath.normalize(attachmentDirectory) } : {}),
  })
}

function resumedThreadMatches(value: unknown, threadId: string): boolean {
  const response = plainData(value)
  const thread = plainData(response?.get('thread'))
  return thread?.get('id') === threadId
}

function loadedThreadListed(value: unknown, threadId: string): boolean {
  const response = plainData(value)
  if (response === undefined || response.size !== 2) return false
  const data = denseArray(response.get('data'), 256)
  const nextCursor = response.get('nextCursor')
  if (data === undefined || (nextCursor !== null && typeof nextCursor !== 'string')) return false
  const ids: string[] = []
  for (const candidate of data) {
    if (
      typeof candidate !== 'string'
      || candidate.length === 0
      || Buffer.byteLength(candidate, 'utf8') > 512
    ) return false
    ids.push(candidate)
  }
  return ids.includes(threadId)
}

type MaterializedTurnInput =
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

function imageExtension(mediaType: string, bytes: Buffer): string | undefined {
  if (mediaType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (mediaType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return '.jpg'
  if (
    mediaType === 'image/webp'
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return '.webp'
  return undefined
}

function fileExtension(mediaType: string, name: string, bytes: Buffer): string | undefined {
  if (mediaType.startsWith('text/')) {
    try { utf8Decoder.decode(bytes) } catch { return undefined }
    const extension = windowsPath.extname(name).toLowerCase()
    return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.txt'
  }
  if (mediaType === 'application/json') {
    try { utf8Decoder.decode(bytes) } catch { return undefined }
    return '.json'
  }
  if (mediaType === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return '.pdf'
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
  if (!zip) return undefined
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx'
  if (mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx'
  if (mediaType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx'
  return undefined
}

function materializeTurnInputs(snapshot: SnapshotTextTurnRequest): readonly MaterializedTurnInput[] {
  const inputs: MaterializedTurnInput[] = []
  if (snapshot.text.length > 0) {
    inputs.push(Object.freeze({ type: 'text', text: snapshot.text, text_elements: Object.freeze([]) }))
  }
  if (snapshot.attachments.length === 0) return Object.freeze(inputs)
  if (snapshot.attachmentDirectory === undefined) throw new TextTurnRuntimeError('invalid-input')
  mkdirSync(snapshot.attachmentDirectory, { recursive: true })
  const created: string[] = []
  try {
    for (const attachment of snapshot.attachments) {
      const bytes = Buffer.from(attachment.contentBase64Url, 'base64url')
      const extension = attachment.kind === 'localImage'
        ? imageExtension(attachment.mediaType, bytes)
        : fileExtension(attachment.mediaType, attachment.name, bytes)
      if (extension === undefined) throw new TextTurnRuntimeError('invalid-input')
      const fileName = `${createHash('sha256').update(snapshot.actionId).update('\0').update(attachment.attachmentId).digest('hex')}${extension}`
      const filePath = windowsPath.join(snapshot.attachmentDirectory, fileName)
      if (windowsPath.dirname(filePath) !== snapshot.attachmentDirectory) throw new TextTurnRuntimeError('invalid-input')
      writeFileSync(filePath, bytes, { flag: 'wx' })
      created.push(filePath)
      if (attachment.kind === 'localImage') {
        inputs.push(Object.freeze({ type: 'localImage', path: filePath }))
      } else {
        const prefix = `Attached file ${attachment.name}: `
        const text = `${prefix}${filePath}`
        inputs.push(Object.freeze({
          type: 'text',
          text,
          text_elements: Object.freeze([Object.freeze({
            byteRange: Object.freeze({
              start: Buffer.byteLength(prefix, 'utf8'),
              end: Buffer.byteLength(text, 'utf8'),
            }),
            placeholder: attachment.name,
          })]),
        }))
      }
    }
  } catch (error) {
    for (const filePath of created) {
      try { unlinkSync(filePath) } catch { /* workspace-local best-effort cleanup */ }
    }
    if (error instanceof TextTurnRuntimeError) throw error
    throw new TextTurnRuntimeError('app-server-failed')
  }
  return Object.freeze(inputs)
}

function acceptedTurnId(value: unknown, actionId: string, text: string): string | undefined {
  const response = plainData(value)
  const turn = plainData(response?.get('turn'))
  const turnId = turn?.get('id')
  const items = denseArray(turn?.get('items'), 32)
  if (
    typeof turnId !== 'string' ||
    turnId.length === 0 ||
    Buffer.byteLength(turnId, 'utf8') > 512 ||
    turn?.get('status') !== 'inProgress' ||
    items === undefined
  ) {
    return undefined
  }
  if (items.length === 0) return turnId

  let matchingUserMessage = false
  let userMessageCount = 0
  for (const itemValue of items) {
    const item = plainData(itemValue)
    if (item === undefined || item.get('type') !== 'userMessage') continue
    userMessageCount += 1
    const content = denseArray(item.get('content'), 4)
    if (item.get('clientId') !== actionId || content?.length !== 1) continue
    const textInput = plainData(content[0])
    const textElements = denseArray(textInput?.get('text_elements'), 0)
    if (
      textInput?.get('type') === 'text' &&
      textInput.get('text') === text &&
      textElements?.length === 0
    ) {
      matchingUserMessage = true
    }
  }
  return userMessageCount === 1 && (text.length === 0 || matchingUserMessage) ? turnId : undefined
}

/**
 * Package-private exact text-turn entry. The package root intentionally does not export it.
 */
export async function startBoundTextTurn(
  supervisor: AppServerSupervisor,
  compatibility: RuntimeCompatibility,
  request: TextTurnRequest,
): Promise<AcceptedTextTurn> {
  const snapshot = snapshotRequest(request)
  if (snapshot === undefined) throw new TextTurnRuntimeError('invalid-input', 'not-submitted')
  if (
    compatibility.state !== 'write-bound' ||
    !compatibility.capabilities.resumeThread ||
    !compatibility.capabilities.sendTextTurn ||
    (snapshot.attachments.length > 0 && !compatibility.capabilities.attachments) ||
    !isRuntimeCompatibilityCurrent(supervisor, compatibility)
  ) {
    throw new TextTurnRuntimeError('runtime-not-current', 'not-submitted')
  }

  try { await requireModelSettings(supervisor, snapshot.settings) }
  catch { throw new TextTurnRuntimeError('catalog-unavailable', 'not-submitted') }

  let loadedResponse: unknown
  try {
    loadedResponse = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
      operation: 'list-loaded-threads',
      limit: 256,
    })
  } catch {
    throw new TextTurnRuntimeError('loaded-list-failed', 'not-submitted')
  }
  if (!loadedThreadListed(loadedResponse, snapshot.threadId)) {
    let resumeResponse: unknown
    try {
      resumeResponse = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
        operation: 'resume-thread',
        threadId: snapshot.threadId,
      })
    } catch {
      throw new TextTurnRuntimeError('resume-failed', 'not-submitted')
    }
    if (!resumedThreadMatches(resumeResponse, snapshot.threadId)) {
      throw new TextTurnRuntimeError('response-invalid', 'not-submitted')
    }
  }

  let turnResponse: unknown
  let materializedInputs: ReturnType<typeof materializeTurnInputs>
  try { materializedInputs = materializeTurnInputs(snapshot) }
  catch { throw new TextTurnRuntimeError('invalid-input', 'not-submitted') }
  if (materializedInputs.length === 0) throw new TextTurnRuntimeError('invalid-input', 'not-submitted')
  try {
    turnResponse = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
      operation: 'start-text-turn',
      threadId: snapshot.threadId,
      actionId: snapshot.actionId,
      inputs: materializedInputs,
      model: snapshot.settings.model,
      effort: snapshot.settings.effort,
      permission: snapshot.settings.permission,
    })
  } catch (error) {
    throw error instanceof AppServerRpcError
      ? new TextTurnRuntimeError('turn-rejected', 'rejected')
      : new TextTurnRuntimeError('app-server-failed', 'unknown')
  }
  const turnId = acceptedTurnId(turnResponse, snapshot.actionId, snapshot.text)
  if (turnId === undefined) throw new TextTurnRuntimeError('response-invalid')
  let active = ACTIVE_TEXT_TURNS.get(supervisor)
  if (active === undefined) {
    active = new Map()
    ACTIVE_TEXT_TURNS.set(supervisor, active)
  }
  active.set(snapshot.threadId, turnId)

  return Object.freeze({
    state: 'accepted-by-app-server',
    threadId: snapshot.threadId,
    actionId: snapshot.actionId,
    turnId,
  })
}

/** Package-private fixed workspace task creation followed by its first turn. */
export async function startBoundTask(
  supervisor: AppServerSupervisor,
  compatibility: RuntimeCompatibility,
  request: StartTaskRequest,
): Promise<StartedTaskTurn> {
  if (typeof request.workspacePath !== 'string' || !windowsPath.isAbsolute(request.workspacePath)) {
    throw new TextTurnRuntimeError('invalid-input')
  }
  const snapshot = snapshotRequest({
    threadId: 'pending-new-thread',
    actionId: request.actionId,
    text: request.text,
    settings: request.settings,
    ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
    ...(request.attachmentDirectory === undefined ? {} : { attachmentDirectory: request.attachmentDirectory }),
    ...(request.allowFullAccess === true ? { allowFullAccess: true } : {}),
  })
  if (
    snapshot === undefined
    || compatibility.state !== 'write-bound'
    || !compatibility.capabilities.sendTextTurn
    || (snapshot.attachments.length > 0 && !compatibility.capabilities.attachments)
    || !isRuntimeCompatibilityCurrent(supervisor, compatibility)
  ) throw new TextTurnRuntimeError('runtime-not-current')
  try { await requireModelSettings(supervisor, snapshot.settings) }
  catch { throw new TextTurnRuntimeError('catalog-unavailable', 'not-submitted') }
  const inputs = materializeTurnInputs(snapshot)
  if (inputs.length === 0) throw new TextTurnRuntimeError('invalid-input')

  let startResponse: unknown
  try {
    startResponse = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
      operation: 'start-thread',
      cwd: windowsPath.normalize(request.workspacePath),
      model: snapshot.settings.model,
      permission: snapshot.settings.permission,
    })
  } catch {
    throw new TextTurnRuntimeError('app-server-failed')
  }
  const response = plainData(startResponse)
  const thread = plainData(response?.get('thread'))
  const threadId = thread?.get('id')
  const responseCwd = response?.get('cwd')
  if (
    typeof threadId !== 'string'
    || threadId.length === 0
    || Buffer.byteLength(threadId, 'utf8') > 512
    || thread?.get('ephemeral') !== false
    || typeof responseCwd !== 'string'
    || windowsPath.normalize(responseCwd) !== windowsPath.normalize(request.workspacePath)
  ) throw new TextTurnRuntimeError('response-invalid')

  try {
    request.onThreadStarted?.(threadId)
  } catch {
    throw new TextTurnRuntimeError('app-server-failed')
  }

  let turnResponse: unknown
  try {
    turnResponse = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
      operation: 'start-text-turn',
      threadId,
      actionId: snapshot.actionId,
      inputs,
      model: snapshot.settings.model,
      effort: snapshot.settings.effort,
      permission: snapshot.settings.permission,
    })
  } catch {
    throw new TextTurnRuntimeError('app-server-failed')
  }
  const turnId = acceptedTurnId(turnResponse, snapshot.actionId, snapshot.text)
  if (turnId === undefined) throw new TextTurnRuntimeError('response-invalid')
  let active = ACTIVE_TEXT_TURNS.get(supervisor)
  if (active === undefined) {
    active = new Map()
    ACTIVE_TEXT_TURNS.set(supervisor, active)
  }
  active.set(threadId, turnId)
  return Object.freeze({
    state: 'accepted-by-app-server', threadId, actionId: snapshot.actionId, turnId,
    workspacePath: windowsPath.normalize(request.workspacePath),
  })
}

/** Package-private exact same-turn text steer entry. */
export async function steerBoundTextTurn(
  supervisor: AppServerSupervisor,
  compatibility: RuntimeCompatibility,
  request: TextTurnRequest,
): Promise<AcceptedTextTurn> {
  const snapshot = snapshotRequest(request)
  if (snapshot === undefined) throw new TextTurnRuntimeError('invalid-input')
  if (
    compatibility.state !== 'write-bound'
    || !compatibility.capabilities.steerTurn
    || (snapshot.attachments.length > 0 && !compatibility.capabilities.attachments)
    || !isRuntimeCompatibilityCurrent(supervisor, compatibility)
  ) {
    throw new TextTurnRuntimeError('runtime-not-current')
  }
  const turnId = ACTIVE_TEXT_TURNS.get(supervisor)?.get(snapshot.threadId)
  if (turnId === undefined) throw new TextTurnRuntimeError('runtime-not-current')

  let response: unknown
  const materializedInputs = materializeTurnInputs(snapshot)
  if (materializedInputs.length === 0) throw new TextTurnRuntimeError('invalid-input')
  try {
    response = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
      operation: 'steer-text-turn',
      threadId: snapshot.threadId,
      turnId,
      actionId: snapshot.actionId,
      inputs: materializedInputs,
    })
  } catch {
    throw new TextTurnRuntimeError('app-server-failed')
  }
  if (plainData(response)?.get('turnId') !== turnId) {
    throw new TextTurnRuntimeError('response-invalid')
  }
  return Object.freeze({
    state: 'accepted-by-app-server',
    threadId: snapshot.threadId,
    actionId: snapshot.actionId,
    turnId,
  })
}

/** Package-private interrupt for the exact active turn created by this supervisor. */
export async function interruptBoundTurn(
  supervisor: AppServerSupervisor,
  compatibility: RuntimeCompatibility,
  request: InterruptTurnRequest,
): Promise<void> {
  if (
    typeof request.threadId !== 'string'
    || request.threadId.length === 0
    || Buffer.byteLength(request.threadId, 'utf8') > 512
    || typeof request.turnId !== 'string'
    || request.turnId.length === 0
    || Buffer.byteLength(request.turnId, 'utf8') > 512
  ) throw new TextTurnRuntimeError('invalid-input')
  if (
    compatibility.state !== 'write-bound'
    || !compatibility.capabilities.interruptTurn
    || !isRuntimeCompatibilityCurrent(supervisor, compatibility)
    || ACTIVE_TEXT_TURNS.get(supervisor)?.get(request.threadId) !== request.turnId
  ) throw new TextTurnRuntimeError('runtime-not-current')
  let response: unknown
  try {
    response = await dispatchBoundRuntimeWrite(supervisor, compatibility, {
      operation: 'interrupt-turn',
      threadId: request.threadId,
      turnId: request.turnId,
    })
  } catch {
    throw new TextTurnRuntimeError('app-server-failed')
  }
  if (plainData(response)?.size !== 0) throw new TextTurnRuntimeError('response-invalid')
  ACTIVE_TEXT_TURNS.get(supervisor)?.delete(request.threadId)
}
