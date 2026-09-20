import { randomUUID } from 'node:crypto'
import {
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'

import {
  ActionStateError,
  type ActionStateConfig,
  type ActionStateMetadata,
  type ActionStateStore,
  createActionState,
  inspectReadOnlyActionStateRecovery,
  openExistingAnchoredActionState,
  resolveActionStatePaths,
} from './action-state.ts'
import {
  protectForCurrentWindowsUser,
  restrictFileToCurrentWindowsUser,
  unprotectForCurrentWindowsUser,
  type WindowsDpapiOptions,
} from './windows-dpapi.ts'

const ANCHOR_VERSION = 1
const MAX_ANCHOR_CIPHERTEXT_BYTES = 64 * 1024
const MAX_ANCHOR_PLAINTEXT_BYTES = 512
const STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

export interface WindowsAnchoredActionStateOptions extends ActionStateConfig {
  readonly dpapi?: WindowsDpapiOptions
}

type WindowsAnchoredActionStateErrorCode =
  | 'unsupported-platform'
  | 'already-exists'
  | 'missing-anchor'
  | 'invalid-anchor'
  | 'rollback-detected'
  | 'backpressure'
  | 'storage-failed'
  | 'closed'

export class WindowsAnchoredActionStateError extends Error {
  constructor(readonly code: WindowsAnchoredActionStateErrorCode) {
    super(`windows-anchored-action-state:${code}`)
    this.name = 'WindowsAnchoredActionStateError'
  }
}

function fail(code: WindowsAnchoredActionStateErrorCode): never {
  throw new WindowsAnchoredActionStateError(code)
}

function sameMetadata(
  left: Readonly<ActionStateMetadata>,
  right: Readonly<ActionStateMetadata>,
): boolean {
  return left.storeId === right.storeId && left.stateRevision === right.stateRevision
}

function parseAnchor(plaintext: Buffer): Readonly<ActionStateMetadata> {
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_ANCHOR_PLAINTEXT_BYTES) {
    fail('invalid-anchor')
  }
  let value: unknown
  try {
    value = JSON.parse(plaintext.toString('utf8'))
  } catch {
    return fail('invalid-anchor')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid-anchor')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 3
    || keys[0] !== 'stateRevision'
    || keys[1] !== 'storeId'
    || keys[2] !== 'version'
    || record.version !== ANCHOR_VERSION
    || typeof record.storeId !== 'string'
    || !STORE_ID.test(record.storeId)
    || !Number.isSafeInteger(record.stateRevision)
    || (record.stateRevision as number) < 0
  ) fail('invalid-anchor')
  return Object.freeze({
    storeId: record.storeId,
    stateRevision: record.stateRevision as number,
  })
}

async function pathKind(path: string): Promise<'missing' | 'file' | 'other'> {
  try {
    const facts = await lstat(path)
    return facts.isFile() && !facts.isSymbolicLink() ? 'file' : 'other'
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT'
    ) return 'missing'
    return fail('storage-failed')
  }
}

async function readAnchor(
  anchorFile: string,
  dpapi: WindowsDpapiOptions,
): Promise<Readonly<ActionStateMetadata>> {
  const kind = await pathKind(anchorFile)
  if (kind === 'missing') fail('missing-anchor')
  if (kind !== 'file') fail('invalid-anchor')
  let ciphertext: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    ciphertext = await readFile(anchorFile)
    if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_ANCHOR_CIPHERTEXT_BYTES) {
      fail('invalid-anchor')
    }
    plaintext = await unprotectForCurrentWindowsUser(ciphertext, dpapi)
    return parseAnchor(plaintext)
  } catch (error) {
    if (error instanceof WindowsAnchoredActionStateError) throw error
    return fail('invalid-anchor')
  } finally {
    ciphertext?.fill(0)
    plaintext?.fill(0)
  }
}

async function writeAnchorAtomic(
  anchorFile: string,
  metadata: Readonly<ActionStateMetadata>,
  dpapi: WindowsDpapiOptions,
  mode: 'create' | 'replace',
): Promise<void> {
  const plaintext = Buffer.from(JSON.stringify({
    version: ANCHOR_VERSION,
    storeId: metadata.storeId,
    stateRevision: metadata.stateRevision,
  }), 'utf8')
  let ciphertext: Buffer | undefined
  const temporary = `${anchorFile}.${randomUUID()}.tmp`
  let handle: FileHandle | undefined
  try {
    ciphertext = await protectForCurrentWindowsUser(plaintext, dpapi)
    if (ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_ANCHOR_CIPHERTEXT_BYTES) {
      fail('storage-failed')
    }
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(ciphertext)
    await handle.sync()
    await handle.close()
    handle = undefined
    await restrictFileToCurrentWindowsUser(temporary, dpapi)
    const current = await pathKind(anchorFile)
    if (mode === 'create' ? current !== 'missing' : current !== 'file') {
      fail(mode === 'create' ? 'already-exists' : 'invalid-anchor')
    }
    await rename(temporary, anchorFile)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    if (error instanceof WindowsAnchoredActionStateError) throw error
    return fail('storage-failed')
  } finally {
    plaintext.fill(0)
    ciphertext?.fill(0)
  }
}

function sqliteLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const errcode = Reflect.get(error, 'errcode')
  return errcode === 5 || errcode === 6
}

async function acquireLifetimeLock(lockFile: string): Promise<DatabaseSync> {
  if (await pathKind(lockFile) === 'other') fail('storage-failed')
  let lock: DatabaseSync | undefined
  try {
    lock = new DatabaseSync(lockFile)
    lock.exec(`
      PRAGMA busy_timeout = 0;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS lifetime_owner (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_token TEXT NOT NULL
      ) STRICT;
      INSERT OR REPLACE INTO lifetime_owner (singleton, owner_token)
      VALUES (1, '${randomUUID()}');
    `)
    return lock
  } catch (error) {
    try { lock?.close() } catch { /* release any partially acquired OS lock */ }
    if (sqliteLockContention(error)) return fail('backpressure')
    return fail('storage-failed')
  }
}

function releaseLifetimeLock(lock: DatabaseSync): void {
  let failed = false
  try {
    lock.exec('ROLLBACK')
  } catch {
    failed = true
  }
  try {
    lock.close()
  } catch {
    failed = true
  }
  if (failed) fail('storage-failed')
}

function releaseLifetimeLockBestEffort(lock: DatabaseSync): void {
  try { lock.exec('ROLLBACK') } catch { /* process-local cleanup after another failure */ }
  try { lock.close() } catch { /* OS release remains process-lifetime bounded */ }
}

export class WindowsAnchoredActionState {
  readonly store: ActionStateStore
  readonly #anchorFile: string
  readonly #dpapi: WindowsDpapiOptions
  #lock: DatabaseSync | undefined
  #lastAnchored: Readonly<ActionStateMetadata>
  #closed = false

  private constructor(input: Readonly<{
    store: ActionStateStore
    anchorFile: string
    lock: DatabaseSync
    dpapi: WindowsDpapiOptions
    lastAnchored: Readonly<ActionStateMetadata>
  }>) {
    this.store = input.store
    this.#anchorFile = input.anchorFile
    this.#lock = input.lock
    this.#dpapi = input.dpapi
    this.#lastAnchored = input.lastAnchored
  }

  static async create(options: WindowsAnchoredActionStateOptions): Promise<WindowsAnchoredActionState> {
    if (process.platform !== 'win32') fail('unsupported-platform')
    const paths = resolveActionStatePaths(options, false)
    const anchorFile = `${paths.databasePath}.anchor.dpapi`
    const lockFile = `${paths.databasePath}.authority.lock`
    for (const path of [anchorFile, `${paths.databasePath}-wal`, `${paths.databasePath}-shm`]) {
      if (await pathKind(path) !== 'missing') fail('already-exists')
    }
    const lock = await acquireLifetimeLock(lockFile)
    let store: ActionStateStore | undefined
    try {
      if (await pathKind(anchorFile) !== 'missing') fail('already-exists')
      store = createActionState(paths)
      const metadata = store.readMetadata()
      await writeAnchorAtomic(anchorFile, metadata, options.dpapi ?? {}, 'create')
      return new WindowsAnchoredActionState({
        store,
        anchorFile,
        lock,
        dpapi: options.dpapi ?? {},
        lastAnchored: metadata,
      })
    } catch (error) {
      try { store?.close() } catch { /* preserve the initialization error */ }
      releaseLifetimeLockBestEffort(lock)
      throw error
    }
  }

  static async openExisting(
    options: WindowsAnchoredActionStateOptions,
  ): Promise<WindowsAnchoredActionState> {
    if (process.platform !== 'win32') fail('unsupported-platform')
    const paths = resolveActionStatePaths(options, true)
    const anchorFile = `${paths.databasePath}.anchor.dpapi`
    const lockFile = `${paths.databasePath}.authority.lock`
    const lock = await acquireLifetimeLock(lockFile)
    let store: ActionStateStore | undefined
    try {
      const dpapi = options.dpapi ?? {}
      const beforeRecovery = await readAnchor(anchorFile, dpapi)
      try {
        store = openExistingAnchoredActionState(paths, beforeRecovery)
      } catch (error) {
        if (error instanceof ActionStateError && error.code === 'rollback-detected') {
          fail('rollback-detected')
        }
        throw error
      }
      const afterRecovery = store.readMetadata()
      if (
        afterRecovery.storeId !== beforeRecovery.storeId
        || afterRecovery.stateRevision !== beforeRecovery.stateRevision + 1
      ) fail('rollback-detected')
      const currentAnchor = await readAnchor(anchorFile, dpapi)
      if (!sameMetadata(currentAnchor, beforeRecovery)) fail('rollback-detected')
      await writeAnchorAtomic(anchorFile, afterRecovery, dpapi, 'replace')
      return new WindowsAnchoredActionState({
        store,
        anchorFile,
        lock,
        dpapi,
        lastAnchored: afterRecovery,
      })
    } catch (error) {
      try { store?.close() } catch { /* preserve the open/recovery error */ }
      releaseLifetimeLockBestEffort(lock)
      throw error
    }
  }

  static async recoverReadOnlyCrashGap(
    options: WindowsAnchoredActionStateOptions,
  ): Promise<Readonly<{ fromRevision: number; toRevision: number }>> {
    if (process.platform !== 'win32') fail('unsupported-platform')
    const paths = resolveActionStatePaths(options, true)
    const anchorFile = `${paths.databasePath}.anchor.dpapi`
    const lockFile = `${paths.databasePath}.authority.lock`
    const lock = await acquireLifetimeLock(lockFile)
    try {
      const dpapi = options.dpapi ?? {}
      const before = await readAnchor(anchorFile, dpapi)
      const current = inspectReadOnlyActionStateRecovery(paths)
      if (
        current.storeId !== before.storeId
        || current.stateRevision <= before.stateRevision
      ) fail('rollback-detected')
      const unchanged = await readAnchor(anchorFile, dpapi)
      if (!sameMetadata(unchanged, before)) fail('rollback-detected')
      await writeAnchorAtomic(anchorFile, current, dpapi, 'replace')
      return Object.freeze({
        fromRevision: before.stateRevision,
        toRevision: current.stateRevision,
      })
    } finally {
      releaseLifetimeLockBestEffort(lock)
    }
  }

  async syncAfterRequestBoundary(): Promise<void> {
    if (this.#closed) fail('closed')
    try {
      const currentAnchor = await readAnchor(this.#anchorFile, this.#dpapi)
      if (!sameMetadata(currentAnchor, this.#lastAnchored)) fail('rollback-detected')
      const current = this.store.readMetadata()
      if (
        current.storeId !== this.#lastAnchored.storeId
        || current.stateRevision < this.#lastAnchored.stateRevision
      ) fail('rollback-detected')
      if (current.stateRevision === this.#lastAnchored.stateRevision) return
      await writeAnchorAtomic(this.#anchorFile, current, this.#dpapi, 'replace')
      this.#lastAnchored = current
    } catch (error) {
      await this.#closeAfterFailure()
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const lock = this.#lock
    this.#lock = undefined
    let failed = false
    try {
      this.store.close()
    } catch {
      failed = true
    }
    if (lock !== undefined) {
      try { releaseLifetimeLock(lock) } catch { failed = true }
    }
    if (failed) fail('storage-failed')
  }

  async #closeAfterFailure(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const lock = this.#lock
    this.#lock = undefined
    try { this.store.close() } catch { /* preserve the original fail-closed error */ }
    if (lock !== undefined) releaseLifetimeLockBestEffort(lock)
  }
}
