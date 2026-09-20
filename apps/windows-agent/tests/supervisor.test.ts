import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  APP_SERVER_METHODS,
  HANDLED_SERVER_REQUEST_METHODS,
  AppServerSupervisor,
  AppServerSupervisorError,
  type AppServerMethod,
  type ServerRequestDecision,
  type SupervisorConfig,
  type SupervisorLogEvent,
} from '../src/index.ts'

const fakeChild = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url))
const supervisors = new Set<AppServerSupervisor>()

function createSupervisor(
  mode = 'normal',
  overrides: Partial<SupervisorConfig> = {},
): AppServerSupervisor {
  const supervisor = new AppServerSupervisor({
    command: { executable: process.execPath, args: [fakeChild, mode] },
    clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
    allowedMethods: APP_SERVER_METHODS,
    limits: {
      maxLineBytes: 16 * 1024,
      maxStderrBytes: 16 * 1024,
      maxPendingRequests: 16,
      maxPendingServerRequests: 8,
      maxNotificationSubscribers: 8,
      maxBufferedNotifications: 16,
      maxWriteQueueBytes: 32 * 1024,
      maxWriteQueueFrames: 16,
      initializationTimeoutMs: 2_000,
      requestTimeoutMs: 500,
      serverRequestTimeoutMs: 100,
      shutdownGraceMs: 100,
    },
    ...overrides,
  })
  supervisors.add(supervisor)
  return supervisor
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test state.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function collectNotifications(supervisor: AppServerSupervisor): unknown[] {
  const received: unknown[] = []
  supervisor.onNotification((notification) => received.push(notification))
  return received
}

afterEach(async () => {
  await Promise.all([...supervisors].map((supervisor) => supervisor.close()))
  supervisors.clear()
})

describe('AppServerSupervisor handshake and requests', () => {
  it('launches one owned child and completes initialize before initialized', async () => {
    const supervisor = createSupervisor()
    const result = await supervisor.start()
    const notifications = collectNotifications(supervisor)

    await waitFor(() => notifications.length > 0)

    expect(result).toEqual({
      userAgent: 'codex_cli_rs/0.151.0 fake-app-server',
      platformFamily: 'windows',
      platformOs: 'windows',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result).not.toHaveProperty('codexHome')
    expect(notifications).toContainEqual(expect.objectContaining({
      method: 'fake/handshake',
      params: {
        order: ['initialize', 'initialized'],
        initializeParams: {
          clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            mcpServerOpenaiFormElicitation: false,
            optOutNotificationMethods: [],
          },
        },
      },
    }))
    expect(supervisor.state).toBe('ready')
    expect(supervisor.ownsLiveChild).toBe(true)
  })

  it('correlates concurrent responses even when the child answers out of order', async () => {
    const supervisor = createSupervisor('out-of-order')
    await supervisor.start()

    const slow = supervisor.request('thread/list', { cursor: 'first' })
    const fast = supervisor.request('thread/read', { threadId: 'second' })

    await expect(fast).resolves.toMatchObject({
      method: 'thread/read',
      params: { threadId: 'second' },
    })
    await expect(slow).resolves.toMatchObject({
      method: 'thread/list',
      params: { cursor: 'first' },
    })
  })

  it('preserves exact Unicode, newlines and leading/trailing whitespace', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()
    const params = { input: [{ type: 'text', text: '  中文\n```ts\nconst x = "🚀"\n```\t  ' }] }

    const result = await supervisor.request<{ params: unknown }>('thread/read', params)

    expect(result.params).toEqual(params)
  })

  it('dispatches thread/turns/list through the generic read-only request path', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()
    const params = { threadId: 'thread-1', cursor: null, limit: 100 }

    await expect(supervisor.request('thread/turns/list', params)).resolves.toMatchObject({
      method: 'thread/turns/list',
      params,
    })
  })

  it('buffers early notifications then delivers later notifications to subscribers', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()
    const received = collectNotifications(supervisor)

    await supervisor.request('thread/read', { threadId: 'thread-1' })

    expect(received).toContainEqual(expect.objectContaining({
      method: 'fake/handshake',
      params: expect.objectContaining({ order: ['initialize', 'initialized'] }),
    }))
    expect(received).toContainEqual({ method: 'thread/updated', params: { source: 'fake' } })
  })

  it('buffers a notification delivered in the same chunk after initialize response', async () => {
    const supervisor = createSupervisor('post-response-notification-same-chunk')
    await supervisor.start()
    const received = collectNotifications(supervisor)

    await waitFor(() => received.some(notification => (
      notification as { readonly method?: unknown }
    ).method === 'account/updated'))
    expect(received).toContainEqual({ method: 'account/updated', params: {} })
  })

  it('enforces the construction-time method allowlist', async () => {
    const supervisor = createSupervisor('normal', { allowedMethods: ['thread/list'] })
    await supervisor.start()

    await expect(supervisor.request('turn/start', {})).rejects.toMatchObject({
      code: 'method-not-allowed',
    })
    await expect(supervisor.request('thread/list', {})).resolves.toMatchObject({
      method: 'thread/list',
    })
  })

  it('keeps every mutating method undispatchable even when construction allowed it', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()

    for (const method of [
      'thread/start',
      'thread/resume',
      'turn/start',
      'turn/steer',
      'turn/interrupt',
    ] as const) {
      await expect(supervisor.request(method, {})).rejects.toMatchObject({
        code: 'method-not-allowed',
      })
    }
  })

  it('rejects requests before ready and after close', async () => {
    const supervisor = createSupervisor()
    await expect(supervisor.request('thread/list', {})).rejects.toMatchObject({
      code: 'invalid-state',
    })
    await supervisor.start()
    await supervisor.close()
    expect(supervisor.ownsLiveChild).toBe(false)
    await expect(supervisor.request('thread/list', {})).rejects.toMatchObject({
      code: 'invalid-state',
    })
  })

  it('rejects a second start without launching another generation', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()

    await expect(supervisor.start()).rejects.toMatchObject({ code: 'invalid-state' })
    expect(supervisor.state).toBe('ready')
    expect(supervisor.ownsLiveChild).toBe(true)
  })

  it('enforces the pending-request ceiling', async () => {
    const supervisor = createSupervisor('timeout', {
      limits: {
        maxLineBytes: 4096,
        maxStderrBytes: 4096,
        maxPendingRequests: 2,
        maxPendingServerRequests: 4,
        maxNotificationSubscribers: 4,
        maxBufferedNotifications: 8,
        maxWriteQueueBytes: 4096,
        maxWriteQueueFrames: 8,
        initializationTimeoutMs: 1000,
        requestTimeoutMs: 200,
        serverRequestTimeoutMs: 100,
        shutdownGraceMs: 100,
      },
    })
    await supervisor.start()
    const first = supervisor.request('thread/list', { cursor: 'one' }).catch(() => undefined)
    const second = supervisor.request('thread/list', { cursor: 'two' }).catch(() => undefined)

    await expect(supervisor.request('thread/list', { cursor: 'three' })).rejects.toMatchObject({
      code: 'capacity-exceeded',
    })
    await Promise.all([first, second])
  })
})

describe('AppServerSupervisor server requests', () => {
  it('uses the configured handler only for a named server request', async () => {
    let calls = 0
    const supervisor = createSupervisor('server-known', {
      onServerRequest() {
        calls += 1
        return { result: { decision: 'accept' } }
      },
    })
    const notifications = collectNotifications(supervisor)

    await supervisor.start()
    await waitFor(() => notifications.some((item: any) => item.method === 'fake/server-answer'))

    expect(calls).toBe(1)
    expect(notifications).toContainEqual({
      method: 'fake/server-answer',
      params: {
        id: 'server-approval-1',
        result: { decision: 'accept' },
      },
    })
  })

  it('rejects unknown server methods without invoking a handler', async () => {
    let calls = 0
    const supervisor = createSupervisor('server-unknown', {
      onServerRequest() {
        calls += 1
        return { result: { approved: true } }
      },
    })
    const notifications = collectNotifications(supervisor)

    await supervisor.start()
    await waitFor(() => notifications.some((item: any) => item.method === 'fake/server-answer'))

    expect(calls).toBe(0)
    expect(notifications).toContainEqual({
      method: 'fake/server-answer',
      params: {
        id: 71,
        error: { code: -32601, message: 'Server request is not supported.' },
      },
    })
  })

  it('does not inspect a stateful handler result getter', async () => {
    let getterReads = 0
    let calls = 0
    const supervisor = createSupervisor('server-known', {
      onServerRequest() {
        calls += 1
        const decision = {}
        Object.defineProperty(decision, 'result', {
          enumerable: true,
          get() {
            getterReads += 1
            if (getterReads <= 2) return { decision: 'decline' }
            throw new Error('stateful getter bait')
          },
        })
        return decision as ServerRequestDecision
      },
    })
    const notifications = collectNotifications(supervisor)

    await supervisor.start()
    await waitFor(() => notifications.some((item: any) => item.method === 'fake/server-answer'))
    await new Promise((resolve) => setTimeout(resolve, 75))

    const answers = notifications.filter(
      (item: any) =>
        item.method === 'fake/server-answer' && item.params?.id === 'server-approval-1',
    )
    expect(answers).toEqual([
      {
        method: 'fake/server-answer',
        params: {
          id: 'server-approval-1',
          error: { code: -32601, message: 'Server request is not supported.' },
        },
      },
    ])
    expect(calls).toBe(1)
    expect(getterReads).toBe(0)
    expect(supervisor.state).toBe('ready')
  })

  it('fails closed when a pending approval id is repeated with another method', async () => {
    let handlerCalls = 0
    const received: unknown[] = []
    const supervisor = createSupervisor('server-duplicate-mixed', {
      async onServerRequest() {
        handlerCalls += 1
        await new Promise((resolve) => setTimeout(resolve, 50))
        return { result: { decision: 'accept' } }
      },
    })
    supervisor.onNotification((notification) => received.push(notification))

    await supervisor.start()
    await waitFor(() => supervisor.state === 'failed')
    await new Promise((resolve) => setTimeout(resolve, 75))

    expect(handlerCalls).toBe(1)
    expect(received).not.toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ result: { decision: 'accept' } }),
    }))
    expect(supervisor.ownsLiveChild).toBe(false)
  })

  it('allows a completed server-request id to be reused sequentially and rejects both', async () => {
    const supervisor = createSupervisor('server-sequential-reuse')
    const received = collectNotifications(supervisor)

    await supervisor.start()
    await waitFor(() => received.filter((item: any) => item.method === 'fake/server-answer').length === 2)

    const answers = received.filter((item: any) => item.method === 'fake/server-answer') as any[]
    expect(answers).toHaveLength(2)
    for (const answer of answers) {
      expect(answer.params).toEqual({
        id: 'server-reused-1',
        error: { code: -32601, message: 'Server request is not supported.' },
      })
    }
    expect(supervisor.state).toBe('ready')
  })

  it('releases in-flight server-request capacity across more than 32 sequential requests', async () => {
    const supervisor = createSupervisor('server-many-sequential')
    const received = collectNotifications(supervisor)

    await supervisor.start()
    await waitFor(
      () => received.filter((item: any) => item.method === 'fake/server-answer').length === 40,
      4_000,
    )

    const answers = received.filter((item: any) => item.method === 'fake/server-answer') as any[]
    expect(answers).toHaveLength(40)
    expect(answers.every((answer) => answer.params?.error?.code === -32601)).toBe(true)
    expect(supervisor.state).toBe('ready')
  })
})

describe('AppServerSupervisor fail-closed behavior', () => {
  it.each(['malformed', 'oversized', 'binary', 'primitive', 'bom-jsonl', 'stderr-overflow']) (
    'fails closed on %s child output',
    async (mode) => {
      const supervisor = createSupervisor(mode, {
        limits: {
          maxLineBytes: 256,
          maxStderrBytes: mode === 'stderr-overflow' ? 256 : 4096,
          maxPendingRequests: 8,
          maxPendingServerRequests: 4,
          maxNotificationSubscribers: 4,
          maxBufferedNotifications: 8,
          maxWriteQueueBytes: 4096,
          maxWriteQueueFrames: 8,
          initializationTimeoutMs: 1000,
          requestTimeoutMs: 300,
          serverRequestTimeoutMs: 100,
          shutdownGraceMs: 100,
        },
      })
      try {
        await supervisor.start()
      } catch {
        // Failure can race the final initialized write.
      }
      await waitFor(() => supervisor.state === 'failed')
      await waitFor(() => !supervisor.ownsLiveChild)
    },
  )

  it.each(['duplicate-response', 'unknown-response']) (
    'fails closed on %s',
    async (mode) => {
      const supervisor = createSupervisor(mode)
      if (mode === 'duplicate-response') {
        await supervisor.start()
        await supervisor.request('thread/list', {})
      } else {
        try {
          await supervisor.start()
        } catch {
          // The unsolicited response may race initialization completion.
        }
      }
      await waitFor(() => supervisor.state === 'failed')
      await waitFor(() => !supervisor.ownsLiveChild)
    },
  )

  it('fails closed on a malformed RPC error response', async () => {
    const supervisor = createSupervisor('malformed-error')
    await supervisor.start()
    await expect(supervisor.request('thread/list', {})).rejects.toBeInstanceOf(
      AppServerSupervisorError,
    )
    await waitFor(() => supervisor.state === 'failed')
    await waitFor(() => !supervisor.ownsLiveChild)
  })

  it('times out an unanswered request, rejects it and terminates the owned child', async () => {
    const supervisor = createSupervisor('timeout', {
      limits: {
        maxLineBytes: 4096,
        maxStderrBytes: 4096,
        maxPendingRequests: 8,
        maxPendingServerRequests: 4,
        maxNotificationSubscribers: 4,
        maxBufferedNotifications: 8,
        maxWriteQueueBytes: 4096,
        maxWriteQueueFrames: 8,
        initializationTimeoutMs: 1000,
        requestTimeoutMs: 30,
        serverRequestTimeoutMs: 100,
        shutdownGraceMs: 100,
      },
    })
    await supervisor.start()

    await expect(supervisor.request('thread/list', {})).rejects.toMatchObject({
      code: 'request-timeout',
    })
    await waitFor(() => supervisor.state === 'failed')
    await waitFor(() => !supervisor.ownsLiveChild)
  })

  it.each(['early-exit', 'early-exit-ready']) ('fails closed on %s', async (mode) => {
    const supervisor = createSupervisor(mode)
    if (mode === 'early-exit') {
      await expect(supervisor.start()).rejects.toBeInstanceOf(AppServerSupervisorError)
    } else {
      try {
        await supervisor.start()
      } catch {
        // Exit is intentionally concurrent with initialization completion.
      }
    }
    await waitFor(() => supervisor.state === 'failed')
    await waitFor(() => !supervisor.ownsLiveChild)
  })

  it('fails closed on a notification sent before initialization is acknowledged', async () => {
    const supervisor = createSupervisor('preinit-notification')

    await expect(supervisor.start()).rejects.toBeInstanceOf(AppServerSupervisorError)
    await waitFor(() => supervisor.state === 'failed')
    await waitFor(() => !supervisor.ownsLiveChild)
  })

  it('fails closed when the explicitly configured executable cannot spawn', async () => {
    const supervisor = createSupervisor('normal', {
      command: { executable: `${fakeChild}.missing`, args: [] },
    })

    await expect(supervisor.start()).rejects.toBeInstanceOf(AppServerSupervisorError)
    await waitFor(() => supervisor.state === 'failed')
    await waitFor(() => !supervisor.ownsLiveChild)
  })

  it('rejects an in-flight request during shutdown and kills only its owned child after grace', async () => {
    const supervisor = createSupervisor('shutdown-ignore', {
      limits: {
        maxLineBytes: 4096,
        maxStderrBytes: 4096,
        maxPendingRequests: 8,
        maxPendingServerRequests: 4,
        maxNotificationSubscribers: 4,
        maxBufferedNotifications: 8,
        maxWriteQueueBytes: 4096,
        maxWriteQueueFrames: 8,
        initializationTimeoutMs: 1000,
        requestTimeoutMs: 500,
        serverRequestTimeoutMs: 100,
        shutdownGraceMs: 30,
      },
    })
    await supervisor.start()
    const request = supervisor.request('thread/list', {})
    const closing = supervisor.close()

    await expect(request).rejects.toMatchObject({ code: 'closed' })
    await closing
    expect(supervisor.state).toBe('closed')
    expect(supervisor.ownsLiveChild).toBe(false)
  })
})

describe('AppServerSupervisor hard limits and safe logging', () => {
  it('rejects zero, non-finite and over-ceiling limits at construction', () => {
    for (const limits of [
      { requestTimeoutMs: 0 },
      { maxPendingRequests: Number.POSITIVE_INFINITY },
      { maxLineBytes: 1024 * 1024 + 1 },
      { shutdownGraceMs: -1 },
    ]) {
      expect(() => createSupervisor('normal', { limits })).toThrowError(AppServerSupervisorError)
    }
  })

  it('rejects unknown methods in the runtime allowlist at construction', () => {
    expect(() => createSupervisor('normal', {
      allowedMethods: ['account/login' as AppServerMethod],
    })).toThrowError(AppServerSupervisorError)
  })

  it('keeps both exported method tables immutable at runtime', () => {
    expect(() => (APP_SERVER_METHODS as unknown as string[]).push('account/login')).toThrow()
    expect(() => (
      HANDLED_SERVER_REQUEST_METHODS as unknown as string[]
    ).push('account/chatgptAuthTokens/refresh')).toThrow()
    expect(APP_SERVER_METHODS).not.toContain('account/login')
    expect(HANDLED_SERVER_REQUEST_METHODS).not.toContain('account/chatgptAuthTokens/refresh')
  })

  it('refuses to impersonate another official app-server client identity', () => {
    expect(() => createSupervisor('normal', {
      clientInfo: { name: 'codex_vscode', title: 'Codex Plus', version: '0.0.0' },
    })).toThrowError(AppServerSupervisorError)
  })

  it('snapshots exactly three plain clientInfo data properties without invoking accessors', () => {
    expect(() => createSupervisor('normal', {
      clientInfo: {
        name: 'codex_plus',
        title: 'Codex Plus',
        version: '0.0.0',
        extra: 'not-allowed',
      } as any,
    })).toThrowError(AppServerSupervisorError)

    let getterReads = 0
    const accessorClientInfo = {
      title: 'Codex Plus',
      version: '0.0.0',
    }
    Object.defineProperty(accessorClientInfo, 'name', {
      enumerable: true,
      get() {
        getterReads += 1
        return getterReads === 1 ? 'codex_plus' : 'codex_vscode'
      },
    })
    expect(() => createSupervisor('normal', {
      clientInfo: accessorClientInfo as any,
    })).toThrowError(AppServerSupervisorError)
    expect(getterReads).toBe(0)

    const proxyClientInfo = new Proxy(
      { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
      {
        get(target, key, receiver) {
          getterReads += 1
          return Reflect.get(target, key, receiver)
        },
      },
    )
    expect(() => createSupervisor('normal', {
      clientInfo: proxyClientInfo,
    })).toThrowError(AppServerSupervisorError)
    expect(getterReads).toBe(0)
  })

  it('rejects command and argument accessors without evaluating them', () => {
    let getterReads = 0
    const command = {
      args: [fakeChild, 'normal'],
    }
    Object.defineProperty(command, 'executable', {
      enumerable: true,
      get() {
        getterReads += 1
        return process.execPath
      },
    })
    expect(() => createSupervisor('normal', { command: command as any })).toThrowError(
      AppServerSupervisorError,
    )
    expect(getterReads).toBe(0)

    const args = [fakeChild, 'normal']
    Object.defineProperty(args, '1', {
      enumerable: true,
      get() {
        getterReads += 1
        return 'normal'
      },
    })
    expect(() => createSupervisor('normal', {
      command: { executable: process.execPath, args },
    })).toThrowError(AppServerSupervisorError)
    expect(getterReads).toBe(0)
  })

  it('does not let a reentrant lifecycle logger close before the owned child is registered', async () => {
    let supervisor!: AppServerSupervisor
    let closeFromLogger: Promise<void> | undefined
    supervisor = createSupervisor('normal', {
      logger: (event) => {
        if (event.event === 'lifecycle' && event.state === 'starting') {
          closeFromLogger = supervisor.close()
        }
      },
    })

    await expect(supervisor.start()).rejects.toBeInstanceOf(AppServerSupervisorError)
    await closeFromLogger
    await supervisor.close()
    expect(supervisor.state).toBe('closed')
    expect(supervisor.ownsLiveChild).toBe(false)
  })

  it('enforces notification buffer and subscriber ceilings', async () => {
    const flooded = createSupervisor('notification-flood', {
      limits: {
        maxLineBytes: 4096,
        maxStderrBytes: 4096,
        maxPendingRequests: 8,
        maxPendingServerRequests: 4,
        maxNotificationSubscribers: 2,
        maxBufferedNotifications: 2,
        maxWriteQueueBytes: 4096,
        maxWriteQueueFrames: 8,
        initializationTimeoutMs: 1000,
        requestTimeoutMs: 300,
        serverRequestTimeoutMs: 100,
        shutdownGraceMs: 100,
      },
    })
    try {
      await flooded.start()
    } catch {
      // Notification overflow can race readiness.
    }
    await waitFor(() => flooded.state === 'failed')

    const supervisor = createSupervisor('normal', {
      limits: {
        maxLineBytes: 4096,
        maxStderrBytes: 4096,
        maxPendingRequests: 8,
        maxPendingServerRequests: 4,
        maxNotificationSubscribers: 1,
        maxBufferedNotifications: 8,
        maxWriteQueueBytes: 4096,
        maxWriteQueueFrames: 8,
        initializationTimeoutMs: 1000,
        requestTimeoutMs: 300,
        serverRequestTimeoutMs: 100,
        shutdownGraceMs: 100,
      },
    })
    supervisor.onNotification(() => undefined)
    expect(() => supervisor.onNotification(() => undefined)).toThrowError(AppServerSupervisorError)
  })

  it('emits only allowlisted metadata and never logs frames, stderr, prompts, tokens or paths', async () => {
    const events: SupervisorLogEvent[] = []
    const supervisor = createSupervisor('stderr-bait', {
      command: {
        executable: process.execPath,
        args: [fakeChild, 'stderr-bait'],
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      },
      logger(event) {
        events.push(event)
      },
    })
    await supervisor.start()
    await supervisor.request('thread/read', {
      input: [{ type: 'text', text: 'BAIT_PROMPT secret-token D:\\private\\bait' }],
    })
    const serialized = JSON.stringify(events)

    expect(serialized).not.toContain('BAIT_PROMPT')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('private')
    expect(serialized).not.toContain('RAW_STDERR_BAIT')
    expect(events.some((event) => event.event === 'request' && event.method === 'thread/read')).toBe(true)
  })
})
