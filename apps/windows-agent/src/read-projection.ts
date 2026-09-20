import { createHash } from 'node:crypto'
import { win32 as windowsPath } from 'node:path'

import { APP_SERVER_SCHEMA_VERSION } from './runtime-binding.ts'
import { AppServerRpcError, AppServerSupervisor, type AppServerMethod } from './supervisor.ts'

const LIMITS = Object.freeze({
  maxWorkspaces: 32,
  maxKnownWorkspaces: 128,
  maxTasksPerPage: 100,
  defaultTasksPerPage: 50,
  maxTurnsPerThread: 512,
  maxItemsPerTurn: 2_048,
  maxInputsPerMessage: 128,
  maxChangesPerItem: 512,
  maxPartsPerItem: 256,
  maxIdentifierBytes: 512,
  maxCursorBytes: 4 * 1_024,
  turnsPerPage: 1,
  maxTurnPages: 32,
  maxLabelBytes: 64 * 1_024,
  maxPathBytes: 32 * 1_024,
  maxTextBytes: 512 * 1_024,
  maxUnixSeconds: 253_402_300_799,
})

export type ProjectedThreadStatus =
  | { readonly type: 'notLoaded' }
  | { readonly type: 'idle' }
  | { readonly type: 'systemError' }
  | {
      readonly type: 'active'
      readonly activeFlags: readonly ('waitingOnApproval' | 'waitingOnUserInput')[]
    }

export type ProjectedTurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'
export type ProjectedThreadSource =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown'
  | 'custom'
  | 'subAgent'

export interface AuthorizedWorkspace {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly pathLabel: string
}

export interface ReadProjectionConfig {
  readonly supervisor: AppServerSupervisor
  readonly workspaces: readonly AuthorizedWorkspace[]
  readonly pageSize?: number
  readonly allowAllLocalThreads?: boolean
  readonly paginateTurns?: boolean
}

export interface OwnedActiveTaskSeed {
  readonly taskId: string
  readonly workspaceId: string
  readonly actionId: string
  readonly turnId: string
  readonly title: string
  readonly text: string
  readonly now: number
}

export interface ReadOnlyWorkspaceSummary {
  readonly id: string
  readonly name: string
  readonly pathLabel: string
}

export interface ReadOnlyTaskSummary {
  readonly id: string
  readonly workspaceId: string
  readonly title: string
  readonly status: ProjectedThreadStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly ephemeral: boolean
  readonly modelProvider: string
  readonly source: ProjectedThreadSource
}

export interface ReadOnlyTaskPage {
  readonly authoritative: false
  readonly schemaVersion: typeof APP_SERVER_SCHEMA_VERSION
  readonly tasks: readonly ReadOnlyTaskSummary[]
  readonly nextCursor: string | null
}

interface TimelineItemBase {
  readonly id: string
  readonly turnId: string
  readonly createdAt: string | null
}

export interface ProjectedUserItem extends TimelineItemBase {
  readonly kind: 'user'
  readonly inputs: readonly (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'localImage'; readonly name: string }
    | { readonly type: 'file'; readonly name: string }
    | { readonly type: 'compatibility'; readonly inputType: string }
  )[]
}

export interface ProjectedAssistantItem extends TimelineItemBase {
  readonly kind: 'assistant'
  readonly text: string
  readonly phase: 'commentary' | 'final_answer' | 'unknown'
}

export interface ProjectedPlanItem extends TimelineItemBase {
  readonly kind: 'plan'
  readonly text: string
}

export interface ProjectedReasoningItem extends TimelineItemBase {
  readonly kind: 'reasoning'
  readonly summary: readonly string[]
}

export interface ProjectedCommandItem extends TimelineItemBase {
  readonly kind: 'command'
  readonly command: string
  readonly output: string | null
  readonly state: 'inProgress' | 'completed' | 'failed' | 'declined'
}

export interface ProjectedFileChangeItem extends TimelineItemBase {
  readonly kind: 'fileChange'
  readonly state: 'inProgress' | 'completed' | 'failed' | 'declined'
  readonly changes: readonly {
    readonly path: string
    readonly kind: 'add' | 'delete' | 'update'
    readonly movePath: string | null
    readonly additions: number
    readonly deletions: number
  }[]
}

export interface ProjectedWebSearchItem extends TimelineItemBase {
  readonly kind: 'webSearch'
  readonly query: string
  readonly actionType: 'search' | 'openPage' | 'findInPage' | 'other'
}

export interface ProjectedOperationItem extends TimelineItemBase {
  readonly kind: 'operation'
  readonly itemType: string
  readonly title: string
  readonly summary: string
  readonly state: 'inProgress' | 'completed' | 'failed'
}

export interface ProjectedCompatibilityItem extends TimelineItemBase {
  readonly kind: 'compatibility'
  readonly itemType: string
  readonly state: 'read-only'
}

export type ProjectedTimelineItem =
  | ProjectedUserItem
  | ProjectedAssistantItem
  | ProjectedPlanItem
  | ProjectedReasoningItem
  | ProjectedCommandItem
  | ProjectedFileChangeItem
  | ProjectedWebSearchItem
  | ProjectedOperationItem
  | ProjectedCompatibilityItem

export interface ProjectedTurn {
  readonly id: string
  readonly status: ProjectedTurnStatus
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly items: readonly ProjectedTimelineItem[]
}

export interface ProjectionCompatibilityIssue {
  readonly code: 'unsupported-item' | 'unsupported-input'
  readonly turnId: string
  readonly itemId: string
  readonly itemType: string
}

export interface ReadOnlyTaskProjection {
  readonly authoritative: false
  readonly schemaVersion: typeof APP_SERVER_SCHEMA_VERSION
  readonly completeness: 'full' | 'partial'
  readonly task: ReadOnlyTaskSummary
  readonly workspace: {
    readonly id: string
    readonly name: string
    readonly pathLabel: string
  }
  readonly branch: string | null
  readonly activeTurnId: string | null
  readonly turns: readonly ProjectedTurn[]
  readonly compatibility: readonly ProjectionCompatibilityIssue[]
  readonly model?: string
  readonly effort?: string
}

type ProjectionErrorCode =
  | 'invalid-config'
  | 'invalid-input'
  | 'protocol-error'
  | 'resource-limit'
  | 'task-mismatch'
  | 'unauthorized-workspace'

export class AppServerReadProjectionError extends Error {
  constructor(readonly code: ProjectionErrorCode) {
    super('The app-server read projection failed closed.')
    this.name = 'AppServerReadProjectionError'
  }
}

type WorkspaceRecord = Readonly<{
  id: string
  name: string
  path: string
  pathLabel: string
  comparisonPath: string
  foldedComparisonPath: string
}>

type ParsedThread = Readonly<{
  summary: ReadOnlyTaskSummary
  workspace: WorkspaceRecord
  branch: string | null
  turns: readonly ProjectedTurn[]
  activeTurnId: string | null
  compatibility: readonly ProjectionCompatibilityIssue[]
}>

const MISSING = Symbol('missing')

function fail(code: ProjectionErrorCode = 'protocol-error'): never {
  throw new AppServerReadProjectionError(code)
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      return false
    }
  }
  return true
}

function record(value: unknown): Record<string, unknown> {
  if (!isPlainDataRecord(value)) fail()
  return value
}

function ownValue(source: Record<string, unknown>, key: string): unknown | typeof MISSING {
  const descriptor = Object.getOwnPropertyDescriptor(source, key)
  return descriptor === undefined ? MISSING : descriptor.value
}

function boundedString(
  value: unknown,
  maxBytes: number,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    (!options.allowEmpty && value.length === 0) ||
    value.includes('\0') ||
    utf8Length(value) > maxBytes
  ) {
    fail()
  }
  return value
}

function identifier(value: unknown): string {
  return boundedString(value, LIMITS.maxIdentifierBytes)
}

function compatibilityType(value: unknown): string {
  const type = boundedString(value, 64)
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(type)) fail()
  return type
}

function boundedArray(value: unknown, maxItems: number): readonly unknown[] {
  if (!Array.isArray(value)) fail()
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value') ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      fail()
    }
    const length = lengthDescriptor.value
    if (length > maxItems) fail('resource-limit')
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== length + 1 ||
      keys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)))
    ) {
      fail()
    }
    const snapshot: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ) {
        fail()
      }
      snapshot.push(descriptor.value)
    }
    return Object.freeze(snapshot)
  } catch (error) {
    if (error instanceof AppServerReadProjectionError) throw error
    return fail()
  }
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') fail()
  return value
}

function unixSeconds(value: unknown): { readonly raw: number; readonly iso: string } {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > LIMITS.maxUnixSeconds
  ) {
    fail()
  }
  return Object.freeze({ raw: value, iso: new Date(value * 1_000).toISOString() })
}

function optionalUnixSeconds(value: unknown | typeof MISSING): string | null {
  if (value === MISSING || value === null) return null
  return unixSeconds(value).iso
}

function exactKeys(source: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(source)
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) fail()
}

function parseStatus(value: unknown): ProjectedThreadStatus {
  const source = record(value)
  const type = ownValue(source, 'type')
  if (type === 'notLoaded' || type === 'idle' || type === 'systemError') {
    exactKeys(source, ['type'])
    return Object.freeze({ type })
  }
  if (type !== 'active') fail()
  exactKeys(source, ['type', 'activeFlags'])
  const flags = boundedArray(ownValue(source, 'activeFlags'), 2)
  const projected: ('waitingOnApproval' | 'waitingOnUserInput')[] = []
  const seen = new Set<string>()
  for (const flag of flags) {
    if (flag !== 'waitingOnApproval' && flag !== 'waitingOnUserInput') fail()
    if (seen.has(flag)) fail()
    seen.add(flag)
    projected.push(flag)
  }
  return Object.freeze({ type: 'active', activeFlags: Object.freeze(projected) })
}

function parseSource(value: unknown): ProjectedThreadSource {
  if (
    value === 'cli' ||
    value === 'vscode' ||
    value === 'exec' ||
    value === 'appServer' ||
    value === 'unknown'
  ) {
    return value
  }
  const source = record(value)
  const keys = Object.keys(source)
  if (keys.length !== 1) fail()
  if (keys[0] === 'custom') {
    boundedString(ownValue(source, 'custom'), LIMITS.maxLabelBytes, { allowEmpty: true })
    return 'custom'
  }
  if (keys[0] === 'subAgent') {
    const subAgent = ownValue(source, 'subAgent')
    if (subAgent === MISSING || subAgent === null) fail()
    return 'subAgent'
  }
  return fail()
}

function parseNullableCursor(value: unknown | typeof MISSING): string | null {
  if (value === MISSING || value === null) return null
  return boundedString(value, LIMITS.maxCursorBytes)
}

function normalizeSafeAbsolutePath(
  value: unknown,
  errorCode: 'invalid-config' | 'unauthorized-workspace',
  allowRoot = false,
): string {
  const raw = boundedString(value, LIMITS.maxPathBytes)
  const normalized = windowsPath.normalize(raw)
  if (
    !windowsPath.isAbsolute(normalized) ||
    normalized.startsWith('\\\\?\\') ||
    normalized.startsWith('\\\\.\\')
  ) {
    fail(errorCode)
  }
  const root = windowsPath.parse(normalized).root
  const driveQualified = /^[A-Za-z]:\\$/.test(root)
  const uncQualified = /^\\\\[^\\]+\\[^\\]+\\$/.test(root)
  if (!driveQualified && !uncQualified) fail(errorCode)
  const withoutTrailingSeparators = normalized.replace(/[\\/]+$/, '')
  const rootWithoutTrailingSeparators = root.replace(/[\\/]+$/, '')
  if (!allowRoot && withoutTrailingSeparators === rootWithoutTrailingSeparators) fail(errorCode)
  return normalized
}

function normalizeWorkspacePath(value: unknown, allowRoot = false): string {
  return normalizeSafeAbsolutePath(value, 'invalid-config', allowRoot)
}

function comparisonPath(value: string): string {
  return windowsPath.normalize(value).replace(/[\\/]+$/, '')
}

function foldedComparisonPath(value: string): string {
  return comparisonPath(value).toLocaleLowerCase('en-US')
}

function parseWorkspace(input: AuthorizedWorkspace, allowRoot = false): WorkspaceRecord {
  const source = record(input)
  const id = boundedString(ownValue(source, 'id'), 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) fail('invalid-config')
  const name = boundedString(ownValue(source, 'name'), LIMITS.maxLabelBytes)
  const pathLabel = boundedString(ownValue(source, 'pathLabel'), LIMITS.maxLabelBytes)
  const path = normalizeWorkspacePath(ownValue(source, 'path'), allowRoot)
  return Object.freeze({
    id,
    name,
    path,
    pathLabel,
    comparisonPath: comparisonPath(path),
    foldedComparisonPath: foldedComparisonPath(path),
  })
}

function parseBranch(value: unknown | typeof MISSING): string | null {
  if (value === MISSING || value === null) return null
  const git = record(value)
  const branch = ownValue(git, 'branch')
  if (branch === MISSING || branch === null) return null
  return boundedString(branch, LIMITS.maxLabelBytes, { allowEmpty: true })
}

function parseTurnStatus(value: unknown): ProjectedTurnStatus {
  if (
    value !== 'completed' &&
    value !== 'interrupted' &&
    value !== 'failed' &&
    value !== 'inProgress'
  ) {
    fail()
  }
  return value
}

function itemBase(
  item: Record<string, unknown>,
  turnId: string,
  createdAt: string | null,
): TimelineItemBase & { readonly type: string } {
  return Object.freeze({
    id: identifier(ownValue(item, 'id')),
    type: compatibilityType(ownValue(item, 'type')),
    turnId,
    createdAt,
  })
}

function parseStringParts(value: unknown | typeof MISSING): readonly string[] {
  if (value === MISSING) return Object.freeze([])
  const values = boundedArray(value, LIMITS.maxPartsPerItem)
  return Object.freeze(
    values.map((part) => boundedString(part, LIMITS.maxTextBytes, { allowEmpty: true })),
  )
}

function parseCommandState(value: unknown): ProjectedCommandItem['state'] {
  if (value !== 'inProgress' && value !== 'completed' && value !== 'failed' && value !== 'declined') {
    fail()
  }
  return value
}

function parseToolState(value: unknown): ProjectedOperationItem['state'] {
  if (value !== 'inProgress' && value !== 'completed' && value !== 'failed') fail()
  return value
}

function durationSummary(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail()
  return `${String(value)} ms`
}

function projectChangePath(rawValue: unknown, workspacePath: string): string {
  const raw = boundedString(rawValue, LIMITS.maxPathBytes)
  let relative: string
  if (windowsPath.isAbsolute(raw)) {
    const candidate = comparisonPath(
      normalizeSafeAbsolutePath(raw, 'unauthorized-workspace'),
    )
    const workspace = comparisonPath(workspacePath)
    const prefix = `${workspace}\\`
    if (!candidate.startsWith(prefix)) fail('unauthorized-workspace')
    relative = candidate.slice(prefix.length)
  } else {
    if (/^[A-Za-z]:/.test(raw)) fail('unauthorized-workspace')
    relative = windowsPath.normalize(raw)
  }
  if (
    relative.length === 0 ||
    windowsPath.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${windowsPath.sep}`)
  ) {
    fail('unauthorized-workspace')
  }
  return relative.replaceAll('\\', '/')
}

function countDiff(diff: string): { readonly additions: number; readonly deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return Object.freeze({ additions, deletions })
}

function parsePatchKind(
  value: unknown,
  workspacePath: string,
): { readonly kind: 'add' | 'delete' | 'update'; readonly movePath: string | null } {
  const kind = record(value)
  const type = ownValue(kind, 'type')
  if (type !== 'add' && type !== 'delete' && type !== 'update') fail()
  if (type === 'add' || type === 'delete') {
    exactKeys(kind, ['type'])
    return Object.freeze({ kind: type, movePath: null })
  }
  const keys = Object.keys(kind)
  if (
    keys.some((key) => key !== 'type' && key !== 'move_path') ||
    keys.length < 1 ||
    keys.length > 2
  ) {
    fail()
  }
  const movePath = ownValue(kind, 'move_path')
  return Object.freeze({
    kind: 'update',
    movePath:
      movePath === MISSING || movePath === null
        ? null
        : projectChangePath(movePath, workspacePath),
  })
}

function projectItem(
  value: unknown,
  turnId: string,
  createdAt: string | null,
  workspacePath: string,
  issues: ProjectionCompatibilityIssue[],
  allowExternalAttachmentPaths = false,
): ProjectedTimelineItem {
  const item = record(value)
  const base = itemBase(item, turnId, createdAt)

  if (base.type === 'userMessage') {
    const rawInputs = boundedArray(ownValue(item, 'content'), LIMITS.maxInputsPerMessage)
    const inputs: ProjectedUserItem['inputs'][number][] = []
    for (const rawInput of rawInputs) {
      const input = record(rawInput)
      const inputType = compatibilityType(ownValue(input, 'type'))
      if (inputType === 'text') {
        const rawText = boundedString(ownValue(input, 'text'), LIMITS.maxTextBytes, {
          allowEmpty: true,
        })
        const elements = boundedArray(ownValue(input, 'text_elements'), LIMITS.maxPartsPerItem)
        const placeholders: string[] = []
        for (const rawElement of elements) {
          const element = record(rawElement)
          const range = record(ownValue(element, 'byteRange'))
          const start = ownValue(range, 'start')
          const end = ownValue(range, 'end')
          const placeholder = ownValue(element, 'placeholder')
          if (
            !Number.isSafeInteger(start)
            || !Number.isSafeInteger(end)
            || Number(start) < 0
            || Number(end) <= Number(start)
            || Number(end) > Buffer.byteLength(rawText, 'utf8')
            || (placeholder !== null && typeof placeholder !== 'string')
          ) fail()
          placeholders.push(placeholder === null
            ? 'attachment'
            : boundedString(placeholder, LIMITS.maxLabelBytes))
        }
        inputs.push(
          Object.freeze({
            type: 'text',
            text: placeholders.length === 0
              ? rawText
              : placeholders.map(placeholder => `[File: ${placeholder}]`).join('\n'),
          }),
        )
      } else if (inputType === 'localImage' || inputType === 'mention') {
        const rawPath = boundedString(ownValue(input, 'path'), LIMITS.maxPathBytes)
        const visibleName = allowExternalAttachmentPaths
          ? inputType === 'mention'
            ? boundedString(ownValue(input, 'name'), LIMITS.maxLabelBytes)
            : boundedString(windowsPath.basename(windowsPath.normalize(rawPath)), LIMITS.maxLabelBytes)
          : undefined
        const relativePath = allowExternalAttachmentPaths
          ? undefined
          : projectChangePath(rawPath, workspacePath)
        inputs.push(Object.freeze({
          type: inputType === 'localImage' ? 'localImage' : 'file',
          name: visibleName ?? (inputType === 'mention'
            ? boundedString(ownValue(input, 'name'), LIMITS.maxLabelBytes)
            : windowsPath.basename(relativePath!)),
        }))
      } else {
        issues.push(
          Object.freeze({
            code: 'unsupported-input',
            turnId,
            itemId: base.id,
            itemType: inputType,
          }),
        )
        inputs.push(Object.freeze({ type: 'compatibility', inputType }))
      }
    }
    return Object.freeze({
      kind: 'user',
      id: base.id,
      turnId,
      createdAt,
      inputs: Object.freeze(inputs),
    })
  }

  if (base.type === 'agentMessage') {
    const phase = ownValue(item, 'phase')
    if (phase !== MISSING && phase !== null && phase !== 'commentary' && phase !== 'final_answer') {
      fail()
    }
    return Object.freeze({
      kind: 'assistant',
      id: base.id,
      turnId,
      createdAt,
      text: boundedString(ownValue(item, 'text'), LIMITS.maxTextBytes, { allowEmpty: true }),
      phase: phase === 'commentary' || phase === 'final_answer' ? phase : 'unknown',
    })
  }

  if (base.type === 'plan') {
    return Object.freeze({
      kind: 'plan',
      id: base.id,
      turnId,
      createdAt,
      text: boundedString(ownValue(item, 'text'), LIMITS.maxTextBytes, { allowEmpty: true }),
    })
  }

  if (base.type === 'reasoning') {
    parseStringParts(ownValue(item, 'content'))
    return Object.freeze({
      kind: 'reasoning',
      id: base.id,
      turnId,
      createdAt,
      summary: parseStringParts(ownValue(item, 'summary')),
    })
  }

  if (base.type === 'commandExecution') {
    const output = ownValue(item, 'aggregatedOutput')
    return Object.freeze({
      kind: 'command',
      id: base.id,
      turnId,
      createdAt,
      command: boundedString(ownValue(item, 'command'), LIMITS.maxTextBytes, {
        allowEmpty: true,
      }),
      output:
        output === MISSING || output === null
          ? null
          : boundedString(output, LIMITS.maxTextBytes, { allowEmpty: true }),
      state: parseCommandState(ownValue(item, 'status')),
    })
  }

  if (base.type === 'fileChange') {
    const state = parseCommandState(ownValue(item, 'status'))
    const rawChanges = boundedArray(ownValue(item, 'changes'), LIMITS.maxChangesPerItem)
    const changes = rawChanges.map((rawChange) => {
      const change = record(rawChange)
      const diff = boundedString(ownValue(change, 'diff'), LIMITS.maxTextBytes, {
        allowEmpty: true,
      })
      const counts = countDiff(diff)
      const patchKind = parsePatchKind(ownValue(change, 'kind'), workspacePath)
      return Object.freeze({
        path: projectChangePath(ownValue(change, 'path'), workspacePath),
        kind: patchKind.kind,
        movePath: patchKind.movePath,
        additions: counts.additions,
        deletions: counts.deletions,
      })
    })
    return Object.freeze({
      kind: 'fileChange',
      id: base.id,
      turnId,
      createdAt,
      state,
      changes: Object.freeze(changes),
    })
  }

  if (base.type === 'webSearch') {
    const rawAction = ownValue(item, 'action')
    let actionType: ProjectedWebSearchItem['actionType'] = 'other'
    if (rawAction !== MISSING && rawAction !== null) {
      const action = record(rawAction)
      const value = ownValue(action, 'type')
      actionType = value === 'search' || value === 'openPage' || value === 'findInPage'
        ? value
        : 'other'
    }
    return Object.freeze({
      kind: 'webSearch',
      id: base.id,
      turnId,
      createdAt,
      query: boundedString(ownValue(item, 'query'), LIMITS.maxTextBytes, { allowEmpty: true }),
      actionType,
    })
  }

  if (base.type === 'hookPrompt') {
    const fragments = boundedArray(ownValue(item, 'fragments'), LIMITS.maxPartsPerItem)
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Hook prompt', summary: `${fragments.length} fragments`, state: 'completed',
    })
  }

  if (base.type === 'mcpToolCall') {
    const server = boundedString(ownValue(item, 'server'), LIMITS.maxLabelBytes)
    const tool = boundedString(ownValue(item, 'tool'), LIMITS.maxLabelBytes)
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: `MCP · ${server}`, summary: tool, state: parseToolState(ownValue(item, 'status')),
    })
  }

  if (base.type === 'dynamicToolCall') {
    const namespace = ownValue(item, 'namespace')
    const tool = boundedString(ownValue(item, 'tool'), LIMITS.maxLabelBytes)
    const prefix = namespace === MISSING || namespace === null
      ? 'Tool'
      : boundedString(namespace, LIMITS.maxLabelBytes)
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: prefix, summary: tool, state: parseToolState(ownValue(item, 'status')),
    })
  }

  if (base.type === 'collabAgentToolCall') {
    const tool = compatibilityType(ownValue(item, 'tool'))
    boundedArray(ownValue(item, 'receiverThreadIds'), LIMITS.maxPartsPerItem)
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Sub-agent', summary: tool, state: parseToolState(ownValue(item, 'status')),
    })
  }

  if (base.type === 'subAgentActivity') {
    const kind = ownValue(item, 'kind')
    if (kind !== 'started' && kind !== 'interacted' && kind !== 'interrupted') fail()
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Sub-agent activity', summary: kind,
      state: kind === 'started' ? 'inProgress' : kind === 'interrupted' ? 'failed' : 'completed',
    })
  }

  if (base.type === 'imageView') {
    if (ownValue(item, 'path') === MISSING) fail()
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Image viewed', summary: 'completed', state: 'completed',
    })
  }

  if (base.type === 'sleep') {
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Wait', summary: durationSummary(ownValue(item, 'durationMs')), state: 'completed',
    })
  }

  if (base.type === 'imageGeneration') {
    const status = boundedString(ownValue(item, 'status'), 64)
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Image generation', summary: status,
      state: status === 'inProgress' ? 'inProgress' : status === 'failed' ? 'failed' : 'completed',
    })
  }

  if (base.type === 'enteredReviewMode' || base.type === 'exitedReviewMode') {
    boundedString(ownValue(item, 'review'), LIMITS.maxTextBytes, { allowEmpty: true })
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: base.type === 'enteredReviewMode' ? 'Entered review mode' : 'Exited review mode',
      summary: 'completed', state: 'completed',
    })
  }

  if (base.type === 'contextCompaction') {
    return Object.freeze({
      kind: 'operation', id: base.id, turnId, createdAt, itemType: base.type,
      title: 'Context compacted', summary: 'completed', state: 'completed',
    })
  }

  issues.push(
    Object.freeze({
      code: 'unsupported-item',
      turnId,
      itemId: base.id,
      itemType: base.type,
    }),
  )
  return Object.freeze({
    kind: 'compatibility',
    id: base.id,
    turnId,
    createdAt,
    itemType: base.type,
    state: 'read-only',
  })
}

function parseTurn(
  value: unknown,
  workspacePath: string,
  turnIds: Set<string>,
  itemIds: Set<string>,
  issues: ProjectionCompatibilityIssue[],
  allowSummaryItemsView = false,
): ProjectedTurn {
  const turn = record(value)
  const id = identifier(ownValue(turn, 'id'))
  if (turnIds.has(id)) fail()
  turnIds.add(id)
  const status = parseTurnStatus(ownValue(turn, 'status'))
  const itemsView = ownValue(turn, 'itemsView')
  if (
    itemsView !== MISSING
    && itemsView !== 'full'
    && !(allowSummaryItemsView && itemsView === 'summary')
  ) fail()
  const startedAt = optionalUnixSeconds(ownValue(turn, 'startedAt'))
  const completedAt = optionalUnixSeconds(ownValue(turn, 'completedAt'))
  const rawItems = boundedArray(ownValue(turn, 'items'), LIMITS.maxItemsPerTurn)
  const items = rawItems.map((rawItem) => {
    const projected = projectItem(
      rawItem,
      id,
      null,
      workspacePath,
      issues,
      allowSummaryItemsView,
    )
    if (itemIds.has(projected.id)) fail()
    itemIds.add(projected.id)
    return projected
  })
  return Object.freeze({
    id,
    status,
    startedAt,
    completedAt,
    items: Object.freeze(items),
  })
}

function parseThread(
  value: unknown,
  resolveWorkspace: (cwd: string) => WorkspaceRecord,
  options: {
    readonly requireEmptyTurns: boolean
    readonly allowSummaryItemsView?: boolean
  },
): ParsedThread {
  const thread = record(value)
  const id = identifier(ownValue(thread, 'id'))
  identifier(ownValue(thread, 'sessionId'))
  const preview = boundedString(ownValue(thread, 'preview'), LIMITS.maxLabelBytes, {
    allowEmpty: true,
  })
  const ephemeral = booleanValue(ownValue(thread, 'ephemeral'))
  const modelProvider = boundedString(ownValue(thread, 'modelProvider'), LIMITS.maxLabelBytes)
  const created = unixSeconds(ownValue(thread, 'createdAt'))
  const updated = unixSeconds(ownValue(thread, 'updatedAt'))
  if (updated.raw < created.raw) fail()
  boundedString(ownValue(thread, 'cliVersion'), LIMITS.maxLabelBytes, { allowEmpty: true })
  const source = parseSource(ownValue(thread, 'source'))
  const status = parseStatus(ownValue(thread, 'status'))
  const cwd = normalizeSafeAbsolutePath(ownValue(thread, 'cwd'), 'unauthorized-workspace', true)
  const workspace = resolveWorkspace(cwd)

  const nameValue = ownValue(thread, 'name')
  const name =
    nameValue === MISSING || nameValue === null
      ? null
      : boundedString(nameValue, LIMITS.maxLabelBytes, { allowEmpty: true })
  const title = (name !== null && name.length > 0 ? name : preview).slice(0, 256)
  const turnsValue = boundedArray(ownValue(thread, 'turns'), LIMITS.maxTurnsPerThread)
  if (options.requireEmptyTurns && turnsValue.length !== 0) fail()
  const issues: ProjectionCompatibilityIssue[] = []
  const turnIds = new Set<string>()
  const itemIds = new Set<string>()
  const turns = turnsValue.map((turn) =>
    parseTurn(turn, workspace.path, turnIds, itemIds, issues, options.allowSummaryItemsView === true),
  )
  const activeTurns = turns.filter((turn) => turn.status === 'inProgress')
  if (activeTurns.length > 1) fail()
  if (status.type === 'active' && !options.requireEmptyTurns && activeTurns.length !== 1) fail()
  if (status.type !== 'active' && activeTurns.length !== 0) fail()

  const summary = Object.freeze({
    id,
    workspaceId: workspace.id,
    title,
    status,
    createdAt: created.iso,
    updatedAt: updated.iso,
    ephemeral,
    modelProvider,
    source,
  })
  return Object.freeze({
    summary,
    workspace,
    branch: parseBranch(ownValue(thread, 'gitInfo')),
    turns: Object.freeze(turns),
    activeTurnId: activeTurns[0]?.id ?? null,
    compatibility: Object.freeze(issues),
  })
}

function validatePageSize(value: number | undefined): number {
  const selected = value ?? LIMITS.defaultTasksPerPage
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > LIMITS.maxTasksPerPage) {
    fail('invalid-config')
  }
  return selected
}

function validateTaskId(value: unknown): string {
  try {
    return identifier(value)
  } catch (error) {
    if (error instanceof AppServerReadProjectionError) fail('invalid-input')
    throw error
  }
}

function validateCursor(value: unknown): string {
  try {
    return boundedString(value, LIMITS.maxCursorBytes)
  } catch (error) {
    if (error instanceof AppServerReadProjectionError) fail('invalid-input')
    throw error
  }
}

function encodeThreadListCursor(archived: boolean, cursor: string | null): string {
  return `threads-${archived ? 'archived' : 'active'}:${Buffer.from(cursor ?? '', 'utf8').toString('base64url')}`
}

function parseThreadListCursor(value: string | undefined): Readonly<{ archived: boolean; cursor: string | null }> {
  if (value === undefined) return Object.freeze({ archived: false, cursor: null })
  validateCursor(value)
  const match = /^threads-(active|archived):([A-Za-z0-9_-]*)$/u.exec(value)
  if (match === null) fail('invalid-input')
  let cursor: string
  try { cursor = Buffer.from(match[2]!, 'base64url').toString('utf8') } catch { fail('invalid-input') }
  if (Buffer.from(cursor, 'utf8').toString('base64url') !== match[2]) fail('invalid-input')
  return Object.freeze({ archived: match[1] === 'archived', cursor: cursor || null })
}

export class AppServerReadProjection {
  private readonly supervisor: AppServerSupervisor
  private readonly workspaces: readonly WorkspaceRecord[]
  private readonly workspacesByPath: Map<string, WorkspaceRecord>
  private readonly pageSize: number
  private readonly allowAllLocalThreads: boolean
  private readonly paginateTurns: boolean
  private readonly ownedActiveTasks = new Map<string, ReadOnlyTaskProjection>()

  constructor(config: ReadProjectionConfig) {
    try {
      const source = record(config)
      const supervisor = ownValue(source, 'supervisor')
      if (!(supervisor instanceof AppServerSupervisor)) fail('invalid-config')
      const rawWorkspaces = boundedArray(ownValue(source, 'workspaces'), LIMITS.maxWorkspaces)
      if (rawWorkspaces.length === 0) fail('invalid-config')
      const workspaces = rawWorkspaces.map((workspace) =>
        parseWorkspace(workspace as AuthorizedWorkspace),
      )
      const ids = new Set<string>()
      const paths = new Set<string>()
      for (const workspace of workspaces) {
      if (ids.has(workspace.id) || paths.has(workspace.foldedComparisonPath)) {
        fail('invalid-config')
      }
      ids.add(workspace.id)
      paths.add(workspace.foldedComparisonPath)
      }
      const pageSizeValue = ownValue(source, 'pageSize')
      const allowAllValue = ownValue(source, 'allowAllLocalThreads')
      const paginateTurnsValue = ownValue(source, 'paginateTurns')
      if (allowAllValue !== MISSING && typeof allowAllValue !== 'boolean') fail('invalid-config')
      if (paginateTurnsValue !== MISSING && typeof paginateTurnsValue !== 'boolean') fail('invalid-config')
      this.supervisor = supervisor
      this.workspaces = Object.freeze(workspaces)
      this.workspacesByPath = new Map(
        workspaces.map((workspace) => [workspace.comparisonPath, workspace]),
      )
      this.pageSize = validatePageSize(
        pageSizeValue === MISSING ? undefined : (pageSizeValue as number),
      )
      this.allowAllLocalThreads = allowAllValue === true
      this.paginateTurns = paginateTurnsValue === true
    } catch (error) {
      if (error instanceof AppServerReadProjectionError && error.code !== 'invalid-config') {
        fail('invalid-config')
      }
      throw error
    }
  }

  listAuthorizedWorkspaces(): readonly ReadOnlyWorkspaceSummary[] {
    return Object.freeze([...this.workspacesByPath.values()].map((workspace) => Object.freeze({
      id: workspace.id,
      name: workspace.name,
      pathLabel: workspace.pathLabel,
    })))
  }

  private readonly resolveWorkspace = (cwd: string): WorkspaceRecord => {
    const key = comparisonPath(cwd)
    const known = this.workspacesByPath.get(key)
    if (known !== undefined) return known
    if (!this.allowAllLocalThreads) fail('unauthorized-workspace')
    if (this.workspacesByPath.size >= LIMITS.maxKnownWorkspaces) fail('resource-limit')
    const existing = [...this.workspacesByPath.values()]
    // The durable action journal binds task.workspaceId across process restarts.
    // Discovery-order counters would make existing tasks fail that binding.
    const id = `workspace.local.${createHash('sha256').update(key, 'utf8').digest('hex')}`
    if (existing.some(workspace => workspace.id === id)) fail('invalid-config')
    const baseName = windowsPath.basename(key) || `磁盘 ${key.slice(0, 1).toUpperCase()}`
    let name = baseName
    for (let suffix = 2; existing.some(workspace => workspace.name === name); suffix += 1) {
      name = `${baseName} (${suffix})`
    }
    const workspace = parseWorkspace({ id, name, path: cwd, pathLabel: name }, true)
    this.workspacesByPath.set(key, workspace)
    return workspace
  }

  registerOwnedActiveTask(seed: OwnedActiveTaskSeed): void {
    const taskId = validateTaskId(seed.taskId)
    const workspaceId = identifier(seed.workspaceId)
    const actionId = identifier(seed.actionId)
    const turnId = identifier(seed.turnId)
    const title = boundedString(seed.title, 256)
    const text = boundedString(seed.text, LIMITS.maxTextBytes, { allowEmpty: true })
    if (
      !Number.isSafeInteger(seed.now)
      || seed.now < 0
      || seed.now > LIMITS.maxUnixSeconds * 1_000
    ) fail('invalid-input')
    const workspace = this.workspaces.find(value => value.id === workspaceId)
    if (workspace === undefined) fail('unauthorized-workspace')
    const timestamp = new Date(seed.now).toISOString()
    this.ownedActiveTasks.set(taskId, Object.freeze({
      authoritative: false,
      schemaVersion: APP_SERVER_SCHEMA_VERSION,
      completeness: 'full',
      task: Object.freeze({
        id: taskId,
        workspaceId,
        title,
        status: Object.freeze({ type: 'active', activeFlags: Object.freeze([]) }),
        createdAt: timestamp,
        updatedAt: timestamp,
        ephemeral: false,
        modelProvider: 'openai',
        source: 'appServer',
      }),
      workspace: Object.freeze({ id: workspace.id, name: workspace.name, pathLabel: workspace.pathLabel }),
      branch: null,
      activeTurnId: turnId,
      turns: Object.freeze([Object.freeze({
        id: turnId,
        status: 'inProgress',
        startedAt: timestamp,
        completedAt: null,
        items: Object.freeze([Object.freeze({
          kind: 'user',
          id: actionId,
          turnId,
          createdAt: null,
          inputs: Object.freeze([Object.freeze({ type: 'text', text })]),
        })]),
      })]),
      compatibility: Object.freeze([]),
    }))
  }

  async listTasks(cursor?: string): Promise<ReadOnlyTaskPage> {
    const scopedCursor = this.allowAllLocalThreads ? parseThreadListCursor(cursor) : undefined
    const validatedCursor = scopedCursor === undefined
      ? cursor === undefined ? null : validateCursor(cursor)
      : scopedCursor.cursor
    const result = await this.supervisor.request<unknown>('thread/list' satisfies AppServerMethod, {
      cursor: validatedCursor,
      limit: this.pageSize,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      archived: scopedCursor?.archived ?? false,
      ...(this.allowAllLocalThreads ? {
        modelProviders: [],
        // ThreadSourceKind from the pinned official app-server schema. Empty
        // sourceKinds would silently restrict results to interactive clients.
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
      } : { cwd: this.workspaces.map((workspace) => workspace.path) }),
      useStateDbOnly: true,
    })
    const response = record(result)
    const rawThreads = boundedArray(ownValue(response, 'data'), this.pageSize)
    const upstreamNextCursor = parseNullableCursor(ownValue(response, 'nextCursor'))
    parseNullableCursor(ownValue(response, 'backwardsCursor'))
    const seen = new Set<string>()
    const tasks = rawThreads.map((thread) => {
      const parsed = parseThread(thread, this.resolveWorkspace, {
        requireEmptyTurns: true,
      })
      if (seen.has(parsed.summary.id)) fail()
      seen.add(parsed.summary.id)
      return parsed.summary
    })
    return Object.freeze({
      authoritative: false,
      schemaVersion: APP_SERVER_SCHEMA_VERSION,
      tasks: Object.freeze(tasks),
      nextCursor: this.allowAllLocalThreads
        ? upstreamNextCursor === null
          ? scopedCursor?.archived === true ? null : encodeThreadListCursor(true, null)
          : encodeThreadListCursor(scopedCursor?.archived === true, upstreamNextCursor)
        : upstreamNextCursor,
    })
  }

  async readTask(
    taskId: string,
    options: Readonly<{ full?: boolean }> = {},
  ): Promise<ReadOnlyTaskProjection> {
    const validatedTaskId = validateTaskId(taskId)
    const paginateTurns = this.paginateTurns && options.full !== true
    let result: unknown
    try {
      result = await this.supervisor.request<unknown>('thread/read' satisfies AppServerMethod, {
        threadId: validatedTaskId,
        includeTurns: !paginateTurns,
      })
    } catch (error) {
      const active = this.ownedActiveTasks.get(validatedTaskId)
      if (active !== undefined && error instanceof AppServerRpcError && error.code === -32603) {
        return active
      }
      throw error
    }
    const response = record(result)
    const rawThread = record(ownValue(response, 'thread'))
    const rawModel = ownValue(rawThread, 'model')
    const rawEffort = ownValue(rawThread, 'reasoningEffort')
    const model = rawModel === MISSING || rawModel === null ? undefined : boundedString(rawModel, 128)
    const effort = rawEffort === MISSING || rawEffort === null ? undefined : boundedString(rawEffort, 32)
    let parsed: ParsedThread
    let paginatedTurnsComplete = !paginateTurns
    if (!paginateTurns) {
      parsed = parseThread(rawThread, this.resolveWorkspace, {
        requireEmptyTurns: false,
      })
    } else {
      const metadata = parseThread(rawThread, this.resolveWorkspace, {
        requireEmptyTurns: true,
      })
      const turns: ProjectedTurn[] = []
      const issues: ProjectionCompatibilityIssue[] = []
      const turnIds = new Set<string>()
      const itemIds = new Set<string>()
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      for (let pageIndex = 0; pageIndex < LIMITS.maxTurnPages; pageIndex += 1) {
        const pageResult = await this.supervisor.request<unknown>('thread/turns/list' satisfies AppServerMethod, {
          threadId: validatedTaskId,
          cursor,
          limit: LIMITS.turnsPerPage,
          sortDirection: 'desc',
          itemsView: 'summary',
        })
        const page = record(pageResult)
        const pageTurns = boundedArray(ownValue(page, 'data'), LIMITS.turnsPerPage)
        for (const rawTurn of pageTurns) {
          if (turns.length >= LIMITS.maxTurnsPerThread) fail('resource-limit')
          turns.push(parseTurn(
            rawTurn,
            metadata.workspace.path,
            turnIds,
            itemIds,
            issues,
            true,
          ))
        }
        const nextCursor = parseNullableCursor(ownValue(page, 'nextCursor'))
        parseNullableCursor(ownValue(page, 'backwardsCursor'))
        if (nextCursor === null) {
          paginatedTurnsComplete = true
          break
        }
        if (seenCursors.has(nextCursor)) fail()
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
      turns.reverse()
      const activeTurns = turns.filter(turn => turn.status === 'inProgress')
      if (activeTurns.length > 1) fail()
      parsed = Object.freeze({
        summary: metadata.summary,
        workspace: metadata.workspace,
        branch: metadata.branch,
        turns: Object.freeze(turns),
        activeTurnId: metadata.summary.status.type === 'active' ? activeTurns[0]?.id ?? null : null,
        compatibility: Object.freeze(issues),
      })
    }
    if (parsed.summary.id !== validatedTaskId) fail('task-mismatch')
    if (parsed.summary.status.type !== 'active') this.ownedActiveTasks.delete(validatedTaskId)
    return Object.freeze({
      authoritative: false,
      schemaVersion: APP_SERVER_SCHEMA_VERSION,
      completeness: !paginatedTurnsComplete || parsed.compatibility.length > 0 ? 'partial' : 'full',
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      task: parsed.summary,
      workspace: Object.freeze({
        id: parsed.workspace.id,
        name: parsed.workspace.name,
        pathLabel: parsed.workspace.pathLabel,
      }),
      branch: parsed.branch,
      activeTurnId: parsed.activeTurnId,
      turns: parsed.turns,
      compatibility: parsed.compatibility,
    })
  }
}
