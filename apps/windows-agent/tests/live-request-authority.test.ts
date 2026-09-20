import { describe, expect, it } from 'vitest'

import { createLiveRequestAuthority } from '../src/live-request-authority.ts'

const NOW = 1_800_000_000_000
const DEVICE_AUTHORITY = {
  hostId: 'host-1',
  connectionGeneration: 3,
  clientDeviceId: 'client-1',
  authorizationId: 'authorization-1',
} as const

function resolution(message: any, overrides: Record<string, unknown> = {}) {
  return {
    type: 'approval' as const,
    actionId: 'resolve-1',
    decision: 'approve-once' as const,
    taskId: message.taskId,
    turnId: message.turnId,
    hostId: message.hostId,
    connectionGeneration: message.connectionGeneration,
    requestId: message.requestId,
    requestNonce: message.requestNonce,
    issuedAt: message.issuedAt,
    expiresAt: message.expiresAt,
    expected: {
      hostId: message.hostId,
      connectionGeneration: message.connectionGeneration,
      revision: 4,
    },
    ...overrides,
  }
}

describe('live request authority', () => {
  it('binds a command approval once and never upgrades it to session-wide', async () => {
    const authority = createLiveRequestAuthority({
      isTaskOwned: (taskId, turnId) => taskId === 'task-1' && turnId === 'turn-1',
      now: () => NOW,
      ttlMs: 5_000,
    })
    const pending = authority.handleServerRequest({
      id: 'rpc-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'task-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        startedAtMs: NOW,
        command: 'pnpm test',
        reason: '运行当前项目测试',
      },
    })
    const messages = authority.messagesForTask({
      taskId: 'task-1',
      activeTurnId: 'turn-1',
      ...DEVICE_AUTHORITY,
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'approval',
      command: 'pnpm test',
      state: 'pending',
    })
    const message = messages[0] as any
    expect(authority.resolve(resolution(message, { actionId: 'resolve-other-device' }), {
      ...DEVICE_AUTHORITY,
      clientDeviceId: 'client-2',
    })).toMatchObject({ state: 'rejected', rejection: { code: 'request-owner-mismatch' } })
    expect(authority.resolve(resolution(message), {
      ...DEVICE_AUTHORITY,
    })).toEqual({ actionId: 'resolve-1', state: 'accepted' })
    await expect(pending).resolves.toEqual({ result: { decision: 'accept' } })
    expect(authority.resolve(resolution(message, { actionId: 'resolve-2' }), {
      ...DEVICE_AUTHORITY,
    })).toMatchObject({ state: 'rejected', rejection: { code: 'request-already-resolved' } })
  })

  it('answers only declared non-secret questions and rejects an invalid option without consuming', async () => {
    const authority = createLiveRequestAuthority({
      isTaskOwned: () => true,
      now: () => NOW,
      ttlMs: 5_000,
    })
    const pending = authority.handleServerRequest({
      id: 'rpc-question',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'task-1',
        turnId: 'turn-1',
        itemId: 'item-question',
        startedAtMs: NOW,
        isBlocking: true,
        autoResolutionMs: null,
        questions: [{
          id: 'color',
          header: '颜色',
          question: '选择颜色',
          isOther: false,
          isSecret: false,
          options: [
            { label: '蓝色', description: '使用蓝色' },
            { label: '绿色', description: '使用绿色' },
          ],
        }],
      },
    })
    const message = authority.messagesForTask({
      taskId: 'task-1', activeTurnId: 'turn-1', ...DEVICE_AUTHORITY,
    })[0] as any
    const base = resolution(message, {
      type: 'question',
      actionId: 'answer-1',
      answers: [{ questionId: 'color', values: ['红色'] }],
    })
    expect(authority.resolve(base as any, {
      ...DEVICE_AUTHORITY,
    })).toMatchObject({ state: 'rejected', rejection: { code: 'invalid-input' } })
    expect(authority.resolve({
      ...base,
      actionId: 'answer-2',
      answers: [{ questionId: 'color', values: ['蓝色'] }],
    } as any, {
      ...DEVICE_AUTHORITY,
    })).toEqual({ actionId: 'answer-2', state: 'accepted' })
    await expect(pending).resolves.toEqual({
      result: { answers: { color: { answers: ['蓝色'] } } },
    })

    await expect(authority.handleServerRequest({
      id: 'rpc-secret',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'task-1', turnId: 'turn-1', itemId: 'secret', startedAtMs: NOW,
        isBlocking: true, autoResolutionMs: null,
        questions: [{
          id: 'password', header: '密码', question: '输入密码',
          isOther: true, isSecret: true, options: null,
        }],
      },
    })).resolves.toEqual({
      error: { code: -32601, message: 'Server request is not supported.' },
    })
  })

  it('denies pending requests when the owned turn is interrupted', async () => {
    const authority = createLiveRequestAuthority({ isTaskOwned: () => true, now: () => NOW, ttlMs: 5_000 })
    const pending = authority.handleServerRequest({
      id: 'rpc-file',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'task-1', turnId: 'turn-1', itemId: 'item-file', startedAtMs: NOW,
      },
    })
    authority.cancelTask('task-1', 'turn-1')
    await expect(pending).resolves.toEqual({
      error: { code: -32601, message: 'Server request is not supported.' },
    })
    expect(authority.messagesForTask({
      taskId: 'task-1', activeTurnId: 'turn-1', ...DEVICE_AUTHORITY,
    })).toEqual([])
  })

  it('grants only the exact requested permission profile for the current turn', async () => {
    const authority = createLiveRequestAuthority({ isTaskOwned: () => true, now: () => NOW, ttlMs: 5_000 })
    const pending = authority.handleServerRequest({
      id: 'rpc-permission',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'task-1', turnId: 'turn-1', itemId: 'item-permission', startedAtMs: NOW,
        environmentId: null, cwd: 'D:\\workspace', reason: '需要网络',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    })
    const message = authority.messagesForTask({
      taskId: 'task-1', activeTurnId: 'turn-1', ...DEVICE_AUTHORITY,
    })[0] as any
    expect(authority.resolve(resolution(message), {
      ...DEVICE_AUTHORITY,
    })).toEqual({ actionId: 'resolve-1', state: 'accepted' })
    await expect(pending).resolves.toEqual({
      result: { permissions: { network: { enabled: true } }, scope: 'turn' },
    })
  })
})
