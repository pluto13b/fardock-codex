import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  APP_SERVER_METHODS,
  AppServerSupervisor,
  type Notification,
  type RuntimeCompatibility,
} from '../src/index.ts'
import { establishRuntimeCompatibilityForTest } from '../src/runtime-binding.ts'
import { interruptBoundTurn, startBoundTask, startBoundTextTurn, steerBoundTextTurn } from '../src/turn-runtime.ts'

const fakeChild = fileURLToPath(new URL('./fixtures/fake-turn-app-server.mjs', import.meta.url))
const supervisors = new Set<AppServerSupervisor>()

function createSupervisor(mode = 'normal'): AppServerSupervisor {
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
  supervisors.add(supervisor)
  return supervisor
}

afterEach(async () => {
  await Promise.all([...supervisors].map((supervisor) => supervisor.close()))
  supervisors.clear()
})

async function ready(mode = 'normal') {
  const supervisor = createSupervisor(mode)
  await supervisor.start()
  const compatibility = await establishRuntimeCompatibilityForTest(supervisor)
  return { supervisor, compatibility }
}

function captureWrites(supervisor: AppServerSupervisor): unknown[] {
  const writes: unknown[] = []
  supervisor.onNotification((notification: Notification) => {
    if (notification.method === 'fake/write-seen') writes.push(notification.params)
  })
  return writes
}

describe('package-private bound text turn', () => {
  it('sends exact resume and original text-only turn params, then validates acceptance', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)
    const text = '  原文第一行\n第二行 😀  '

    await expect(startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1',
      actionId: 'action-1',
      text,
    })).resolves.toEqual({
      state: 'accepted-by-app-server',
      threadId: 'thread-1',
      actionId: 'action-1',
      turnId: 'turn-1',
    })

    expect(writes).toEqual([
      { method: 'thread/loaded/list', params: { limit: 256 } },
      { method: 'thread/resume', params: { threadId: 'thread-1', excludeTurns: true } },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-1',
          clientUserMessageId: 'action-1',
          input: [{ type: 'text', text, text_elements: [] }],
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          approvalPolicy: 'on-request',
          sandboxPolicy: {
            type: 'workspaceWrite', writableRoots: [], networkAccess: false,
            excludeTmpdirEnvVar: false, excludeSlashTmp: false,
          },
        },
      },
    ])
    await expect(supervisor.request('turn/start', {})).rejects.toMatchObject({
      code: 'method-not-allowed',
    })
  })

  it('sends no turn/start when the resumed thread id mismatches', async () => {
    const { supervisor, compatibility } = await ready('resume-mismatch')
    const writes = captureWrites(supervisor)

    await expect(startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-1', text: 'hello',
    })).rejects.toMatchObject({ code: 'response-invalid' })
    expect(writes).toEqual([
      { method: 'thread/loaded/list', params: { limit: 256 } },
      { method: 'thread/resume', params: { threadId: 'thread-1', excludeTurns: true } },
    ])
  })

  it('skips redundant resume when the owned app-server reports the thread loaded', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)
    await startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-1', text: 'first',
    })
    await startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-2', text: 'second',
    })

    const methodIs = (value: unknown, method: string) => (
      typeof value === 'object' && value !== null
      && (value as { method?: unknown }).method === method
    )
    expect(writes.filter(write => methodIs(write, 'thread/loaded/list'))).toHaveLength(2)
    expect(writes.filter(write => methodIs(write, 'thread/resume'))).toHaveLength(1)
    expect(writes.filter(write => methodIs(write, 'turn/start'))).toHaveLength(2)
  })

  it('accepts the official empty initial turn items view', async () => {
    const { supervisor, compatibility } = await ready('empty-turn-items')

    await expect(startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-1', text: '原文',
    })).resolves.toMatchObject({
      state: 'accepted-by-app-server',
      threadId: 'thread-1',
      actionId: 'action-1',
      turnId: 'turn-1',
    })
  })

  it('enforces authenticated read-only settings on the official turn', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)

    await expect(startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1',
      actionId: 'action-read-only',
      text: '只读检查',
      settings: { model: 'gpt-5.6-terra', effort: 'high', permission: 'read-only' },
    })).resolves.toMatchObject({ state: 'accepted-by-app-server' })

    expect(writes.at(-1)).toEqual({
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'action-read-only',
        input: [{ type: 'text', text: '只读检查', text_elements: [] }],
        model: 'gpt-5.6-terra',
        effort: 'high',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
    })
  })

  it('materializes bounded image and file attachments into official app-server inputs', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)
    const attachmentDirectory = resolve(import.meta.dirname, '..', '..', '..', '.tmp', `turn-attachments-${randomUUID()}`)
    mkdirSync(attachmentDirectory, { recursive: true })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const markdown = Buffer.from('# attachment\n', 'utf8')
    try {
      await expect(startBoundTextTurn(supervisor, compatibility, {
        threadId: 'thread-1',
        actionId: 'action-attachments',
        text: '检查附件',
        attachmentDirectory,
        attachments: [
          {
            kind: 'localImage', attachmentId: 'image-1', name: 'shot.png', mediaType: 'image/png',
            byteLength: png.byteLength, contentBase64Url: png.toString('base64url'),
          },
          {
            kind: 'file', attachmentId: 'file-1', name: 'notes.md', mediaType: 'text/markdown',
            byteLength: markdown.byteLength, contentBase64Url: markdown.toString('base64url'),
          },
        ],
      })).resolves.toMatchObject({ state: 'accepted-by-app-server' })

      expect(writes.at(-1)).toEqual({
        method: 'turn/start',
        params: expect.objectContaining({
          threadId: 'thread-1',
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          input: [
            { type: 'text', text: '检查附件', text_elements: [] },
            { type: 'localImage', path: expect.stringMatching(/\.png$/u) },
            {
              type: 'text',
              text: expect.stringMatching(/^Attached file notes\.md: .*\.md$/u),
              text_elements: [{
                byteRange: { start: 24, end: expect.any(Number) },
                placeholder: 'notes.md',
              }],
            },
          ],
        }),
      })
      const files = readdirSync(attachmentDirectory)
      expect(files).toHaveLength(2)
      expect(files.some(file => readFileSync(resolve(attachmentDirectory, file)).equals(png))).toBe(true)
      expect(files.some(file => readFileSync(resolve(attachmentDirectory, file)).equals(markdown))).toBe(true)
    } finally {
      rmSync(attachmentDirectory, { recursive: true, force: true })
    }
  })

  it('creates a new full-access thread before starting its first turn', async () => {
    const { supervisor, compatibility } = await ready('empty-turn-items')
    const writes = captureWrites(supervisor)
    await expect(startBoundTask(supervisor, compatibility, {
      workspacePath: 'D:\\workspace',
      actionId: 'action-new-task',
      text: '新任务原文',
      settings: { model: 'gpt-5.6-sol', effort: 'xhigh', permission: 'full-access' },
      allowFullAccess: true,
    })).resolves.toMatchObject({ threadId: 'thread-new-1', turnId: 'turn-1' })

    expect(writes).toContainEqual({
      method: 'thread/start',
      params: {
        cwd: 'D:\\workspace', model: 'gpt-5.6-sol', serviceName: 'codex_plus',
        approvalPolicy: 'never', sandbox: 'danger-full-access',
      },
    })
    expect(writes).toContainEqual({
      method: 'turn/start',
      params: expect.objectContaining({
        threadId: 'thread-new-1', clientUserMessageId: 'action-new-task',
        model: 'gpt-5.6-sol', effort: 'xhigh', approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }),
    })
  })

  it('steers the active accepted turn with the exact queued text', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)
    await startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-1', text: '开始任务',
    })

    await expect(steerBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-steer', text: '调整方向原文',
    })).resolves.toMatchObject({ turnId: 'turn-1', actionId: 'action-steer' })

    expect(writes.at(-1)).toEqual({
      method: 'turn/steer',
      params: {
        threadId: 'thread-1',
        expectedTurnId: 'turn-1',
        clientUserMessageId: 'action-steer',
        input: [{ type: 'text', text: '调整方向原文', text_elements: [] }],
      },
    })
  })

  it('interrupts only the exact active turn owned by this supervisor', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)
    await startBoundTextTurn(supervisor, compatibility, {
      threadId: 'thread-1', actionId: 'action-1', text: '开始任务',
    })
    await expect(interruptBoundTurn(supervisor, compatibility, {
      threadId: 'thread-1', turnId: 'turn-1',
    })).resolves.toBeUndefined()
    expect(writes.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    await expect(interruptBoundTurn(supervisor, compatibility, {
      threadId: 'thread-1', turnId: 'turn-1',
    })).rejects.toMatchObject({ code: 'runtime-not-current' })
  })

  it.each(['client-mismatch', 'text-mismatch'])(
    'rejects an uncorrelated successful turn response: %s',
    async (mode) => {
      const { supervisor, compatibility } = await ready(mode)
      await expect(startBoundTextTurn(supervisor, compatibility, {
        threadId: 'thread-1', actionId: 'action-1', text: '原文',
      })).rejects.toMatchObject({ code: 'response-invalid' })
    },
  )

  it.each(['turn-timeout', 'turn-child-exit'])(
    'maps ambiguous child failure to one fixed non-acceptance: %s',
    async (mode) => {
      const { supervisor, compatibility } = await ready(mode)
      await expect(startBoundTextTurn(supervisor, compatibility, {
        threadId: 'thread-1', actionId: 'action-1', text: '原文',
      })).rejects.toMatchObject({ code: 'app-server-failed' })
    },
  )

  it('rejects forged and stale runtime bindings before another write', async () => {
    const { supervisor, compatibility } = await ready()
    const writes = captureWrites(supervisor)
    const forged = { ...compatibility } as RuntimeCompatibility
    const request = { threadId: 'thread-1', actionId: 'action-1', text: 'hello' }

    await expect(startBoundTextTurn(supervisor, forged, request)).rejects.toMatchObject({
      code: 'runtime-not-current',
    })
    await supervisor.close()
    await expect(startBoundTextTurn(supervisor, compatibility, request)).rejects.toMatchObject({
      code: 'runtime-not-current',
    })
    expect(writes).toEqual([])
  })
})
