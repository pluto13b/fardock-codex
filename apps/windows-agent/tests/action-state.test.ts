import { createHmac, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { win32 as windowsPath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ActionStateError,
  createActionState,
  createActionStateForTest,
  issueTerminalEvidence,
  openExistingActionState,
  type ActionStateConfig,
  type ActionStateStore,
  type DurableActionLease,
  type DurableDispatchCapability,
  type DurableTerminalEvidence,
  type InboundActionReservationInput,
} from '../src/action-state.ts'

const WORKSPACE_ROOT = windowsPath.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = windowsPath.join(WORKSPACE_ROOT, '.tmp', 'windows-agent-tests')

let caseDirectory = ''
let stores: ActionStateStore[] = []

function tracked(store: ActionStateStore): ActionStateStore {
  stores.push(store)
  return store
}

function config(name = 'action-state.sqlite'): ActionStateConfig {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    databasePath: windowsPath.join(caseDirectory, name),
  }
}

function expectCode(action: () => unknown, code: ActionStateError['code']): void {
  expect(action).toThrowError(expect.objectContaining({ code }))
}

function keyedFingerprint(value: string): string {
  return createHmac('sha256', Buffer.alloc(32, 0x5a)).update(value, 'utf8').digest('base64url')
}

const AUTHORITY = Object.freeze({
  hostId: 'host.action-state',
  authorizationId: 'authorization.action-state',
  clientDeviceId: 'client.action-state',
  authorizationEpoch: 1,
  connectionGeneration: 7,
})

const CHANNEL = Object.freeze({
  ...AUTHORITY,
  inboundKeyId: 'key.client-to-host',
  outboundKeyId: 'key.host-to-client',
})

const TASK = Object.freeze({
  hostId: AUTHORITY.hostId,
  taskId: 'task.action-state',
  workspaceId: 'workspace.action-state',
  revision: 4,
  writeState: 'writable' as const,
  canSend: true,
  canInterrupt: false,
})

function initialize(store: ActionStateStore): void {
  store.applyAuthorization({
    ...AUTHORITY,
    status: 'active',
    revision: 1,
  })
  store.activateChannel({
    ...CHANNEL,
    lastInboundSequence: 1,
    lastPeerAck: 0,
    maxSentSequence: 1,
  })
  store.upsertTask(TASK)
}

function reservation(
  overrides: Partial<InboundActionReservationInput> = {},
): InboundActionReservationInput {
  return {
    ...AUTHORITY,
    inboundKeyId: CHANNEL.inboundKeyId,
    sequence: 2,
    ack: 0,
    actionId: 'action.send.1',
    taskId: TASK.taskId,
    operation: 'turn.send',
    expectedRevision: TASK.revision,
    requestFingerprint: keyedFingerprint('canonical request one'),
    now: 1_000,
    ...overrides,
  }
}

function actionKey(actionId = 'action.send.1') {
  return {
    hostId: AUTHORITY.hostId,
    authorizationId: AUTHORITY.authorizationId,
    clientDeviceId: AUTHORITY.clientDeviceId,
    actionId,
  }
}

function reserveLease(store: ActionStateStore): DurableActionLease {
  const result = store.commitInboundReservation(reservation())
  expect(result.kind).toBe('claimed')
  if (result.kind !== 'claimed') throw new Error('expected a claimed lease')
  return result.lease
}

function begin(store: ActionStateStore, lease: DurableActionLease): DurableDispatchCapability {
  const result = store.beginDispatch(lease, 11, 1_001)
  expect(result.kind).toBe('dispatching')
  if (result.kind !== 'dispatching') throw new Error('expected dispatching')
  return result.dispatch
}

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
  caseDirectory = windowsPath.join(TEST_ROOT, `case-${randomUUID()}`)
  mkdirSync(caseDirectory, { recursive: true })
  stores = []
})

afterEach(() => {
  for (const store of stores.reverse()) store.close()
  stores = []
  const relative = windowsPath.relative(TEST_ROOT, caseDirectory)
  if (relative.length > 0 && !relative.startsWith('..') && !windowsPath.isAbsolute(relative)) {
    rmSync(caseDirectory, { recursive: true, force: true })
  }
})

describe('workspace-local SQLite boundary', () => {
  it('advances connection generation without inventing a new authorization revision', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    store.applyAuthorization({
      ...AUTHORITY,
      connectionGeneration: AUTHORITY.connectionGeneration + 1,
      revision: 1,
      status: 'active',
    })
    expectCode(() => store.applyAuthorization({
      ...AUTHORITY,
      connectionGeneration: AUTHORITY.connectionGeneration,
      revision: 1,
      status: 'active',
    }), 'stale-authority')
  })

  it('separates exclusive create from strict open-existing and fixes the schema identity', () => {
    const selected = config()
    expectCode(() => openExistingActionState(selected), 'missing-store')

    const created = tracked(createActionState(selected))
    const createdMetadata = created.readMetadata()
    expect(createdMetadata).toEqual({
      storeId: expect.stringMatching(/^store\.[A-Za-z0-9-]+$/),
      stateRevision: 0,
    })
    expect(Object.isFrozen(createdMetadata)).toBe(true)
    initialize(created)
    expect(created.readMetadata()).toEqual({
      storeId: createdMetadata.storeId,
      stateRevision: 3,
    })
    expectCode(() => createActionState(selected), 'already-exists')
    created.close()

    const reopened = tracked(openExistingActionState(selected))
    expect(reopened.readMetadata()).toEqual({
      storeId: createdMetadata.storeId,
      stateRevision: 4,
    })
    expect(reopened.getChannelState(CHANNEL)).toMatchObject({
      lastInboundSequence: 1,
      lastPeerAck: 0,
      maxSentSequence: 1,
    })

    const inspection = new DatabaseSync(selected.databasePath, { readOnly: true })
    try {
      expect(Object.values(inspection.prepare('PRAGMA application_id').get() ?? {})[0]).toBe(0x43505841)
      expect(Object.values(inspection.prepare('PRAGMA user_version').get() ?? {})[0]).toBe(1)
      expect(String(Object.values(inspection.prepare('PRAGMA journal_mode').get() ?? {})[0]).toLowerCase()).toBe('wal')
      const tables = inspection.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
      `).all().map((row) => row.name)
      expect(tables).toEqual([
        'actions',
        'authorizations',
        'channels',
        'outbound_frames',
        'store_meta',
        'tasks',
      ])
    } finally {
      inspection.close()
    }
  })

  it('rejects paths outside .data/.tmp, UNC/device/ADS paths, and a database parent junction', () => {
    const outside = windowsPath.join(WORKSPACE_ROOT, 'action-state.sqlite')
    expectCode(() => createActionState({ workspaceRoot: WORKSPACE_ROOT, databasePath: outside }), 'unsafe-path')
    expectCode(() => createActionState({
      workspaceRoot: WORKSPACE_ROOT,
      databasePath: '\\\\server\\share\\action.sqlite',
    }), 'unsafe-path')
    expectCode(() => createActionState({
      workspaceRoot: WORKSPACE_ROOT,
      databasePath: `${windowsPath.join(caseDirectory, 'action.sqlite')}:stream`,
    }), 'unsafe-path')
    expectCode(() => createActionState({
      workspaceRoot: WORKSPACE_ROOT,
      databasePath: '\\\\.\\C:\\action.sqlite',
    }), 'unsafe-path')

    const target = windowsPath.join(caseDirectory, 'real-parent')
    const link = windowsPath.join(caseDirectory, 'linked-parent')
    mkdirSync(target)
    symlinkSync(target, link, 'junction')
    expectCode(() => createActionState({
      workspaceRoot: WORKSPACE_ROOT,
      databasePath: windowsPath.join(link, 'action.sqlite'),
    }), 'unsafe-path')
  })

  it('fails closed for corrupt, unknown-version, or schema-extended stores', () => {
    const corrupt = config('corrupt.sqlite')
    writeFileSync(corrupt.databasePath, Buffer.from('not sqlite', 'utf8'))
    expectCode(() => openExistingActionState(corrupt), 'invalid-store')

    const unknownVersion = config('unknown.sqlite')
    tracked(createActionState(unknownVersion)).close()
    const versionWriter = new DatabaseSync(unknownVersion.databasePath)
    versionWriter.exec('PRAGMA user_version = 2')
    versionWriter.close()
    expectCode(() => openExistingActionState(unknownVersion), 'invalid-store')

    const extended = config('extended.sqlite')
    tracked(createActionState(extended)).close()
    const schemaWriter = new DatabaseSync(extended.databasePath)
    schemaWriter.exec('CREATE TABLE surprise (value INTEGER) STRICT')
    schemaWriter.close()
    expectCode(() => openExistingActionState(extended), 'invalid-store')
  })

  it('maps a concurrent writer lock to backpressure without falling back to memory', () => {
    const selected = config()
    const store = tracked(createActionState(selected))
    initialize(store)
    const blocker = new DatabaseSync(selected.databasePath, { timeout: 0 })
    blocker.exec('BEGIN IMMEDIATE')
    try {
      expectCode(() => store.upsertTask({ ...TASK, taskId: 'task.locked' }), 'backpressure')
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
    store.upsertTask({ ...TASK, taskId: 'task.after-lock' })
  })
})

describe('atomic inbound reservation and encrypted outbound retention', () => {
  it('commits a read-only seq/ack and acknowledged raw-frame deletion atomically', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    store.commitOutboundFrame({
      ...CHANNEL,
      sequence: 2,
      encryptedWireText: '{"ciphertext":"cmVhZC1yZXNwb25zZQ"}',
    })

    store.commitInboundReadOnly({
      ...AUTHORITY,
      inboundKeyId: CHANNEL.inboundKeyId,
      sequence: 2,
      ack: 2,
    })

    expect(store.getChannelState(CHANNEL)).toEqual({
      lastInboundSequence: 2,
      lastPeerAck: 2,
      maxSentSequence: 2,
      outboundFrameCount: 0,
      outboundFrameBytes: 0,
    })
    expect(store.getTaskState({ hostId: AUTHORITY.hostId, taskId: TASK.taskId })).toEqual({
      taskId: TASK.taskId,
      workspaceId: TASK.workspaceId,
      revision: TASK.revision,
      writeState: TASK.writeState,
      canSend: TASK.canSend,
      canInterrupt: TASK.canInterrupt,
    })
    expectCode(() => store.commitInboundReadOnly({
      ...AUTHORITY,
      inboundKeyId: CHANNEL.inboundKeyId,
      sequence: 2,
      ack: 2,
    }), 'replay')
  })

  it('commits seq/ack, acknowledged raw-frame deletion, and reservation together', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    const encryptedWireText = '{"ciphertext":"Y2lwaGVydGV4dA"}'
    store.commitOutboundFrame({
      ...CHANNEL,
      sequence: 2,
      encryptedWireText,
    })

    const claimed = store.commitInboundReservation(reservation({ ack: 2 }))
    expect(claimed.kind).toBe('claimed')
    expect(store.getChannelState(CHANNEL)).toEqual({
      lastInboundSequence: 2,
      lastPeerAck: 2,
      maxSentSequence: 2,
      outboundFrameCount: 0,
      outboundFrameBytes: 0,
    })
    expect(store.getActionStatus(actionKey())).toMatchObject({
      state: 'reserved',
      firstConnectionGeneration: AUTHORITY.connectionGeneration,
      firstInboundKeyId: CHANNEL.inboundKeyId,
      firstInboundSequence: 2,
    })
  })

  it('rolls back seq/ack and raw-frame deletion on an action-id conflict', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    store.commitOutboundFrame({
      ...CHANNEL,
      sequence: 2,
      encryptedWireText: '{"ciphertext":"cmV0YWluLW9uLXJvbGxiYWNr"}',
    })
    reserveLease(store)

    expectCode(() => store.commitInboundReservation(reservation({
      sequence: 3,
      ack: 2,
      requestFingerprint: keyedFingerprint('different canonical request'),
    })), 'action-id-conflict')

    expect(store.getChannelState(CHANNEL)).toEqual({
      lastInboundSequence: 2,
      lastPeerAck: 0,
      maxSentSequence: 2,
      outboundFrameCount: 1,
      outboundFrameBytes: Buffer.byteLength('{"ciphertext":"cmV0YWluLW9uLXJvbGxiYWNr"}'),
    })
  })

  it('persists a definite stale-task rejection in the same inbound transaction', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    const result = store.commitInboundReservation(reservation({ expectedRevision: 3 }))
    expect(result).toMatchObject({
      kind: 'terminal',
      receipt: {
        state: 'rejected',
        rejection: { code: 'stale-task-revision' },
      },
    })
    expect(store.getChannelState(CHANNEL).lastInboundSequence).toBe(2)

    const replay = store.commitInboundReservation(reservation({
      sequence: 3,
      expectedRevision: 3,
    }))
    expect(replay).toEqual(result)
    expect(store.getChannelState(CHANNEL).lastInboundSequence).toBe(3)
  })

  it('rejects replay/gap/ack regression/ahead without consuming channel state', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    reserveLease(store)
    expectCode(() => store.commitInboundReservation(reservation()), 'replay')
    expectCode(() => store.commitInboundReservation(reservation({ sequence: 4 })), 'sequence-gap')
    expectCode(() => store.commitInboundReservation(reservation({ sequence: 3, ack: 2 })), 'ack-ahead')
    expect(store.getChannelState(CHANNEL).lastInboundSequence).toBe(2)
  })
})

describe('opaque action capabilities and crash recovery', () => {
  it('requires the original one-shot lease and opaque terminal evidence', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    const lease = reserveLease(store)
    const copiedLease = { ...lease } as DurableActionLease
    expectCode(() => store.beginDispatch(copiedLease, 11, 1_001), 'invalid-capability')

    const secondStore = tracked(createActionState(config('other.sqlite')))
    initialize(secondStore)
    expectCode(() => secondStore.beginDispatch(lease, 11, 1_001), 'invalid-capability')

    const dispatch = begin(store, lease)
    expectCode(() => store.beginDispatch(lease, 11, 1_002), 'invalid-capability')
    const evidence = issueTerminalEvidence(dispatch, { state: 'accepted', revision: 5 })
    const copiedEvidence = { ...evidence } as DurableTerminalEvidence
    expectCode(() => store.commitTerminal(dispatch, copiedEvidence, 1_003), 'invalid-capability')

    expect(store.commitTerminal(dispatch, evidence, 1_003)).toEqual({
      actionId: 'action.send.1',
      state: 'accepted',
      revision: 5,
    })
    expect(store.getTaskState({ hostId: AUTHORITY.hostId, taskId: TASK.taskId })).toMatchObject({
      revision: 5,
      canSend: false,
    })
    expectCode(() => store.commitTerminal(dispatch, evidence, 1_004), 'invalid-capability')
  })

  it('replays an accepted terminal result on a later inbound sequence without a second lease', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    const dispatch = begin(store, reserveLease(store))
    const evidence = issueTerminalEvidence(dispatch, { state: 'accepted', revision: 5 })
    store.commitTerminal(dispatch, evidence, 1_002)

    const replay = store.commitInboundReservation(reservation({ sequence: 3 }))
    expect(replay).toEqual({
      kind: 'terminal',
      receipt: { actionId: 'action.send.1', state: 'accepted', revision: 5 },
    })
    expect(store.getActionStatus(actionKey())).toMatchObject({
      state: 'accepted',
      firstInboundSequence: 2,
    })
  })

  it('rolls back accepted evidence when the durable task revision no longer matches', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    const dispatch = begin(store, reserveLease(store))
    store.upsertTask({ ...TASK, revision: 6 })

    const evidence = issueTerminalEvidence(dispatch, { state: 'accepted', revision: 5 })
    expectCode(() => store.commitTerminal(dispatch, evidence, 1_002), 'invalid-transition')
    expect(store.getTaskState({ hostId: AUTHORITY.hostId, taskId: TASK.taskId })).toMatchObject({
      revision: 6,
      canSend: true,
    })
    expect(store.getActionStatus(actionKey())).toMatchObject({ state: 'dispatching' })
  })

  it('converts dispatching to indeterminate on reopen, blocks the task, and maps replay to queued', () => {
    const selected = config()
    const first = tracked(createActionState(selected))
    initialize(first)
    begin(first, reserveLease(first))
    first.close()

    const reopened = tracked(openExistingActionState(selected))
    expect(reopened.getActionStatus(actionKey())).toMatchObject({
      state: 'indeterminate',
      receipt: {
        actionId: 'action.send.1',
        state: 'queued',
        recoveryRequired: true,
      },
    })
    expect(reopened.commitInboundReservation(reservation({ sequence: 3 }))).toEqual({
      kind: 'terminal',
      receipt: {
        actionId: 'action.send.1',
        state: 'queued',
        recoveryRequired: true,
      },
    })
    expect(reopened.commitInboundReservation(reservation({
      sequence: 4,
      actionId: 'action.send.blocked',
      requestFingerprint: keyedFingerprint('blocked action'),
    }))).toMatchObject({
      kind: 'terminal',
      receipt: {
        state: 'rejected',
        rejection: { code: 'capability-denied' },
      },
    })
    expect(reopened.getTaskState({ hostId: AUTHORITY.hostId, taskId: TASK.taskId }))
      .toMatchObject({ writeState: 'blocked-indeterminate', canSend: false })
    expect(reopened.releaseIndeterminateTaskBlocksForLocalOperator()).toBe(1)
    expect(reopened.getTaskState({ hostId: AUTHORITY.hostId, taskId: TASK.taskId }))
      .toMatchObject({ writeState: 'read-only', canSend: false })
    expect(reopened.getActionStatus(actionKey())).toMatchObject({ state: 'indeterminate' })
    reopened.upsertTask(TASK)
    expect(reopened.getTaskState({ hostId: AUTHORITY.hostId, taskId: TASK.taskId }))
      .toMatchObject({ writeState: 'writable', canSend: true })
  })

  it('turns revocation races into rejected/indeterminate durable states', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    const firstLease = reserveLease(store)
    const second = store.commitInboundReservation(reservation({
      sequence: 3,
      actionId: 'action.send.2',
      requestFingerprint: keyedFingerprint('canonical request two'),
    }))
    expect(second.kind).toBe('claimed')
    const dispatch = begin(store, firstLease)

    store.applyAuthorization({
      ...AUTHORITY,
      authorizationEpoch: 2,
      connectionGeneration: 8,
      status: 'revoked',
      revision: 2,
    })
    expect(store.getActionStatus(actionKey())).toMatchObject({ state: 'indeterminate' })
    expect(store.getActionStatus(actionKey('action.send.2'))).toMatchObject({
      state: 'rejected',
      receipt: { state: 'rejected', rejection: { code: 'offline' } },
    })
    const evidence = issueTerminalEvidence(dispatch, { state: 'accepted', revision: 5 })
    expectCode(() => store.commitTerminal(dispatch, evidence, 1_010), 'invalid-transition')
  })
})

describe('hard ceilings and secret minimization', () => {
  it('enforces reduced test ceilings without allowing them above production maxima', () => {
    expectCode(() => createActionStateForTest(config(), { actions: 2_049 }), 'invalid-config')

    const store = tracked(createActionStateForTest(config('limited.sqlite'), {
      authorizations: 2,
      tasks: 2,
      actions: 2,
      outboundFramesPerChannel: 2,
      outboundBytes: 1_024,
    }))
    initialize(store)
    store.applyAuthorization({
      hostId: 'host.second',
      authorizationId: 'authorization.second',
      clientDeviceId: 'client.second',
      authorizationEpoch: 1,
      connectionGeneration: 1,
      status: 'active',
      revision: 1,
    })
    expectCode(() => store.applyAuthorization({
      hostId: 'host.third',
      authorizationId: 'authorization.third',
      clientDeviceId: 'client.third',
      authorizationEpoch: 1,
      connectionGeneration: 1,
      status: 'active',
      revision: 1,
    }), 'capacity-exceeded')

    store.upsertTask({ ...TASK, taskId: 'task.second' })
    expectCode(() => store.upsertTask({ ...TASK, taskId: 'task.third' }), 'capacity-exceeded')

    store.commitInboundReservation(reservation({ actionId: 'action.one' }))
    store.commitInboundReservation(reservation({
      sequence: 3,
      actionId: 'action.two',
      requestFingerprint: keyedFingerprint('two'),
    }))
    expectCode(() => store.commitInboundReservation(reservation({
      sequence: 4,
      actionId: 'action.three',
      requestFingerprint: keyedFingerprint('three'),
    })), 'capacity-exceeded')
    expect(store.getChannelState(CHANNEL).lastInboundSequence).toBe(3)
  })

  it('enforces the encrypted frame count and aggregate byte ceilings atomically', () => {
    const store = tracked(createActionStateForTest(config(), {
      outboundFramesPerChannel: 2,
      outboundBytes: 96,
    }))
    initialize(store)
    const first = '{"ciphertext":"MTExMTExMTExMTExMTExMTExMTEx"}'
    const second = '{"ciphertext":"MjIyMjIyMjIyMjIyMjIyMjIyMjIy"}'
    store.commitOutboundFrame({ ...CHANNEL, sequence: 2, encryptedWireText: first })
    store.commitOutboundFrame({ ...CHANNEL, sequence: 3, encryptedWireText: second })
    expectCode(() => store.commitOutboundFrame({
      ...CHANNEL,
      sequence: 4,
      encryptedWireText: '{"ciphertext":"MzMz"}',
    }), 'backpressure')
    expect(store.getChannelState(CHANNEL)).toMatchObject({
      maxSentSequence: 3,
      outboundFrameCount: 2,
      outboundFrameBytes: Buffer.byteLength(first) + Buffer.byteLength(second),
    })
  })

  it('stores only the keyed fingerprint and encrypted outbound frame, never bait plaintext', () => {
    const selected = config()
    const store = tracked(createActionState(selected))
    initialize(store)
    const bait = '机密提示词  KEEP-SPACE  🔐\n```ts\nneverPersist()\n```'
    store.commitOutboundFrame({
      ...CHANNEL,
      sequence: 2,
      encryptedWireText: '{"ciphertext":"YWVhZC1jaXBoZXJ0ZXh0LW9ubHk"}',
    })
    store.commitInboundReservation(reservation({
      requestFingerprint: keyedFingerprint(bait),
    }))
    store.close()

    const baitBytes = Buffer.from(bait, 'utf8')
    for (const path of [selected.databasePath, `${selected.databasePath}-wal`, `${selected.databasePath}-shm`]) {
      if (existsSync(path)) expect(readFileSync(path).includes(baitBytes)).toBe(false)
    }
  })

  it('rejects invalid identifiers and non-canonical 32-byte fingerprints', () => {
    const store = tracked(createActionState(config()))
    initialize(store)
    expectCode(() => store.commitInboundReservation(reservation({ actionId: 'bad id' })), 'stale-authority')
    expectCode(() => store.commitInboundReservation(reservation({ requestFingerprint: 'B'.repeat(43) })), 'stale-authority')
    expect(store.getChannelState(CHANNEL).lastInboundSequence).toBe(1)
  })
})
