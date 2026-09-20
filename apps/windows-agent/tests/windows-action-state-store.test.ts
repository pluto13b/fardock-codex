import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  mkdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ActionStateConfig } from '../src/action-state.ts'
import {
  WindowsAnchoredActionState,
  type WindowsAnchoredActionStateError,
} from '../src/windows-action-state-store.ts'
import { releaseProductionIndeterminateBlocks } from '../src/operator-recovery.ts'

const WORKSPACE_ROOT = windowsPath.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = windowsPath.join(WORKSPACE_ROOT, '.tmp', 'windows-action-anchor-tests')
const WINDOWS_AGENT_ROOT = windowsPath.join(WORKSPACE_ROOT, 'apps', 'windows-agent')
const ACTION_STATE_MODULE = new URL('../src/windows-action-state-store.ts', import.meta.url).href

let caseDirectory = ''
let authorities: WindowsAnchoredActionState[] = []

function config(name = 'action.sqlite'): ActionStateConfig {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    databasePath: windowsPath.join(caseDirectory, name),
  }
}

function anchorFile(selected: ActionStateConfig): string {
  return `${selected.databasePath}.anchor.dpapi`
}

function lifetimeLockFile(selected: ActionStateConfig): string {
  return `${selected.databasePath}.authority.lock`
}

async function createInCrashedOwner(selected: ActionStateConfig): Promise<void> {
  const source = [
    `import { WindowsAnchoredActionState } from ${JSON.stringify(ACTION_STATE_MODULE)}`,
    `await WindowsAnchoredActionState.create(${JSON.stringify(selected)})`,
    'process.exit(0)',
  ].join(';')
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', source,
  ], {
    cwd: WINDOWS_AGENT_ROOT,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let errorText = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    if (errorText.length < 4_096) errorText += String(chunk).slice(0, 4_096 - errorText.length)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`Crashed lock owner setup failed (${code}): ${errorText}`)
}

function stateRevision(databasePath: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = db.prepare('SELECT state_revision FROM store_meta WHERE singleton = 1').get()
    return Object.values(row ?? {})[0] as number
  } finally {
    db.close()
  }
}

async function expectCode(
  operation: Promise<unknown>,
  code: WindowsAnchoredActionStateError['code'],
): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code })
}

beforeEach(async () => {
  await mkdir(TEST_ROOT, { recursive: true })
  caseDirectory = windowsPath.join(TEST_ROOT, `case-${randomUUID()}`)
  await mkdir(caseDirectory, { recursive: true })
  authorities = []
})

afterEach(async () => {
  for (const authority of authorities.reverse()) await authority.close().catch(() => undefined)
  authorities = []
  await rm(caseDirectory, { recursive: true, force: true })
})

describe('Windows current-user DPAPI action anchor', () => {
  it('creates the DB and opaque anchor together, syncs a request boundary, and advances once on recovery', async () => {
    const selected = config()
    const created = await WindowsAnchoredActionState.create(selected)
    authorities.push(created)
    const initial = created.store.readMetadata()
    expect(initial.stateRevision).toBe(0)
    expect((await readFile(anchorFile(selected))).toString('utf8')).not.toContain(initial.storeId)

    created.store.applyAuthorization({
      hostId: 'host.anchor',
      authorizationId: 'authorization.anchor',
      clientDeviceId: 'client.anchor',
      authorizationEpoch: 1,
      connectionGeneration: 1,
      revision: 1,
      status: 'active',
    })
    expect(created.store.readMetadata().stateRevision).toBe(1)
    await created.syncAfterRequestBoundary()
    await created.close()

    const reopened = await WindowsAnchoredActionState.openExisting(selected)
    authorities.push(reopened)
    expect(reopened.store.readMetadata()).toEqual({
      storeId: initial.storeId,
      stateRevision: 2,
    })
    await reopened.syncAfterRequestBoundary()
    await expectCode(WindowsAnchoredActionState.openExisting(selected), 'backpressure')
    expect(existsSync(lifetimeLockFile(selected))).toBe(true)
    expect(reopened.store.readMetadata().stateRevision).toBe(2)
    await reopened.close()
    expect(existsSync(lifetimeLockFile(selected))).toBe(true)

    const next = await WindowsAnchoredActionState.openExisting(selected)
    authorities.push(next)
    expect(next.store.readMetadata().stateRevision).toBe(3)
  }, 45_000)

  it('reacquires a persistent SQLite lifetime lock after its owner process exits abruptly', async () => {
    const selected = config()
    await createInCrashedOwner(selected)
    expect(existsSync(lifetimeLockFile(selected))).toBe(true)

    const recovered = await WindowsAnchoredActionState.openExisting(selected)
    authorities.push(recovered)
    expect(recovered.store.readMetadata().stateRevision).toBe(1)
    await expectCode(WindowsAnchoredActionState.openExisting(selected), 'backpressure')
    expect(recovered.store.readMetadata().stateRevision).toBe(1)
  }, 45_000)

  it('fails closed without advancing recovery when a committed DB revision was not anchored', async () => {
    const selected = config()
    const created = await WindowsAnchoredActionState.create(selected)
    authorities.push(created)
    const storeId = created.store.readMetadata().storeId
    const originalAnchor = await readFile(anchorFile(selected))
    created.store.applyAuthorization({
      hostId: 'host.unsynced',
      authorizationId: 'authorization.unsynced',
      clientDeviceId: 'client.unsynced',
      authorizationEpoch: 1,
      connectionGeneration: 1,
      revision: 1,
      status: 'active',
    })
    await created.close()

    expect(stateRevision(selected.databasePath)).toBe(1)
    await expectCode(WindowsAnchoredActionState.openExisting(selected), 'rollback-detected')
    expect(stateRevision(selected.databasePath)).toBe(1)
    await expectCode(WindowsAnchoredActionState.openExisting(selected), 'rollback-detected')
    expect(stateRevision(selected.databasePath)).toBe(1)
    expect(await readFile(anchorFile(selected))).toEqual(originalAnchor)

    await expect(WindowsAnchoredActionState.recoverReadOnlyCrashGap(selected)).resolves.toEqual({
      fromRevision: 0,
      toRevision: 1,
    })
    const recovered = await WindowsAnchoredActionState.openExisting(selected)
    authorities.push(recovered)
    expect(recovered.store.readMetadata()).toEqual({
      storeId,
      stateRevision: 2,
    })
  }, 30_000)

  it('rejects a rolled-back, missing, or corrupt anchor and never recreates it', async () => {
    const rolledBack = config('rollback.sqlite')
    const authority = await WindowsAnchoredActionState.create(rolledBack)
    authorities.push(authority)
    const oldAnchor = await readFile(anchorFile(rolledBack))
    authority.store.applyAuthorization({
      hostId: 'host.rollback',
      authorizationId: 'authorization.rollback',
      clientDeviceId: 'client.rollback',
      authorizationEpoch: 1,
      connectionGeneration: 1,
      revision: 1,
      status: 'active',
    })
    await authority.syncAfterRequestBoundary()
    await authority.close()
    await writeFile(anchorFile(rolledBack), oldAnchor)
    await expectCode(WindowsAnchoredActionState.openExisting(rolledBack), 'rollback-detected')
    expect(stateRevision(rolledBack.databasePath)).toBe(1)

    const missing = config('missing.sqlite')
    const missingAuthority = await WindowsAnchoredActionState.create(missing)
    authorities.push(missingAuthority)
    await missingAuthority.close()
    await unlink(anchorFile(missing))
    await expectCode(WindowsAnchoredActionState.openExisting(missing), 'missing-anchor')
    expect(existsSync(anchorFile(missing))).toBe(false)

    const corrupt = config('corrupt.sqlite')
    const corruptAuthority = await WindowsAnchoredActionState.create(corrupt)
    authorities.push(corruptAuthority)
    await corruptAuthority.close()
    const corruptBytes = Buffer.from('not-dpapi', 'utf8')
    await writeFile(anchorFile(corrupt), corruptBytes)
    await expectCode(WindowsAnchoredActionState.openExisting(corrupt), 'invalid-anchor')
    expect(await readFile(anchorFile(corrupt))).toEqual(corruptBytes)
  }, 45_000)

  it('poisons an active authority when its anchor disappears instead of recreating it', async () => {
    const selected = config()
    const authority = await WindowsAnchoredActionState.create(selected)
    authorities.push(authority)
    await unlink(anchorFile(selected))
    await expectCode(authority.syncAfterRequestBoundary(), 'missing-anchor')
    expect(existsSync(anchorFile(selected))).toBe(false)
    expect(() => authority.store.readMetadata()).toThrowError(
      expect.objectContaining({ code: 'closed' }),
    )
  }, 30_000)

  it('runs local operator recovery through the DPAPI-anchored boundary', async () => {
    const workspaceRoot = windowsPath.join(caseDirectory, 'workspace')
    const stateDirectory = windowsPath.join(workspaceRoot, '.data', 'windows-companion')
    await mkdir(stateDirectory, { recursive: true })
    const selected = {
      workspaceRoot,
      databasePath: windowsPath.join(stateDirectory, 'action.sqlite'),
    }
    const created = await WindowsAnchoredActionState.create(selected)
    authorities.push(created)
    await created.close()

    await expect(releaseProductionIndeterminateBlocks(workspaceRoot)).resolves.toBe(0)
    const reopened = await WindowsAnchoredActionState.openExisting(selected)
    authorities.push(reopened)
    expect(reopened.store.readMetadata().stateRevision).toBe(3)
  }, 30_000)
})
