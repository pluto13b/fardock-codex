import type { TaskSnapshot } from '@codex-plus/serve-client'
import { describe, expect, it } from 'vitest'

import { acceptedSendRevision, reconcileTaskPoll } from '../src/task-polling.ts'

function snapshot(status: TaskSnapshot['task']['status'], revision = 4, messageCount = 2): TaskSnapshot {
  return {
    authoritative: true,
    host: { hostId: 'host.poll', generation: 2, state: 'online' },
    revision,
    sequence: revision,
    cursor: `cursor-${revision}`,
    capabilities: {
      sendTurn: status === 'completed' || status === 'failed',
      steerTurn: false,
      interruptTurn: status === 'running',
      resolveApproval: false,
      answerQuestion: false,
    },
    ...(status === 'running' ? { activeTurnId: 'turn.poll' } : {}),
    task: {
      id: 'task.poll',
      workspaceId: 'workspace.poll',
      title: 'Poll fixture',
      status,
      updatedAt: '2026-09-03T00:00:00.000Z',
      revision,
      ...(status === 'failed' ? { completionReason: 'interrupted' as const } : {}),
    },
    workspace: {
      id: 'workspace.poll',
      name: 'Workspace',
      pathLabel: 'workspace',
      hostId: 'host.poll',
      connectionGeneration: 2,
      connection: 'online',
      capabilities: { startTask: false },
    },
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    permission: 'full-access',
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${index}`,
      kind: 'user' as const,
      createdAt: '2026-09-03T00:00:00.000Z',
      text: `message ${index}`,
    })),
    sources: [],
  }
}

describe('active task polling', () => {
  it('renders a newer live sequence even when the history window shrinks and rejects old text', () => {
    const current = snapshot('running', 5, 3)
    const next = { ...snapshot('running', 5, 2), sequence: 6 }
    expect(reconcileTaskPoll(current, next)).toMatchObject({ kind: 'accept', snapshot: { sequence: 6 } })
    expect(reconcileTaskPoll(next, current)).toEqual({ kind: 'retry' })
  })
  it('keeps waiting when a same-revision running projection loses optimistic messages', () => {
    expect(reconcileTaskPoll(snapshot('running', 5, 3), snapshot('running', 5, 2))).toEqual({ kind: 'retry' })
  })

  it('accepts a terminal same-revision snapshot and preserves accepted optimistic messages', () => {
    const current = snapshot('running', 5, 3)
    const result = reconcileTaskPoll(current, snapshot('failed', 5, 2))
    expect(result).toMatchObject({ kind: 'accept', snapshot: { task: { status: 'failed' } } })
    if (result.kind === 'accept') expect(result.snapshot.messages).toBe(current.messages)
  })

  it('still rejects a lower authority revision', () => {
    expect(reconcileTaskPoll(snapshot('running', 5, 3), snapshot('failed', 4, 2))).toEqual({ kind: 'retry' })
  })

  it('requires an accepted receipt before entering optimistic running state', () => {
    expect(acceptedSendRevision({ actionId: 'action-1', state: 'accepted', revision: 5 })).toBe(5)
    expect(() => acceptedSendRevision({ actionId: 'action-1', state: 'queued' })).toThrow('请勿重复提交')
    expect(() => acceptedSendRevision({
      actionId: 'action-1',
      state: 'rejected',
      rejection: { code: 'capability-denied', message: 'denied' },
    })).toThrow('denied')
  })
})
