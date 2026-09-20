import { createHmac, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { win32 as windowsPath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  APP_SERVER_METHODS,
  AppServerSupervisor,
  type Notification,
} from '../src/index.ts'
import { runDurableTextAction } from '../src/action-controller.ts'
import {
  createActionState,
  openExistingActionState,
  type ActionStateConfig,
  type ActionStateStore,
  type DurableActionLease,
} from '../src/action-state.ts'
import { establishRuntimeCompatibilityForTest } from '../src/runtime-binding.ts'

const WORKSPACE_ROOT = windowsPath.resolve(import.meta.dirname, '..', '..', '..')
const TEST_ROOT = windowsPath.join(WORKSPACE_ROOT, '.tmp', 'windows-agent-tests')
const fakeChild = fileURLToPath(new URL('./fixtures/fake-turn-app-server.mjs', import.meta.url))

const AUTHORITY = Object.freeze({
  hostId: 'host.action-controller',
  authorizationId: 'authorization.action-controller',
  clientDeviceId: 'client.action-controller',
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
  taskId: 'task.action-controller',
  workspaceId: 'workspace.action-controller',
  revision: 4,
  writeState: 'writable' as const,
  canSend: true,
  canInterrupt: false,
})

let caseDirectory = ''
let stores: ActionStateStore[] = []
let supervisors: AppServerSupervisor[] = []

function config(): ActionStateConfig {
  return {
    workspaceRoot: WORKSPACE_ROOT,
    databasePath: windowsPath.join(caseDirectory, 'action-controller.sqlite'),
  }
}

function trackedStore(store: ActionStateStore): ActionStateStore {
  stores.push(store)
  return store
}

function fingerprint(value: string): string {
  return createHmac('sha256', Buffer.alloc(32, 0x37)).update(value).digest('base64url')
}

function reserve(store: ActionStateStore): DurableActionLease {
  store.applyAuthorization({ ...AUTHORITY, status: 'active', revision: 1 })
  store.activateChannel({
    ...CHANNEL,
    lastInboundSequence: 1,
    lastPeerAck: 0,
    maxSentSequence: 1,
  })
  store.upsertTask(TASK)
  const result = store.commitInboundReservation({
    ...AUTHORITY,
    inboundKeyId: CHANNEL.inboundKeyId,
    sequence: 2,
    ack: 0,
    actionId: 'action.controller.1',
    taskId: TASK.taskId,
    operation: 'turn.send',
    expectedRevision: TASK.revision,
    requestFingerprint: fingerprint('controller request one'),
    now: 1_000,
  })
  if (result.kind !== 'claimed') throw new Error('Expected an action lease.')
  return result.lease
}

async function ready(mode = 'normal') {
  const supervisor = new AppServerSupervisor({
    command: { executable: process.execPath, args: [fakeChild, mode] },
    clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
    allowedMethods: APP_SERVER_METHODS,
    limits: {
      maxLineBytes: 64 * 1024,
      maxStderrBytes: 16 * 1024,
      maxPendingRequests: 8,
      maxPendingServerRequests: 4,
      maxNotificationSubscribers: 4,
      maxBufferedNotifications: 8,
      maxWriteQueueBytes: 128 * 1024,
      maxWriteQueueFrames: 8,
      initializationTimeoutMs: 2_000,
      requestTimeoutMs: 100,
      serverRequestTimeoutMs: 100,
      shutdownGraceMs: 100,
    },
  })
  supervisors.push(supervisor)
  await supervisor.start()
  return {
    supervisor,
    compatibility: await establishRuntimeCompatibilityForTest(supervisor),
  }
}

function actionKey(actionId = 'action.controller.1') {
  return {
    hostId: AUTHORITY.hostId,
    authorizationId: AUTHORITY.authorizationId,
    clientDeviceId: AUTHORITY.clientDeviceId,
    actionId,
  }
}

beforeEach(() => {
  mkdirSync(TEST_ROOT, { recursive: true })
  caseDirectory = windowsPath.join(TEST_ROOT, `controller-${randomUUID()}`)
  mkdirSync(caseDirectory, { recursive: true })
  stores = []
  supervisors = []
})

afterEach(async () => {
  await Promise.all(supervisors.map((supervisor) => supervisor.close()))
  for (const store of stores.reverse()) store.close()
  rmSync(caseDirectory, { recursive: true, force: true })
})

describe('durable text action controller', () => {
  it.each(['resume-rejected', 'resume-mismatch', 'turn-rejected'])('does not permanently block a task after a definite %s', async mode => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready(mode)
    const receipt = await runDurableTextAction({
      store, lease, supervisor, compatibility, threadId: 'thread-1',
      actionId: 'action.controller.1', text: 'safe failure', expectedRevision: TASK.revision, now: 2_000,
    })
    expect(receipt.state).toBe('rejected')
    expect(store.getActionStatus(actionKey())?.state).toBe('rejected')
    expect(store.getTaskState({ hostId: TASK.hostId, taskId: TASK.taskId })?.writeState).not.toBe('blocked-indeterminate')
  })

  it('rejects an unavailable model without sending a turn or blocking future actions', async () => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready()
    const writes: string[] = []
    supervisor.onNotification(event => { if (event.method === 'fake/write-seen') writes.push(event.method) })
    const receipt = await runDurableTextAction({
      store, lease, supervisor, compatibility, threadId: 'thread-1',
      actionId: 'action.controller.1', text: 'safe failure', expectedRevision: TASK.revision, now: 2_000,
      settings: { model: 'unknown-model', effort: 'high', permission: 'ask' },
    })
    expect(receipt).toMatchObject({ state: 'rejected', rejection: { code: 'invalid-input' } })
    expect(writes).toEqual([])
    expect(store.getTaskState({ hostId: TASK.hostId, taskId: TASK.taskId })?.writeState).not.toBe('blocked-indeterminate')
  })
  it('persists accepted only after an exactly correlated app-server response', async () => {
    const selected = config()
    const store = trackedStore(createActionState(selected))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready()

    await expect(runDurableTextAction({
      store,
      lease,
      supervisor,
      compatibility,
      threadId: 'thread-1',
      actionId: 'action.controller.1',
      text: '  原文\n第二行 😀  ',
      expectedRevision: TASK.revision,
      now: 2_000,
    })).resolves.toEqual({
      actionId: 'action.controller.1',
      state: 'accepted',
      revision: 5,
    })

    store.close()
    const reopened = trackedStore(openExistingActionState(selected))
    expect(reopened.getActionStatus(actionKey())).toMatchObject({
      state: 'accepted',
      receipt: { state: 'accepted', revision: 5 },
      supervisorGeneration: compatibility.supervisorGeneration,
    })
  })

  it('reports the exact app-server turn only after accepted is durable', async () => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready()
    const observed: unknown[] = []

    const receipt = await runDurableTextAction({
      store,
      lease,
      supervisor,
      compatibility,
      threadId: 'thread-1',
      actionId: 'action.controller.1',
      text: 'ownership proof',
      onAcceptedTextTurn: proof => {
        observed.push({
          proof,
          durableState: store.getActionStatus(actionKey())?.state,
          frozen: Object.isFrozen(proof),
        })
      },
      expectedRevision: TASK.revision,
      now: 2_000,
    })

    expect(receipt).toMatchObject({ state: 'accepted', revision: 5 })
    expect(observed).toEqual([{
      proof: { taskId: 'thread-1', turnId: 'turn-1' },
      durableState: 'accepted',
      frozen: true,
    }])
  })

  it('does not report accepted ownership and reports a fixed code on runtime failure', async () => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready('turn-timeout')
    let calls = 0
    const runtimeFailures: string[] = []

    await expect(runDurableTextAction({
      store,
      lease,
      supervisor,
      compatibility,
      threadId: 'thread-1',
      actionId: 'action.controller.1',
      text: 'ambiguous',
      onAcceptedTextTurn: () => { calls += 1 },
      onRuntimeFailure: code => { runtimeFailures.push(code) },
      expectedRevision: TASK.revision,
      now: 2_000,
    })).resolves.toMatchObject({ state: 'queued', recoveryRequired: true })
    expect(calls).toBe(0)
    expect(runtimeFailures).toEqual(['app-server-failed'])
  })

  it('keeps the durable accepted receipt when its ownership observer throws', async () => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready()
    let calls = 0

    await expect(runDurableTextAction({
      store,
      lease,
      supervisor,
      compatibility,
      threadId: 'thread-1',
      actionId: 'action.controller.1',
      text: 'accepted despite observer failure',
      onAcceptedTextTurn: () => {
        calls += 1
        throw new Error('observer failed')
      },
      expectedRevision: TASK.revision,
      now: 2_000,
    })).resolves.toMatchObject({ state: 'accepted', revision: 5 })
    expect(calls).toBe(1)
    expect(store.getActionStatus(actionKey())).toMatchObject({ state: 'accepted' })
  })

  it('persists an ambiguous runtime failure as queued and blocks later task writes', async () => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready('turn-timeout')

    await expect(runDurableTextAction({
      store,
      lease,
      supervisor,
      compatibility,
      threadId: 'thread-1',
      actionId: 'action.controller.1',
      text: 'timeout text',
      expectedRevision: TASK.revision,
      now: 2_000,
    })).resolves.toEqual({
      actionId: 'action.controller.1',
      state: 'queued',
      recoveryRequired: true,
    })
    expect(store.getActionStatus(actionKey())).toMatchObject({ state: 'indeterminate' })

    const blocked = store.commitInboundReservation({
      ...AUTHORITY,
      inboundKeyId: CHANNEL.inboundKeyId,
      sequence: 3,
      ack: 0,
      actionId: 'action.controller.2',
      taskId: TASK.taskId,
      operation: 'turn.send',
      expectedRevision: TASK.revision,
      requestFingerprint: fingerprint('controller request two'),
      now: 2_001,
    })
    expect(blocked).toMatchObject({
      kind: 'terminal',
      receipt: { state: 'rejected', rejection: { code: 'capability-denied' } },
    })
  })

  it('rejects a consumed lease before any second app-server start', async () => {
    const store = trackedStore(createActionState(config()))
    const lease = reserve(store)
    const { supervisor, compatibility } = await ready()
    const writes: unknown[] = []
    supervisor.onNotification((notification: Notification) => {
      if (notification.method === 'fake/write-seen') writes.push(notification.params)
    })
    const input = {
      store,
      lease,
      supervisor,
      compatibility,
      threadId: 'thread-1',
      actionId: 'action.controller.1',
      text: 'one start only',
      expectedRevision: TASK.revision,
      now: 2_000,
    }

    await runDurableTextAction(input)
    await expect(runDurableTextAction(input)).rejects.toMatchObject({ code: 'invalid-capability' })
    expect(writes.filter((write) => (
      typeof write === 'object'
      && write !== null
      && (write as { method?: unknown }).method === 'turn/start'
    ))).toHaveLength(1)
  })
})
