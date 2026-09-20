import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { win32 as windowsPath } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'

const APPLICATION_ID = 0x43505841
const SCHEMA_VERSION = 1
const DATABASE_BYTES_LIMIT = 32 * 1024 * 1024
const WAL_BYTES_LIMIT = 32 * 1024 * 1024
const DATABASE_PAGE_SIZE = 4 * 1024
const DATABASE_PAGE_LIMIT = DATABASE_BYTES_LIMIT / DATABASE_PAGE_SIZE
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/
const MAX_ENCRYPTED_FRAME_BYTES = 512 * 1024

const HARD_LIMITS = Object.freeze({
  authorizations: 64,
  tasks: 256,
  actions: 2_048,
  outboundFramesPerChannel: 16,
  outboundBytes: 8 * 1024 * 1024,
})

const TABLE_STATEMENTS = Object.freeze([
  `CREATE TABLE store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    store_id TEXT NOT NULL CHECK (length(store_id) BETWEEN 1 AND 128),
    state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
    boot_id TEXT NOT NULL CHECK (length(boot_id) BETWEEN 1 AND 128)
  ) STRICT`,
  `CREATE TABLE authorizations (
    host_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    client_device_id TEXT NOT NULL,
    authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    PRIMARY KEY (host_id, authorization_id)
  ) STRICT`,
  `CREATE TABLE channels (
    host_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch > 0),
    connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
    inbound_key_id TEXT NOT NULL,
    outbound_key_id TEXT NOT NULL,
    last_inbound_sequence INTEGER NOT NULL CHECK (last_inbound_sequence >= 1),
    last_peer_ack INTEGER NOT NULL CHECK (last_peer_ack >= 0),
    max_sent_sequence INTEGER NOT NULL CHECK (max_sent_sequence >= 1),
    PRIMARY KEY (
      host_id,
      authorization_id,
      authorization_epoch,
      connection_generation,
      inbound_key_id
    ),
    FOREIGN KEY (host_id, authorization_id)
      REFERENCES authorizations(host_id, authorization_id)
      ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE outbound_frames (
    host_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch > 0),
    connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
    inbound_key_id TEXT NOT NULL,
    outbound_key_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 2),
    encrypted_wire_text TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length > 0 AND byte_length <= 524288),
    PRIMARY KEY (
      host_id,
      authorization_id,
      authorization_epoch,
      connection_generation,
      outbound_key_id,
      sequence
    ),
    FOREIGN KEY (
      host_id,
      authorization_id,
      authorization_epoch,
      connection_generation,
      inbound_key_id
    ) REFERENCES channels(
      host_id,
      authorization_id,
      authorization_epoch,
      connection_generation,
      inbound_key_id
    ) ON DELETE RESTRICT
  ) STRICT`,
  `CREATE TABLE tasks (
    host_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    write_state TEXT NOT NULL CHECK (write_state IN ('writable', 'read-only', 'blocked-indeterminate')),
    can_send INTEGER NOT NULL CHECK (can_send IN (0, 1)),
    can_interrupt INTEGER NOT NULL CHECK (can_interrupt IN (0, 1)),
    blocked_action_id TEXT,
    CHECK (
      (write_state = 'blocked-indeterminate' AND blocked_action_id IS NOT NULL)
      OR (write_state != 'blocked-indeterminate' AND blocked_action_id IS NULL)
    ),
    PRIMARY KEY (host_id, task_id)
  ) STRICT`,
  `CREATE TABLE actions (
    host_id TEXT NOT NULL,
    authorization_id TEXT NOT NULL,
    client_device_id TEXT NOT NULL,
    action_id TEXT NOT NULL,
    authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch > 0),
    first_connection_generation INTEGER NOT NULL CHECK (first_connection_generation > 0),
    first_inbound_key_id TEXT NOT NULL,
    first_inbound_sequence INTEGER NOT NULL CHECK (first_inbound_sequence >= 2),
    task_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('turn.send', 'turn.steer', 'turn.interrupt')),
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    request_fingerprint TEXT NOT NULL CHECK (
      length(request_fingerprint) = 43
      AND request_fingerprint NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatching', 'accepted', 'rejected', 'indeterminate')),
    row_version INTEGER NOT NULL CHECK (row_version > 0),
    supervisor_generation INTEGER CHECK (supervisor_generation > 0),
    result_revision INTEGER CHECK (result_revision >= 0),
    rejection_code TEXT,
    rejection_message TEXT CHECK (rejection_message IS NULL OR length(rejection_message) <= 512),
    indeterminate_reason TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (
      (state = 'reserved' AND supervisor_generation IS NULL AND result_revision IS NULL AND rejection_code IS NULL AND rejection_message IS NULL AND indeterminate_reason IS NULL)
      OR (state = 'dispatching' AND supervisor_generation IS NOT NULL AND result_revision IS NULL AND rejection_code IS NULL AND rejection_message IS NULL AND indeterminate_reason IS NULL)
      OR (state = 'accepted' AND supervisor_generation IS NOT NULL AND rejection_code IS NULL AND rejection_message IS NULL AND indeterminate_reason IS NULL)
      OR (state = 'rejected' AND rejection_code IS NOT NULL AND rejection_message IS NOT NULL AND result_revision IS NULL AND indeterminate_reason IS NULL)
      OR (state = 'indeterminate' AND supervisor_generation IS NOT NULL AND result_revision IS NULL AND rejection_code IS NULL AND rejection_message IS NULL AND indeterminate_reason IS NOT NULL)
    ),
    PRIMARY KEY (host_id, authorization_id, client_device_id, action_id),
    FOREIGN KEY (host_id, authorization_id)
      REFERENCES authorizations(host_id, authorization_id)
      ON DELETE RESTRICT
  ) STRICT`,
])

const INDEX_STATEMENTS = Object.freeze([
  'CREATE INDEX actions_by_task_state ON actions(host_id, task_id, state)',
  'CREATE INDEX outbound_frames_by_ack ON outbound_frames(host_id, authorization_id, authorization_epoch, connection_generation, outbound_key_id, sequence)',
])

type ActionStateErrorCode =
  | 'invalid-config'
  | 'unsafe-path'
  | 'already-exists'
  | 'missing-store'
  | 'invalid-store'
  | 'storage-failed'
  | 'backpressure'
  | 'capacity-exceeded'
  | 'stale-authority'
  | 'sequence-gap'
  | 'replay'
  | 'ack-regression'
  | 'ack-ahead'
  | 'action-id-conflict'
  | 'invalid-capability'
  | 'invalid-transition'
  | 'rollback-detected'
  | 'closed'

export class ActionStateError extends Error {
  constructor(readonly code: ActionStateErrorCode) {
    super(`Durable action state failed closed: ${code}.`)
    this.name = 'ActionStateError'
  }
}

export interface ActionStateConfig {
  readonly workspaceRoot: string
  readonly databasePath: string
}

export interface ActionStateMetadata {
  readonly storeId: string
  readonly stateRevision: number
}

interface EffectiveLimits {
  readonly authorizations: number
  readonly tasks: number
  readonly actions: number
  readonly outboundFramesPerChannel: number
  readonly outboundBytes: number
}

/** Package-private test seam. It can only reduce production hard limits. */
export type ActionStateTestLimits = Partial<EffectiveLimits>

export interface AuthorizationRecordInput {
  readonly hostId: string
  readonly authorizationId: string
  readonly clientDeviceId: string
  readonly authorizationEpoch: number
  readonly status: 'active' | 'revoked'
  readonly connectionGeneration: number
  readonly revision: number
}

export interface ChannelActivationInput {
  readonly hostId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly connectionGeneration: number
  readonly inboundKeyId: string
  readonly outboundKeyId: string
  readonly lastInboundSequence: number
  readonly lastPeerAck: number
  readonly maxSentSequence: number
}

export interface TaskStateInput {
  readonly hostId: string
  readonly taskId: string
  readonly workspaceId: string
  readonly revision: number
  readonly writeState: 'writable' | 'read-only'
  readonly canSend: boolean
  readonly canInterrupt: boolean
}

export interface OutboundFrameInput {
  readonly hostId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly connectionGeneration: number
  readonly inboundKeyId: string
  readonly outboundKeyId: string
  readonly sequence: number
  readonly encryptedWireText: string
}

export interface InboundActionReservationInput {
  readonly hostId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly clientDeviceId: string
  readonly connectionGeneration: number
  readonly inboundKeyId: string
  readonly sequence: number
  readonly ack: number
  readonly actionId: string
  readonly taskId: string
  readonly operation: 'turn.send' | 'turn.steer' | 'turn.interrupt'
  readonly expectedRevision: number
  /** Opaque keyed fingerprint minted by the later protected inbound bridge. */
  readonly requestFingerprint: string
  readonly now: number
}

export interface InboundReadOnlyCommitInput {
  readonly hostId: string
  readonly authorizationId: string
  readonly authorizationEpoch: number
  readonly clientDeviceId: string
  readonly connectionGeneration: number
  readonly inboundKeyId: string
  readonly sequence: number
  readonly ack: number
}

export interface DurableActionLease {
  readonly kind: 'durable-action-lease'
  readonly [actionLeaseBrand]: never
}

export interface DurableDispatchCapability {
  readonly kind: 'durable-dispatch-capability'
  readonly [dispatchBrand]: never
}

export interface DurableTerminalEvidence {
  readonly kind: 'durable-terminal-evidence'
  readonly [terminalEvidenceBrand]: never
}

export type StoredActionReceipt =
  | {
      readonly actionId: string
      readonly state: 'accepted'
      readonly revision?: number
    }
  | {
      readonly actionId: string
      readonly state: 'rejected'
      readonly rejection: Readonly<{ code: string; message: string }>
    }
  | {
      readonly actionId: string
      readonly state: 'queued'
      readonly recoveryRequired: true
    }

export type InboundReservationResult =
  | {
      readonly kind: 'claimed'
      readonly lease: DurableActionLease
      readonly replayed: boolean
    }
  | {
      readonly kind: 'terminal'
      readonly receipt: StoredActionReceipt
    }

export type BeginDispatchResult =
  | {
      readonly kind: 'dispatching'
      readonly dispatch: DurableDispatchCapability
    }
  | {
      readonly kind: 'rejected'
      readonly receipt: Extract<StoredActionReceipt, { state: 'rejected' }>
    }

export interface ActionStatusSnapshot {
  readonly actionId: string
  readonly taskId: string
  readonly operation: 'turn.send' | 'turn.steer' | 'turn.interrupt'
  readonly authorizationEpoch: number
  readonly firstConnectionGeneration: number
  readonly firstInboundKeyId: string
  readonly firstInboundSequence: number
  readonly state: 'reserved' | 'dispatching' | 'accepted' | 'rejected' | 'indeterminate'
  readonly rowVersion: number
  readonly supervisorGeneration?: number
  readonly receipt?: StoredActionReceipt
}

export interface ChannelStateSnapshot {
  readonly lastInboundSequence: number
  readonly lastPeerAck: number
  readonly maxSentSequence: number
  readonly outboundFrameCount: number
  readonly outboundFrameBytes: number
}

export interface DurableTaskStateSnapshot {
  readonly taskId: string
  readonly workspaceId: string
  readonly revision: number
  readonly writeState: 'writable' | 'read-only' | 'blocked-indeterminate'
  readonly canSend: boolean
  readonly canInterrupt: boolean
}

declare const actionLeaseBrand: unique symbol
declare const dispatchBrand: unique symbol
declare const terminalEvidenceBrand: unique symbol

interface LeaseSecret {
  readonly store: ActionStateStore
  readonly key: ActionKey
  readonly rowVersion: number
  consumed: boolean
}

interface DispatchSecret {
  readonly store: ActionStateStore
  readonly key: ActionKey
  readonly rowVersion: number
  readonly supervisorGeneration: number
  consumed: boolean
}

type TerminalValue =
  | { readonly state: 'accepted'; readonly revision: number }
  | {
      readonly state: 'rejected'
      readonly code: string
      readonly message: string
    }
  | { readonly state: 'indeterminate'; readonly reason: string }

interface TerminalEvidenceSecret {
  readonly dispatch: DispatchSecret
  readonly value: TerminalValue
  consumed: boolean
}

interface ActionKey {
  readonly hostId: string
  readonly authorizationId: string
  readonly clientDeviceId: string
  readonly actionId: string
}

interface ActionRow extends Record<string, unknown> {
  host_id: string
  authorization_id: string
  client_device_id: string
  action_id: string
  authorization_epoch: number
  first_connection_generation: number
  first_inbound_key_id: string
  first_inbound_sequence: number
  task_id: string
  operation: 'turn.send' | 'turn.steer' | 'turn.interrupt'
  expected_revision: number
  request_fingerprint: string
  state: 'reserved' | 'dispatching' | 'accepted' | 'rejected' | 'indeterminate'
  row_version: number
  supervisor_generation: number | null
  result_revision: number | null
  rejection_code: string | null
  rejection_message: string | null
  indeterminate_reason: string | null
}

const leaseSecrets = new WeakMap<DurableActionLease, LeaseSecret>()
const dispatchSecrets = new WeakMap<DurableDispatchCapability, DispatchSecret>()
const terminalEvidenceSecrets = new WeakMap<DurableTerminalEvidence, TerminalEvidenceSecret>()

function fail(code: ActionStateErrorCode): never {
  throw new ActionStateError(code)
}

function isReservedWindowsSegment(segment: string): boolean {
  const basename = segment.split('.')[0]?.toUpperCase()
  return (
    basename === 'CON'
    || basename === 'PRN'
    || basename === 'AUX'
    || basename === 'NUL'
    || basename === 'CONIN$'
    || basename === 'CONOUT$'
    || /^COM(?:[1-9]|[¹²³])$/.test(basename ?? '')
    || /^LPT(?:[1-9]|[¹²³])$/.test(basename ?? '')
  )
}

function safeWindowsPath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || /[\u0001-\u001f\u007f<>"|?*]/.test(value)
    || value.includes('/')
    || !/^[A-Za-z]:\\/.test(value)
    || !windowsPath.isAbsolute(value)
    || value.slice(2).includes(':')
  ) return false
  const normalized = windowsPath.normalize(value)
  const root = windowsPath.parse(normalized).root
  if (normalized === root || normalized !== value) return false
  return normalized.slice(root.length).split('\\').every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.endsWith('.')
    && !segment.endsWith(' ')
    && !isReservedWindowsSegment(segment)
  ))
}

function verifyExistingPath(path: string, kind: 'directory' | 'file'): void {
  let facts
  try {
    facts = lstatSync(path)
  } catch {
    fail(kind === 'file' ? 'missing-store' : 'unsafe-path')
  }
  if (facts.isSymbolicLink()) fail('unsafe-path')
  if (kind === 'directory' ? !facts.isDirectory() : !facts.isFile()) fail('unsafe-path')
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    fail('unsafe-path')
  }
  if (windowsPath.normalize(real).toLowerCase() !== path.toLowerCase()) fail('unsafe-path')
}

function validatePaths(config: ActionStateConfig, requireDatabase: boolean): {
  workspaceRoot: string
  databasePath: string
} {
  if (typeof config !== 'object' || config === null) fail('invalid-config')
  const workspaceRoot = config.workspaceRoot
  const databasePath = config.databasePath
  if (!safeWindowsPath(workspaceRoot) || !safeWindowsPath(databasePath)) fail('unsafe-path')
  if (windowsPath.parse(workspaceRoot).root.toLowerCase() !== windowsPath.parse(databasePath).root.toLowerCase()) {
    fail('unsafe-path')
  }
  const relative = windowsPath.relative(workspaceRoot, databasePath)
  if (
    relative.length === 0
    || windowsPath.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..\\`)
  ) fail('unsafe-path')
  const [scope] = relative.split('\\')
  if (scope !== '.data' && scope !== '.tmp') fail('unsafe-path')
  const parent = windowsPath.dirname(databasePath)
  verifyExistingPath(workspaceRoot, 'directory')
  let cursor = workspaceRoot
  const parentRelative = windowsPath.relative(workspaceRoot, parent)
  for (const segment of parentRelative.split('\\')) {
    if (segment.length === 0) continue
    cursor = windowsPath.join(cursor, segment)
    verifyExistingPath(cursor, 'directory')
  }
  if (requireDatabase) verifyExistingPath(databasePath, 'file')
  else if (existsSync(databasePath)) fail('already-exists')
  return { workspaceRoot, databasePath }
}

/** Package-private path validator shared with the Windows DPAPI anchor wrapper. */
export function resolveActionStatePaths(
  config: ActionStateConfig,
  requireDatabase: boolean,
): Readonly<{ workspaceRoot: string; databasePath: string }> {
  return Object.freeze(validatePaths(config, requireDatabase))
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('stale-authority')
  return value
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail('stale-authority')
  return value as number
}

function nonnegative(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('stale-authority')
  return value as number
}

function timestamp(value: unknown): number {
  return nonnegative(value)
}

function fingerprint(value: unknown): string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) fail('stale-authority')
  let decoded: Buffer
  try {
    decoded = Buffer.from(value, 'base64url')
  } catch {
    fail('stale-authority')
  }
  if (decoded.byteLength !== 32 || decoded.toString('base64url') !== value) fail('stale-authority')
  return value
}

function safeText(value: unknown, maximumBytes: number): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes
  ) fail('stale-authority')
  return value
}

function safeIntegerColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (!Number.isSafeInteger(value)) fail('invalid-store')
  return value as number
}

function safeStringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') fail('invalid-store')
  return value
}

function nullableIntegerColumn(row: Record<string, unknown>, key: string): number | null {
  const value = row[key]
  if (value === null) return null
  if (!Number.isSafeInteger(value)) fail('invalid-store')
  return value as number
}

function nullableStringColumn(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') fail('invalid-store')
  return value
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function pragmaNumber(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get()
  if (row === undefined) fail('invalid-store')
  const value = Object.values(row)[0]
  if (!Number.isSafeInteger(value)) fail('invalid-store')
  return value as number
}

function pragmaString(db: DatabaseSync, name: string): string {
  const row = db.prepare(`PRAGMA ${name}`).get()
  if (row === undefined) fail('invalid-store')
  const value = Object.values(row)[0]
  if (typeof value !== 'string') fail('invalid-store')
  return value
}

function expectedSchema(): ReadonlyMap<string, string> {
  const entries = [
    ...TABLE_STATEMENTS.map((sql) => {
      const match = /^CREATE TABLE ([a-z_]+)/.exec(sql)
      if (match === null) fail('invalid-store')
      return [`table:${match[1]}`, normalizeSql(sql)] as const
    }),
    ...INDEX_STATEMENTS.map((sql) => {
      const match = /^CREATE INDEX ([a-z_]+)/.exec(sql)
      if (match === null) fail('invalid-store')
      return [`index:${match[1]}`, normalizeSql(sql)] as const
    }),
  ]
  return new Map(entries)
}

const EXPECTED_SCHEMA = expectedSchema()

function validateSchema(db: DatabaseSync): void {
  if (pragmaNumber(db, 'application_id') !== APPLICATION_ID) fail('invalid-store')
  if (pragmaNumber(db, 'user_version') !== SCHEMA_VERSION) fail('invalid-store')
  const rows = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all()
  if (rows.length !== EXPECTED_SCHEMA.size) fail('invalid-store')
  const actual = new Map<string, string>()
  for (const row of rows) {
    const type = safeStringColumn(row, 'type')
    const name = safeStringColumn(row, 'name')
    const sql = safeStringColumn(row, 'sql')
    if ((type !== 'table' && type !== 'index') || actual.has(`${type}:${name}`)) fail('invalid-store')
    actual.set(`${type}:${name}`, normalizeSql(sql))
  }
  for (const [key, sql] of EXPECTED_SCHEMA) {
    if (actual.get(key) !== sql) fail('invalid-store')
  }
  const integrity = db.prepare('PRAGMA integrity_check(1)').get()
  if (integrity === undefined || Object.values(integrity)[0] !== 'ok') fail('invalid-store')
  const meta = db.prepare('SELECT singleton, store_id, state_revision, boot_id FROM store_meta').all()
  if (meta.length !== 1 || safeIntegerColumn(meta[0]!, 'singleton') !== 1) fail('invalid-store')
  readStoreMetadata(db)
  const bootId = safeStringColumn(meta[0]!, 'boot_id')
  if (!IDENTIFIER.test(bootId)) fail('invalid-store')
}

function readStoreMetadata(db: DatabaseSync): Readonly<ActionStateMetadata> {
  const rows = db.prepare(`
    SELECT store_id, state_revision FROM store_meta WHERE singleton = 1
  `).all()
  if (rows.length !== 1) fail('invalid-store')
  const storeId = safeStringColumn(rows[0]!, 'store_id')
  const stateRevision = safeIntegerColumn(rows[0]!, 'state_revision')
  if (!IDENTIFIER.test(storeId) || stateRevision < 0) fail('invalid-store')
  return Object.freeze({ storeId, stateRevision })
}

function configureConnection(db: DatabaseSync, creating: boolean): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA trusted_schema = OFF')
  db.exec('PRAGMA busy_timeout = 0')
  db.exec('PRAGMA synchronous = FULL')
  if (creating) {
    db.exec(`PRAGMA page_size = ${DATABASE_PAGE_SIZE}`)
    const journal = pragmaString(db, 'journal_mode')
    if (journal.toLowerCase() !== 'delete') fail('invalid-store')
    const wal = db.prepare('PRAGMA journal_mode = WAL').get()
    if (wal === undefined || String(Object.values(wal)[0]).toLowerCase() !== 'wal') fail('invalid-store')
  }
  if (pragmaString(db, 'journal_mode').toLowerCase() !== 'wal') fail('invalid-store')
  db.exec('PRAGMA wal_autocheckpoint = 256')
  db.exec(`PRAGMA max_page_count = ${DATABASE_PAGE_LIMIT}`)
  if (
    pragmaNumber(db, 'foreign_keys') !== 1
    || pragmaNumber(db, 'trusted_schema') !== 0
    || pragmaNumber(db, 'busy_timeout') !== 0
    || pragmaNumber(db, 'synchronous') !== 2
    || pragmaNumber(db, 'page_size') !== DATABASE_PAGE_SIZE
    || pragmaNumber(db, 'max_page_count') > DATABASE_PAGE_LIMIT
  ) fail('invalid-store')
}

function sqliteBusy(error: unknown): boolean {
  return error instanceof Error && (
    (error as Error & { code?: string }).code === 'ERR_SQLITE_ERROR'
    && /\b(?:database is locked|database table is locked)\b/i.test(error.message)
  )
}

function scopedLimits(input?: ActionStateTestLimits): EffectiveLimits {
  if (input === undefined) return HARD_LIMITS
  const result: Record<keyof EffectiveLimits, number> = { ...HARD_LIMITS }
  for (const key of Object.keys(HARD_LIMITS) as (keyof EffectiveLimits)[]) {
    const value = input[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_LIMITS[key]) fail('invalid-config')
    result[key] = value
  }
  return Object.freeze(result)
}

function actionMapKey(key: ActionKey): string {
  return `${key.hostId}\0${key.authorizationId}\0${key.clientDeviceId}\0${key.actionId}`
}

function actionKey(input: InboundActionReservationInput): ActionKey {
  return Object.freeze({
    hostId: identifier(input.hostId),
    authorizationId: identifier(input.authorizationId),
    clientDeviceId: identifier(input.clientDeviceId),
    actionId: identifier(input.actionId),
  })
}

function actionWhere(key: ActionKey): Record<string, string> {
  return {
    hostId: key.hostId,
    authorizationId: key.authorizationId,
    clientDeviceId: key.clientDeviceId,
    actionId: key.actionId,
  }
}

function asActionRow(row: Record<string, unknown> | undefined): ActionRow | undefined {
  if (row === undefined) return undefined
  return row as ActionRow
}

function receiptFromRow(row: ActionRow): StoredActionReceipt {
  if (row.state === 'accepted') {
    return Object.freeze({
      actionId: row.action_id,
      state: 'accepted' as const,
      ...(row.result_revision === null ? {} : { revision: row.result_revision }),
    })
  }
  if (row.state === 'rejected') {
    if (row.rejection_code === null || row.rejection_message === null) fail('invalid-store')
    return Object.freeze({
      actionId: row.action_id,
      state: 'rejected' as const,
      rejection: Object.freeze({ code: row.rejection_code, message: row.rejection_message }),
    })
  }
  return Object.freeze({
    actionId: row.action_id,
    state: 'queued' as const,
    recoveryRequired: true as const,
  })
}

function readActionRow(db: DatabaseSync, key: ActionKey): ActionRow | undefined {
  return asActionRow(db.prepare(`
    SELECT * FROM actions
    WHERE host_id = $hostId
      AND authorization_id = $authorizationId
      AND client_device_id = $clientDeviceId
      AND action_id = $actionId
  `).get(actionWhere(key)))
}

export class ActionStateStore {
  private readonly activeLeases = new Map<string, DurableActionLease>()
  private closed = false
  private poisoned = false

  constructor(
    private readonly db: DatabaseSync,
    readonly databasePath: string,
    private readonly limits: EffectiveLimits,
  ) {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.activeLeases.clear()
    try {
      this.db.close()
    } catch {
      this.poisoned = true
    }
  }

  readMetadata(): Readonly<ActionStateMetadata> {
    this.assertUsable()
    return readStoreMetadata(this.db)
  }

  applyAuthorization(input: AuthorizationRecordInput): void {
    const value = Object.freeze({
      hostId: identifier(input.hostId),
      authorizationId: identifier(input.authorizationId),
      clientDeviceId: identifier(input.clientDeviceId),
      authorizationEpoch: positive(input.authorizationEpoch),
      status: input.status,
      connectionGeneration: positive(input.connectionGeneration),
      revision: positive(input.revision),
    })
    if (value.status !== 'active' && value.status !== 'revoked') fail('stale-authority')
    this.mutate(() => {
      const existing = this.db.prepare(`
        SELECT * FROM authorizations WHERE host_id = $hostId AND authorization_id = $authorizationId
      `).get({ hostId: value.hostId, authorizationId: value.authorizationId })
      if (existing === undefined) {
        if (this.count('authorizations') >= this.limits.authorizations) fail('capacity-exceeded')
        this.db.prepare(`
          INSERT INTO authorizations (
            host_id, authorization_id, client_device_id, authorization_epoch,
            status, connection_generation, revision
          ) VALUES ($hostId, $authorizationId, $clientDeviceId, $authorizationEpoch,
            $status, $connectionGeneration, $revision)
        `).run(value)
        return
      }
      const existingClient = safeStringColumn(existing, 'client_device_id')
      const existingEpoch = safeIntegerColumn(existing, 'authorization_epoch')
      const existingStatus = safeStringColumn(existing, 'status')
      const existingGeneration = safeIntegerColumn(existing, 'connection_generation')
      const existingRevision = safeIntegerColumn(existing, 'revision')
      if (
        existingClient === value.clientDeviceId
        && existingEpoch === value.authorizationEpoch
        && existingStatus === value.status
        && existingGeneration === value.connectionGeneration
        && existingRevision === value.revision
      ) return
      if (
        existingClient !== value.clientDeviceId
        || existingStatus === 'revoked'
        || value.authorizationEpoch < existingEpoch
        || value.connectionGeneration < existingGeneration
        || value.revision < existingRevision
        || (
          value.revision === existingRevision
          && (
            value.authorizationEpoch !== existingEpoch
            || value.status !== existingStatus
            || value.connectionGeneration <= existingGeneration
          )
        )
      ) fail('stale-authority')
      this.db.prepare(`
        UPDATE authorizations
        SET authorization_epoch = $authorizationEpoch,
            status = $status,
            connection_generation = $connectionGeneration,
            revision = $revision
        WHERE host_id = $hostId AND authorization_id = $authorizationId
      `).run(value)
      if (value.status === 'revoked') this.revokeActions(value.hostId, value.authorizationId)
    })
  }

  activateChannel(input: ChannelActivationInput): void {
    const value = Object.freeze({
      hostId: identifier(input.hostId),
      authorizationId: identifier(input.authorizationId),
      authorizationEpoch: positive(input.authorizationEpoch),
      connectionGeneration: positive(input.connectionGeneration),
      inboundKeyId: identifier(input.inboundKeyId),
      outboundKeyId: identifier(input.outboundKeyId),
      lastInboundSequence: positive(input.lastInboundSequence),
      lastPeerAck: nonnegative(input.lastPeerAck),
      maxSentSequence: positive(input.maxSentSequence),
    })
    if (value.lastPeerAck > value.maxSentSequence) fail('ack-ahead')
    this.mutate(() => {
      this.requireActiveAuthorization(value)
      const existing = this.db.prepare(`
        SELECT * FROM channels
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND inbound_key_id = $inboundKeyId
      `).get(value)
      if (existing !== undefined) {
        if (
          safeStringColumn(existing, 'outbound_key_id') !== value.outboundKeyId
          || safeIntegerColumn(existing, 'last_inbound_sequence') !== value.lastInboundSequence
          || safeIntegerColumn(existing, 'last_peer_ack') !== value.lastPeerAck
          || safeIntegerColumn(existing, 'max_sent_sequence') !== value.maxSentSequence
        ) fail('stale-authority')
        return
      }
      this.db.prepare(`
        INSERT INTO channels (
          host_id, authorization_id, authorization_epoch, connection_generation,
          inbound_key_id, outbound_key_id, last_inbound_sequence, last_peer_ack,
          max_sent_sequence
        ) VALUES (
          $hostId, $authorizationId, $authorizationEpoch, $connectionGeneration,
          $inboundKeyId, $outboundKeyId, $lastInboundSequence, $lastPeerAck,
          $maxSentSequence
        )
      `).run(value)
    })
  }

  upsertTask(input: TaskStateInput): void {
    const value = Object.freeze({
      hostId: identifier(input.hostId),
      taskId: identifier(input.taskId),
      workspaceId: identifier(input.workspaceId),
      revision: nonnegative(input.revision),
      writeState: input.writeState,
      canSend: input.canSend ? 1 : 0,
      canInterrupt: input.canInterrupt ? 1 : 0,
    })
    if (value.writeState !== 'writable' && value.writeState !== 'read-only') fail('stale-authority')
    this.mutate(() => {
      const existing = this.db.prepare(`
        SELECT write_state, blocked_action_id FROM tasks WHERE host_id = $hostId AND task_id = $taskId
      `).get(value)
      if (existing === undefined) {
        if (this.count('tasks') >= this.limits.tasks) fail('capacity-exceeded')
        this.db.prepare(`
          INSERT INTO tasks (
            host_id, task_id, workspace_id, revision, write_state,
            can_send, can_interrupt, blocked_action_id
          ) VALUES ($hostId, $taskId, $workspaceId, $revision, $writeState,
            $canSend, $canInterrupt, NULL)
        `).run(value)
        return
      }
      if (safeStringColumn(existing, 'write_state') === 'blocked-indeterminate') {
        fail('stale-authority')
      }
      const existingRevision = this.db.prepare(`
        SELECT revision FROM tasks WHERE host_id = $hostId AND task_id = $taskId
      `).get(value)
      if (existingRevision === undefined || safeIntegerColumn(existingRevision, 'revision') > value.revision) {
        fail('stale-authority')
      }
      this.db.prepare(`
        UPDATE tasks
        SET workspace_id = $workspaceId,
            revision = $revision,
            write_state = $writeState,
            can_send = $canSend,
            can_interrupt = $canInterrupt,
            blocked_action_id = NULL
        WHERE host_id = $hostId AND task_id = $taskId
      `).run(value)
    })
  }

  /** Local operator recovery: abandon retries while preserving indeterminate action tombstones. */
  releaseIndeterminateTaskBlocksForLocalOperator(): number {
    return this.mutate(() => {
      const result = this.db.prepare(`
        UPDATE tasks
        SET write_state = 'read-only', can_send = 0, can_interrupt = 0,
            blocked_action_id = NULL
        WHERE write_state = 'blocked-indeterminate'
          AND blocked_action_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM actions
            WHERE actions.host_id = tasks.host_id
              AND actions.task_id = tasks.task_id
              AND actions.action_id = tasks.blocked_action_id
              AND actions.state = 'indeterminate'
          )
      `).run()
      const changes = Number(result.changes)
      if (!Number.isSafeInteger(changes) || changes < 0 || changes > this.limits.tasks) {
        fail('invalid-store')
      }
      return changes
    })
  }

  commitOutboundFrame(input: OutboundFrameInput): void {
    const encryptedWireText = safeText(input.encryptedWireText, MAX_ENCRYPTED_FRAME_BYTES)
    const value = Object.freeze({
      hostId: identifier(input.hostId),
      authorizationId: identifier(input.authorizationId),
      authorizationEpoch: positive(input.authorizationEpoch),
      connectionGeneration: positive(input.connectionGeneration),
      inboundKeyId: identifier(input.inboundKeyId),
      outboundKeyId: identifier(input.outboundKeyId),
      sequence: positive(input.sequence),
      encryptedWireText,
      byteLength: Buffer.byteLength(encryptedWireText, 'utf8'),
    })
    if (value.sequence < 2) fail('sequence-gap')
    this.mutate(() => {
      this.requireActiveAuthorization(value)
      const channel = this.requireChannel(value)
      if (safeStringColumn(channel, 'outbound_key_id') !== value.outboundKeyId) fail('stale-authority')
      const maxSent = safeIntegerColumn(channel, 'max_sent_sequence')
      if (value.sequence <= maxSent) fail('replay')
      if (value.sequence !== maxSent + 1) fail('sequence-gap')
      const channelFacts = this.db.prepare(`
        SELECT COUNT(*) AS frame_count, COALESCE(SUM(byte_length), 0) AS frame_bytes
        FROM outbound_frames
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND outbound_key_id = $outboundKeyId
      `).get(value)
      if (channelFacts === undefined) fail('invalid-store')
      if (safeIntegerColumn(channelFacts, 'frame_count') >= this.limits.outboundFramesPerChannel) {
        fail('backpressure')
      }
      const global = this.db.prepare('SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM outbound_frames').get()
      if (global === undefined) fail('invalid-store')
      if (safeIntegerColumn(global, 'bytes') + value.byteLength > this.limits.outboundBytes) {
        fail('backpressure')
      }
      this.db.prepare(`
        INSERT INTO outbound_frames (
          host_id, authorization_id, authorization_epoch, connection_generation,
          inbound_key_id, outbound_key_id, sequence, encrypted_wire_text, byte_length
        ) VALUES (
          $hostId, $authorizationId, $authorizationEpoch, $connectionGeneration,
          $inboundKeyId, $outboundKeyId, $sequence, $encryptedWireText, $byteLength
        )
      `).run(value)
      this.db.prepare(`
        UPDATE channels SET max_sent_sequence = $sequence
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND inbound_key_id = $inboundKeyId
      `).run(value)
    })
  }

  commitInboundReadOnly(input: InboundReadOnlyCommitInput): void {
    const value = Object.freeze({
      hostId: identifier(input.hostId),
      authorizationId: identifier(input.authorizationId),
      authorizationEpoch: positive(input.authorizationEpoch),
      clientDeviceId: identifier(input.clientDeviceId),
      connectionGeneration: positive(input.connectionGeneration),
      inboundKeyId: identifier(input.inboundKeyId),
      sequence: positive(input.sequence),
      ack: nonnegative(input.ack),
    })
    if (value.sequence < 2) fail('sequence-gap')
    this.mutate(() => {
      this.requireActiveAuthorization(value)
      const channel = this.requireChannel(value)
      const lastInbound = safeIntegerColumn(channel, 'last_inbound_sequence')
      const lastAck = safeIntegerColumn(channel, 'last_peer_ack')
      const maxSent = safeIntegerColumn(channel, 'max_sent_sequence')
      const outboundKeyId = safeStringColumn(channel, 'outbound_key_id')
      if (value.sequence <= lastInbound) fail('replay')
      if (value.sequence !== lastInbound + 1) fail('sequence-gap')
      if (value.ack < lastAck) fail('ack-regression')
      if (value.ack > maxSent) fail('ack-ahead')

      this.db.prepare(`
        DELETE FROM outbound_frames
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND outbound_key_id = $outboundKeyId
          AND sequence <= $ack
      `).run({ ...value, outboundKeyId })
      this.db.prepare(`
        UPDATE channels
        SET last_inbound_sequence = $sequence, last_peer_ack = $ack
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND inbound_key_id = $inboundKeyId
      `).run(value)
    })
  }

  commitInboundReservation(input: InboundActionReservationInput): InboundReservationResult {
    const key = actionKey(input)
    const value = Object.freeze({
      ...key,
      authorizationEpoch: positive(input.authorizationEpoch),
      connectionGeneration: positive(input.connectionGeneration),
      inboundKeyId: identifier(input.inboundKeyId),
      sequence: positive(input.sequence),
      ack: nonnegative(input.ack),
      taskId: identifier(input.taskId),
      operation: input.operation,
      expectedRevision: nonnegative(input.expectedRevision),
      requestFingerprint: fingerprint(input.requestFingerprint),
      now: timestamp(input.now),
    })
    if (value.sequence < 2) fail('sequence-gap')
    if (value.operation !== 'turn.send' && value.operation !== 'turn.steer' && value.operation !== 'turn.interrupt') fail('stale-authority')
    return this.mutate(() => {
      this.requireActiveAuthorization(value)
      const channel = this.requireChannel(value)
      const lastInbound = safeIntegerColumn(channel, 'last_inbound_sequence')
      const lastAck = safeIntegerColumn(channel, 'last_peer_ack')
      const maxSent = safeIntegerColumn(channel, 'max_sent_sequence')
      const outboundKeyId = safeStringColumn(channel, 'outbound_key_id')
      if (value.sequence <= lastInbound) fail('replay')
      if (value.sequence !== lastInbound + 1) fail('sequence-gap')
      if (value.ack < lastAck) fail('ack-regression')
      if (value.ack > maxSent) fail('ack-ahead')

      const existing = readActionRow(this.db, key)
      if (existing !== undefined && !this.sameAction(existing, value)) fail('action-id-conflict')

      this.db.prepare(`
        DELETE FROM outbound_frames
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND outbound_key_id = $outboundKeyId
          AND sequence <= $ack
      `).run({ ...value, outboundKeyId })
      this.db.prepare(`
        UPDATE channels
        SET last_inbound_sequence = $sequence, last_peer_ack = $ack
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND authorization_epoch = $authorizationEpoch
          AND connection_generation = $connectionGeneration
          AND inbound_key_id = $inboundKeyId
      `).run(value)

      if (existing !== undefined) return this.replayExisting(existing, key)
      if (this.count('actions') >= this.limits.actions) fail('capacity-exceeded')
      const rejection = this.policyRejection(value)
      if (rejection !== undefined) {
        this.insertRejectedAction(value, rejection.code, rejection.message)
        const row = readActionRow(this.db, key)
        if (row === undefined) fail('invalid-store')
        return Object.freeze({ kind: 'terminal' as const, receipt: receiptFromRow(row) })
      }
      this.db.prepare(`
        INSERT INTO actions (
          host_id, authorization_id, client_device_id, action_id,
          authorization_epoch, first_connection_generation, first_inbound_key_id,
          first_inbound_sequence, task_id, operation, expected_revision,
          request_fingerprint, state, row_version, supervisor_generation,
          result_revision, rejection_code, rejection_message, indeterminate_reason,
          created_at, updated_at
        ) VALUES (
          $hostId, $authorizationId, $clientDeviceId, $actionId,
          $authorizationEpoch, $connectionGeneration, $inboundKeyId,
          $sequence, $taskId, $operation, $expectedRevision,
          $requestFingerprint, 'reserved', 1, NULL,
          NULL, NULL, NULL, NULL, $now, $now
        )
      `).run(value)
      const lease = this.issueLease(key, 1)
      return Object.freeze({ kind: 'claimed' as const, lease, replayed: false })
    })
  }

  beginDispatch(
    lease: DurableActionLease,
    supervisorGeneration: number,
    now: number,
  ): BeginDispatchResult {
    const secret = leaseSecrets.get(lease)
    if (
      secret === undefined
      || secret.store !== this
      || secret.consumed
      || this.activeLeases.get(actionMapKey(secret.key)) !== lease
    ) fail('invalid-capability')
    const generation = positive(supervisorGeneration)
    const at = timestamp(now)
    const result = this.mutate(() => {
      const row = readActionRow(this.db, secret.key)
      if (row === undefined || row.state !== 'reserved' || row.row_version !== secret.rowVersion) {
        fail('invalid-transition')
      }
      const rejection = this.dispatchRejection(row)
      if (rejection !== undefined) {
        this.db.prepare(`
          UPDATE actions
          SET state = 'rejected', row_version = row_version + 1,
              rejection_code = $code, rejection_message = $message,
              updated_at = $now
          WHERE host_id = $hostId AND authorization_id = $authorizationId
            AND client_device_id = $clientDeviceId AND action_id = $actionId
            AND state = 'reserved' AND row_version = $rowVersion
        `).run({ ...actionWhere(secret.key), ...rejection, now: at, rowVersion: secret.rowVersion })
        const rejected = readActionRow(this.db, secret.key)
        if (rejected === undefined) fail('invalid-store')
        return Object.freeze({ kind: 'rejected' as const, receipt: receiptFromRow(rejected) as Extract<StoredActionReceipt, { state: 'rejected' }> })
      }
      const changes = this.db.prepare(`
        UPDATE actions
        SET state = 'dispatching', row_version = row_version + 1,
            supervisor_generation = $supervisorGeneration, updated_at = $now
        WHERE host_id = $hostId AND authorization_id = $authorizationId
          AND client_device_id = $clientDeviceId AND action_id = $actionId
          AND state = 'reserved' AND row_version = $rowVersion
      `).run({
        ...actionWhere(secret.key),
        supervisorGeneration: generation,
        now: at,
        rowVersion: secret.rowVersion,
      })
      if (Number(changes.changes) !== 1) fail('invalid-transition')
      const dispatch = Object.freeze({ kind: 'durable-dispatch-capability' as const }) as DurableDispatchCapability
      const dispatchSecret: DispatchSecret = {
        store: this,
        key: secret.key,
        rowVersion: secret.rowVersion + 1,
        supervisorGeneration: generation,
        consumed: false,
      }
      dispatchSecrets.set(dispatch, dispatchSecret)
      return Object.freeze({ kind: 'dispatching' as const, dispatch })
    })
    secret.consumed = true
    this.activeLeases.delete(actionMapKey(secret.key))
    return result
  }

  commitTerminal(
    dispatch: DurableDispatchCapability,
    evidence: DurableTerminalEvidence,
    now: number,
  ): StoredActionReceipt {
    const dispatchSecret = dispatchSecrets.get(dispatch)
    const evidenceSecret = terminalEvidenceSecrets.get(evidence)
    if (
      dispatchSecret === undefined
      || evidenceSecret === undefined
      || dispatchSecret.store !== this
      || dispatchSecret.consumed
      || evidenceSecret.consumed
      || evidenceSecret.dispatch !== dispatchSecret
    ) fail('invalid-capability')
    const at = timestamp(now)
    const value = evidenceSecret.value
    const receipt = this.mutate(() => {
      const row = readActionRow(this.db, dispatchSecret.key)
      if (
        row === undefined
        || row.state !== 'dispatching'
        || row.row_version !== dispatchSecret.rowVersion
        || row.supervisor_generation !== dispatchSecret.supervisorGeneration
      ) fail('invalid-transition')
      if (value.state === 'accepted') {
        if (value.revision !== row.expected_revision + 1) fail('invalid-transition')
        const taskChanges = this.db.prepare(`
          UPDATE tasks
          SET revision = $revision, can_send = 0, can_interrupt = 1
          WHERE host_id = $hostId AND task_id = $taskId
            AND revision = $expectedRevision
        `).run({
          hostId: row.host_id,
          taskId: row.task_id,
          expectedRevision: row.expected_revision,
          revision: value.revision,
        })
        if (Number(taskChanges.changes) !== 1) fail('invalid-transition')
        const actionChanges = this.db.prepare(`
          UPDATE actions
          SET state = 'accepted', row_version = row_version + 1,
              result_revision = $revision, updated_at = $now
          WHERE host_id = $hostId AND authorization_id = $authorizationId
            AND client_device_id = $clientDeviceId AND action_id = $actionId
            AND state = 'dispatching' AND row_version = $rowVersion
        `).run({
          ...actionWhere(dispatchSecret.key),
          revision: value.revision,
          now: at,
          rowVersion: dispatchSecret.rowVersion,
        })
        if (Number(actionChanges.changes) !== 1) fail('invalid-transition')
      } else if (value.state === 'rejected') {
        this.db.prepare(`
          UPDATE actions
          SET state = 'rejected', row_version = row_version + 1,
              rejection_code = $code, rejection_message = $message,
              updated_at = $now
          WHERE host_id = $hostId AND authorization_id = $authorizationId
            AND client_device_id = $clientDeviceId AND action_id = $actionId
            AND state = 'dispatching' AND row_version = $rowVersion
        `).run({
          ...actionWhere(dispatchSecret.key),
          code: value.code,
          message: value.message,
          now: at,
          rowVersion: dispatchSecret.rowVersion,
        })
      } else {
        this.db.prepare(`
          UPDATE actions
          SET state = 'indeterminate', row_version = row_version + 1,
              indeterminate_reason = $reason, updated_at = $now
          WHERE host_id = $hostId AND authorization_id = $authorizationId
            AND client_device_id = $clientDeviceId AND action_id = $actionId
            AND state = 'dispatching' AND row_version = $rowVersion
        `).run({
          ...actionWhere(dispatchSecret.key),
          reason: value.reason,
          now: at,
          rowVersion: dispatchSecret.rowVersion,
        })
        this.blockTask(row.host_id, row.task_id, row.action_id)
      }
      const terminal = readActionRow(this.db, dispatchSecret.key)
      if (terminal === undefined) fail('invalid-store')
      return receiptFromRow(terminal)
    })
    dispatchSecret.consumed = true
    evidenceSecret.consumed = true
    return receipt
  }

  getActionStatus(keyInput: ActionKey): ActionStatusSnapshot | undefined {
    this.assertUsable()
    const key = Object.freeze({
      hostId: identifier(keyInput.hostId),
      authorizationId: identifier(keyInput.authorizationId),
      clientDeviceId: identifier(keyInput.clientDeviceId),
      actionId: identifier(keyInput.actionId),
    })
    const row = readActionRow(this.db, key)
    if (row === undefined) return undefined
    return Object.freeze({
      actionId: row.action_id,
      taskId: row.task_id,
      operation: row.operation,
      authorizationEpoch: row.authorization_epoch,
      firstConnectionGeneration: row.first_connection_generation,
      firstInboundKeyId: row.first_inbound_key_id,
      firstInboundSequence: row.first_inbound_sequence,
      state: row.state,
      rowVersion: row.row_version,
      ...(row.supervisor_generation === null ? {} : { supervisorGeneration: row.supervisor_generation }),
      ...(row.state === 'accepted' || row.state === 'rejected' || row.state === 'indeterminate'
        ? { receipt: receiptFromRow(row) }
        : {}),
    })
  }

  getChannelState(input: Omit<ChannelActivationInput, 'outboundKeyId' | 'lastInboundSequence' | 'lastPeerAck' | 'maxSentSequence'>): ChannelStateSnapshot {
    this.assertUsable()
    const value = {
      hostId: identifier(input.hostId),
      authorizationId: identifier(input.authorizationId),
      authorizationEpoch: positive(input.authorizationEpoch),
      connectionGeneration: positive(input.connectionGeneration),
      inboundKeyId: identifier(input.inboundKeyId),
    }
    const row = this.requireChannel(value)
    const frames = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(byte_length), 0) AS bytes
      FROM outbound_frames
      WHERE host_id = $hostId AND authorization_id = $authorizationId
        AND authorization_epoch = $authorizationEpoch
        AND connection_generation = $connectionGeneration
        AND outbound_key_id = $outboundKeyId
    `).get({ ...value, outboundKeyId: safeStringColumn(row, 'outbound_key_id') })
    if (frames === undefined) fail('invalid-store')
    return Object.freeze({
      lastInboundSequence: safeIntegerColumn(row, 'last_inbound_sequence'),
      lastPeerAck: safeIntegerColumn(row, 'last_peer_ack'),
      maxSentSequence: safeIntegerColumn(row, 'max_sent_sequence'),
      outboundFrameCount: safeIntegerColumn(frames, 'count'),
      outboundFrameBytes: safeIntegerColumn(frames, 'bytes'),
    })
  }

  getTaskState(input: {
    readonly hostId: string
    readonly taskId: string
  }): DurableTaskStateSnapshot | undefined {
    this.assertUsable()
    const value = Object.freeze({
      hostId: identifier(input.hostId),
      taskId: identifier(input.taskId),
    })
    const row = this.db.prepare(`
      SELECT task_id, workspace_id, revision, write_state,
        can_send, can_interrupt
      FROM tasks WHERE host_id = $hostId AND task_id = $taskId
    `).get(value)
    if (row === undefined) return undefined
    const writeState = safeStringColumn(row, 'write_state')
    if (
      writeState !== 'writable'
      && writeState !== 'read-only'
      && writeState !== 'blocked-indeterminate'
    ) {
      fail('invalid-store')
    }
    const canSend = safeIntegerColumn(row, 'can_send')
    const canInterrupt = safeIntegerColumn(row, 'can_interrupt')
    if ((canSend !== 0 && canSend !== 1) || (canInterrupt !== 0 && canInterrupt !== 1)) {
      fail('invalid-store')
    }
    return Object.freeze({
      taskId: safeStringColumn(row, 'task_id'),
      workspaceId: safeStringColumn(row, 'workspace_id'),
      revision: safeIntegerColumn(row, 'revision'),
      writeState,
      canSend: canSend === 1,
      canInterrupt: canInterrupt === 1,
    })
  }

  private mutate<T>(operation: () => T): T {
    this.assertUsable()
    this.assertFileBudget()
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      const result = operation()
      this.db.exec(`
        UPDATE store_meta
        SET state_revision = state_revision + 1
        WHERE singleton = 1
      `)
      this.db.exec('COMMIT')
      began = false
      this.checkpointAndBudget()
      return result
    } catch (error) {
      if (began) {
        try {
          this.db.exec('ROLLBACK')
        } catch {
          this.poisoned = true
        }
      }
      if (error instanceof ActionStateError) throw error
      if (sqliteBusy(error)) fail('backpressure')
      this.poisoned = true
      fail('storage-failed')
    }
  }

  private assertUsable(): void {
    if (this.closed) fail('closed')
    if (this.poisoned) fail('storage-failed')
    if (!existsSync(this.databasePath)) {
      this.poisoned = true
      fail('missing-store')
    }
  }

  private assertFileBudget(): void {
    try {
      if (statSync(this.databasePath).size > DATABASE_BYTES_LIMIT) fail('capacity-exceeded')
      const walPath = `${this.databasePath}-wal`
      if (existsSync(walPath) && statSync(walPath).size > WAL_BYTES_LIMIT) fail('capacity-exceeded')
    } catch (error) {
      if (error instanceof ActionStateError) throw error
      this.poisoned = true
      fail('storage-failed')
    }
  }

  private checkpointAndBudget(): void {
    try {
      this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()
    } catch {
      // A concurrent reader may defer the checkpoint; the explicit WAL budget remains authoritative.
    }
    this.assertFileBudget()
  }

  private count(table: 'authorizations' | 'tasks' | 'actions'): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
    if (row === undefined) fail('invalid-store')
    return safeIntegerColumn(row, 'count')
  }

  private requireActiveAuthorization(input: {
    hostId: string
    authorizationId: string
    authorizationEpoch: number
    connectionGeneration: number
    clientDeviceId?: string
  }): Record<string, unknown> {
    const row = this.db.prepare(`
      SELECT * FROM authorizations WHERE host_id = $hostId AND authorization_id = $authorizationId
    `).get({ hostId: input.hostId, authorizationId: input.authorizationId })
    if (
      row === undefined
      || safeStringColumn(row, 'status') !== 'active'
      || safeIntegerColumn(row, 'authorization_epoch') !== input.authorizationEpoch
      || safeIntegerColumn(row, 'connection_generation') !== input.connectionGeneration
      || (input.clientDeviceId !== undefined
        && safeStringColumn(row, 'client_device_id') !== input.clientDeviceId)
    ) fail('stale-authority')
    return row
  }

  private requireChannel(input: {
    hostId: string
    authorizationId: string
    authorizationEpoch: number
    connectionGeneration: number
    inboundKeyId: string
  }): Record<string, unknown> {
    const row = this.db.prepare(`
      SELECT * FROM channels
      WHERE host_id = $hostId AND authorization_id = $authorizationId
        AND authorization_epoch = $authorizationEpoch
        AND connection_generation = $connectionGeneration
        AND inbound_key_id = $inboundKeyId
    `).get(input)
    if (row === undefined) fail('stale-authority')
    return row
  }

  private policyRejection(input: {
    hostId: string
    taskId: string
    operation: 'turn.send' | 'turn.steer' | 'turn.interrupt'
    expectedRevision: number
  }): { code: string; message: string } | undefined {
    const task = this.db.prepare(`
      SELECT * FROM tasks WHERE host_id = $hostId AND task_id = $taskId
    `).get(input)
    if (task === undefined) return { code: 'unknown-task', message: 'The task does not exist.' }
    if (safeIntegerColumn(task, 'revision') !== input.expectedRevision) {
      return { code: 'stale-task-revision', message: 'The task revision changed.' }
    }
    if (safeStringColumn(task, 'write_state') !== 'writable') {
      return { code: 'capability-denied', message: 'The task is not writable.' }
    }
    const allowed = input.operation === 'turn.send'
      ? safeIntegerColumn(task, 'can_send') === 1
      : safeIntegerColumn(task, 'can_interrupt') === 1
    return allowed ? undefined : { code: 'capability-denied', message: 'The action capability is not available.' }
  }

  private dispatchRejection(row: ActionRow): { code: string; message: string } | undefined {
    try {
      this.requireActiveAuthorization({
        hostId: row.host_id,
        authorizationId: row.authorization_id,
        authorizationEpoch: row.authorization_epoch,
        connectionGeneration: row.first_connection_generation,
        clientDeviceId: row.client_device_id,
      })
    } catch (error) {
      if (error instanceof ActionStateError && error.code === 'stale-authority') {
        return { code: 'offline', message: 'The action authority is no longer current.' }
      }
      throw error
    }
    return this.policyRejection({
      hostId: row.host_id,
      taskId: row.task_id,
      operation: row.operation,
      expectedRevision: row.expected_revision,
    })
  }

  private sameAction(row: ActionRow, input: {
    authorizationEpoch: number
    taskId: string
    operation: 'turn.send' | 'turn.steer' | 'turn.interrupt'
    expectedRevision: number
    requestFingerprint: string
  }): boolean {
    return (
      row.authorization_epoch === input.authorizationEpoch
      && row.task_id === input.taskId
      && row.operation === input.operation
      && row.expected_revision === input.expectedRevision
      && row.request_fingerprint === input.requestFingerprint
    )
  }

  private replayExisting(row: ActionRow, key: ActionKey): InboundReservationResult {
    if (row.state === 'reserved') {
      const lease = this.activeLeases.get(actionMapKey(key))
      const secret = lease === undefined ? undefined : leaseSecrets.get(lease)
      if (lease !== undefined && secret !== undefined && !secret.consumed && secret.rowVersion === row.row_version) {
        return Object.freeze({ kind: 'claimed' as const, lease, replayed: true })
      }
    }
    return Object.freeze({ kind: 'terminal' as const, receipt: receiptFromRow(row) })
  }

  private insertRejectedAction(
    input: InboundActionReservationInput,
    code: string,
    message: string,
  ): void {
    const safeCode = identifier(code)
    const safeMessage = safeText(message, 512)
    this.db.prepare(`
      INSERT INTO actions (
        host_id, authorization_id, client_device_id, action_id,
        authorization_epoch, first_connection_generation, first_inbound_key_id,
        first_inbound_sequence, task_id, operation, expected_revision,
        request_fingerprint, state, row_version, supervisor_generation,
        result_revision, rejection_code, rejection_message, indeterminate_reason,
        created_at, updated_at
      ) VALUES (
        $hostId, $authorizationId, $clientDeviceId, $actionId,
        $authorizationEpoch, $connectionGeneration, $inboundKeyId,
        $sequence, $taskId, $operation, $expectedRevision,
        $requestFingerprint, 'rejected', 1, NULL,
        NULL, $code, $message, NULL, $now, $now
      )
    `).run({ ...input, code: safeCode, message: safeMessage })
  }

  private issueLease(key: ActionKey, rowVersion: number): DurableActionLease {
    const lease = Object.freeze({ kind: 'durable-action-lease' as const }) as DurableActionLease
    leaseSecrets.set(lease, { store: this, key, rowVersion, consumed: false })
    this.activeLeases.set(actionMapKey(key), lease)
    return lease
  }

  private blockTask(hostId: string, taskId: string, actionId: string): void {
    this.db.prepare(`
      UPDATE tasks
      SET write_state = 'blocked-indeterminate', blocked_action_id = $actionId,
          can_send = 0, can_interrupt = 0
      WHERE host_id = $hostId AND task_id = $taskId
    `).run({ hostId, taskId, actionId })
  }

  private revokeActions(hostId: string, authorizationId: string): void {
    const now = Date.now()
    const dispatching = this.db.prepare(`
      SELECT client_device_id, action_id, task_id FROM actions
      WHERE host_id = $hostId AND authorization_id = $authorizationId
        AND state = 'dispatching'
    `).all({ hostId, authorizationId })
    this.db.prepare(`
      UPDATE actions
      SET state = 'rejected', row_version = row_version + 1,
          rejection_code = 'offline', rejection_message = 'The device authorization was revoked.',
          updated_at = $now
      WHERE host_id = $hostId AND authorization_id = $authorizationId
        AND state = 'reserved'
    `).run({ hostId, authorizationId, now })
    this.db.prepare(`
      UPDATE actions
      SET state = 'indeterminate', row_version = row_version + 1,
          indeterminate_reason = 'authorization-revoked', updated_at = $now
      WHERE host_id = $hostId AND authorization_id = $authorizationId
        AND state = 'dispatching'
    `).run({ hostId, authorizationId, now })
    for (const row of dispatching) {
      this.blockTask(hostId, safeStringColumn(row, 'task_id'), safeStringColumn(row, 'action_id'))
    }
    for (const [key, lease] of this.activeLeases) {
      const secret = leaseSecrets.get(lease)
      if (secret?.key.hostId === hostId && secret.key.authorizationId === authorizationId) {
        secret.consumed = true
        this.activeLeases.delete(key)
      }
    }
  }
}

function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
    allowBareNamedParameters: true,
    allowUnknownNamedParameters: true,
  })
}

function initializeSchema(db: DatabaseSync): void {
  configureConnection(db, true)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of TABLE_STATEMENTS) db.exec(statement)
    for (const statement of INDEX_STATEMENTS) db.exec(statement)
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.prepare(`
      INSERT INTO store_meta (singleton, store_id, state_revision, boot_id)
      VALUES (1, $storeId, 0, $bootId)
    `).run({ storeId: `store.${randomUUID()}`, bootId: `boot.${randomUUID()}` })
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The caller closes the failed connection.
    }
    throw error
  }
  db.enableDefensive(true)
  validateSchema(db)
}

function recoverExisting(
  db: DatabaseSync,
  expectedBeforeRecovery?: Readonly<ActionStateMetadata>,
): void {
  validateSchema(db)
  configureConnection(db, false)
  db.enableDefensive(true)
  db.exec('BEGIN IMMEDIATE')
  try {
    const beforeRecovery = readStoreMetadata(db)
    if (
      expectedBeforeRecovery !== undefined
      && (
        beforeRecovery.storeId !== expectedBeforeRecovery.storeId
        || beforeRecovery.stateRevision !== expectedBeforeRecovery.stateRevision
      )
    ) fail('rollback-detected')
    const rows = db.prepare(`
      SELECT host_id, task_id, action_id FROM actions WHERE state = 'dispatching'
    `).all()
    const now = Date.now()
    db.prepare(`
      UPDATE actions
      SET state = 'indeterminate', row_version = row_version + 1,
          indeterminate_reason = 'process-restarted', updated_at = $now
      WHERE state = 'dispatching'
    `).run({ now })
    const block = db.prepare(`
      UPDATE tasks
      SET write_state = 'blocked-indeterminate', blocked_action_id = $actionId,
          can_send = 0, can_interrupt = 0
      WHERE host_id = $hostId AND task_id = $taskId
    `)
    for (const row of rows) {
      block.run({
        hostId: safeStringColumn(row, 'host_id'),
        taskId: safeStringColumn(row, 'task_id'),
        actionId: safeStringColumn(row, 'action_id'),
      })
    }
    db.prepare(`
      UPDATE store_meta
      SET state_revision = state_revision + 1, boot_id = $bootId
      WHERE singleton = 1
    `).run({ bootId: `boot.${randomUUID()}` })
    const afterRecovery = readStoreMetadata(db)
    if (
      afterRecovery.storeId !== beforeRecovery.storeId
      || afterRecovery.stateRevision !== beforeRecovery.stateRevision + 1
    ) fail('invalid-store')
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The caller closes the failed connection.
    }
    throw error
  }
}

function buildStore(
  config: ActionStateConfig,
  mode: 'create' | 'open-existing',
  testLimits?: ActionStateTestLimits,
  expectedBeforeRecovery?: Readonly<ActionStateMetadata>,
): ActionStateStore {
  const limits = scopedLimits(testLimits)
  const paths = resolveActionStatePaths(config, mode === 'open-existing')
  if (mode === 'open-existing') {
    const size = statSync(paths.databasePath).size
    if (size <= 0 || size > DATABASE_BYTES_LIMIT) fail('invalid-store')
    const walPath = `${paths.databasePath}-wal`
    if (existsSync(walPath) && statSync(walPath).size > WAL_BYTES_LIMIT) fail('invalid-store')
  }
  let db: DatabaseSync
  try {
    db = openDatabase(paths.databasePath)
    if (db.location('main')?.toLowerCase() !== paths.databasePath.toLowerCase()) fail('unsafe-path')
    if (mode === 'create') initializeSchema(db)
    else recoverExisting(db, expectedBeforeRecovery)
  } catch (error) {
    try {
      db!.close()
    } catch {
      // The original fail-closed error is authoritative.
    }
    if (error instanceof ActionStateError) throw error
    if (sqliteBusy(error)) fail('backpressure')
    fail(mode === 'create' ? 'storage-failed' : 'invalid-store')
  }
  return new ActionStateStore(db, paths.databasePath, limits)
}

export function createActionState(config: ActionStateConfig): ActionStateStore {
  return buildStore(config, 'create')
}

export function openExistingActionState(config: ActionStateConfig): ActionStateStore {
  return buildStore(config, 'open-existing')
}

/** Package-private production seam used by the current-user DPAPI anchor wrapper. */
export function openExistingAnchoredActionState(
  config: ActionStateConfig,
  expectedBeforeRecovery: Readonly<ActionStateMetadata>,
): ActionStateStore {
  if (
    typeof expectedBeforeRecovery !== 'object'
    || expectedBeforeRecovery === null
    || !IDENTIFIER.test(expectedBeforeRecovery.storeId)
    || !Number.isSafeInteger(expectedBeforeRecovery.stateRevision)
    || expectedBeforeRecovery.stateRevision < 0
  ) fail('invalid-store')
  return buildStore(config, 'open-existing', undefined, expectedBeforeRecovery)
}

/** Package-private operator seam for a proven read-only crash gap. */
export function inspectReadOnlyActionStateRecovery(
  config: ActionStateConfig,
): Readonly<ActionStateMetadata> {
  const paths = resolveActionStatePaths(config, true)
  const size = statSync(paths.databasePath).size
  if (size <= 0 || size > DATABASE_BYTES_LIMIT) fail('invalid-store')
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.databasePath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      timeout: 0,
      allowBareNamedParameters: true,
      allowUnknownNamedParameters: true,
    })
    if (db.location('main')?.toLowerCase() !== paths.databasePath.toLowerCase()) fail('unsafe-path')
    db.enableDefensive(true)
    validateSchema(db)
    const countRow = db.prepare('SELECT COUNT(*) AS action_count FROM actions').get()
    if (countRow === undefined || safeIntegerColumn(countRow, 'action_count') !== 0) {
      fail('rollback-detected')
    }
    return readStoreMetadata(db)
  } catch (error) {
    if (error instanceof ActionStateError) throw error
    return fail('invalid-store')
  } finally {
    try { db?.close() } catch { /* preserve validation outcome */ }
  }
}

/** Package-private test seam. It is deliberately absent from the package root. */
export function createActionStateForTest(
  config: ActionStateConfig,
  limits: ActionStateTestLimits,
): ActionStateStore {
  return buildStore(config, 'create', limits)
}

/**
 * Package-private terminal capability mint. It is deliberately absent from the
 * package root and is only used by the trusted action controller and tests.
 */
export function issueTerminalEvidence(
  dispatch: DurableDispatchCapability,
  input: TerminalValue,
): DurableTerminalEvidence {
  const dispatchSecret = dispatchSecrets.get(dispatch)
  if (dispatchSecret === undefined || dispatchSecret.consumed) fail('invalid-capability')
  let value: TerminalValue
  if (input.state === 'accepted') {
    value = Object.freeze({
      state: 'accepted',
      revision: nonnegative(input.revision),
    })
  } else if (input.state === 'rejected') {
    value = Object.freeze({
      state: 'rejected',
      code: identifier(input.code),
      message: safeText(input.message, 512),
    })
  } else if (input.state === 'indeterminate') {
    value = Object.freeze({
      state: 'indeterminate',
      reason: identifier(input.reason),
    })
  } else {
    fail('invalid-transition')
  }
  const evidence = Object.freeze({ kind: 'durable-terminal-evidence' as const }) as DurableTerminalEvidence
  terminalEvidenceSecrets.set(evidence, { dispatch: dispatchSecret, value, consumed: false })
  return evidence
}
