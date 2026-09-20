import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import {
  APP_SERVER_METHODS,
  APP_SERVER_SCHEMA_VERSION,
  AppServerSupervisor,
  establishRuntimeCompatibility,
  isRuntimeCompatibilityCurrent,
  type RuntimeCompatibility,
  type SupervisorConfig,
  type SupervisorLogEvent,
} from '../src/index.ts'
import {
  establishRuntimeCompatibilityForTest,
  isSafeAbsoluteWindowsPath,
  runVersionProbeForTest,
} from '../src/runtime-binding.ts'
import { isStrictInitializeResultForTest } from '../src/supervisor.ts'

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
      requestTimeoutMs: 200,
      serverRequestTimeoutMs: 100,
      shutdownGraceMs: 100,
    },
    ...overrides,
  })
  supervisors.add(supervisor)
  return supervisor
}

afterEach(async () => {
  await Promise.all([...supervisors].map((supervisor) => supervisor.close()))
  supervisors.clear()
})

describe('runtime compatibility authority', () => {
  it('issues one immutable generation-scoped compatibility binding without secret paths', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()

    const firstAttempt = establishRuntimeCompatibilityForTest(supervisor)
    const concurrentAttempt = establishRuntimeCompatibilityForTest(supervisor, { probe: 'mismatch' })
    expect(concurrentAttempt).toBe(firstAttempt)
    const compatibility = await firstAttempt

    expect(compatibility).toEqual({
      state: 'write-bound',
      schemaVersion: APP_SERVER_SCHEMA_VERSION,
      supervisorGeneration: supervisor.generation,
      capabilities: {
        resumeThread: true,
        sendTextTurn: true,
        streamCore: true,
        interruptTurn: true,
        steerTurn: true,
        attachments: true,
        resolveServerRequest: false,
      },
    })
    expect(Object.isFrozen(compatibility)).toBe(true)
    expect(Object.isFrozen(compatibility.state === 'write-bound' ? compatibility.capabilities : {})).toBe(true)
    expect(JSON.stringify(compatibility)).not.toMatch(/codexHome|FakeCodexHome|node\.exe|raw|stderr/i)
    expect(isRuntimeCompatibilityCurrent(supervisor, compatibility)).toBe(true)

    const forged = { ...compatibility } as RuntimeCompatibility
    expect(isRuntimeCompatibilityCurrent(supervisor, forged)).toBe(false)
  })

  it.each([
    [{ commandMatches: false }, 'app-server-command-mismatch'],
    [{ executablePathSafe: false }, 'unsafe-executable-path'],
    [{ probe: 'spawn-failed' as const }, 'version-probe-spawn-failed'],
    [{ probe: 'timeout' as const }, 'version-probe-timeout'],
    [{ probe: 'overflow' as const }, 'version-probe-output-overflow'],
    [{ probe: 'termination-failed' as const }, 'version-probe-termination-failed'],
    [{ probe: 'exit-failed' as const }, 'version-probe-exit-failed'],
    [{ probe: 'mismatch' as const }, 'version-mismatch'],
  ])('makes a mismatch sticky read-only: %j', async (facts, reason) => {
    const supervisor = createSupervisor()
    await supervisor.start()

    const first = await establishRuntimeCompatibilityForTest(supervisor, facts)
    const second = await establishRuntimeCompatibilityForTest(supervisor)

    expect(first).toEqual({
      state: 'read-only',
      supervisorGeneration: supervisor.generation,
      reason,
    })
    expect(second).toBe(first)
    expect(isRuntimeCompatibilityCurrent(supervisor, first)).toBe(false)
  })

  it.each([
    ['init-user-agent-mismatch', 'user-agent-mismatch'],
    ['init-user-agent-control', 'user-agent-mismatch'],
    ['init-platform-mismatch', 'platform-mismatch'],
  ])('rejects initialize compatibility mismatch %s', async (mode, reason) => {
    const supervisor = createSupervisor(mode)
    await supervisor.start()

    await expect(establishRuntimeCompatibilityForTest(supervisor)).resolves.toMatchObject({
      state: 'read-only',
      reason,
    })
  })

  it('accepts the standalone Companion originator without a Desktop environment override', async () => {
    const supervisor = createSupervisor('init-own-user-agent')
    await supervisor.start()
    expect(await establishRuntimeCompatibilityForTest(supervisor)).toMatchObject({ state: 'write-bound' })
  })

  it('still rejects an unverified build version with the correct Companion originator', async () => {
    const supervisor = createSupervisor('init-own-unknown-version')
    await supervisor.start()
    expect(await establishRuntimeCompatibilityForTest(supervisor)).toMatchObject({ state: 'read-only', reason: 'user-agent-mismatch' })
  })

  it('accepts the pinned official Codex Desktop user-agent token', async () => {
    const supervisor = createSupervisor('init-desktop-user-agent')
    await supervisor.start()

    await expect(establishRuntimeCompatibilityForTest(supervisor)).resolves.toMatchObject({
      state: 'write-bound',
      schemaVersion: APP_SERVER_SCHEMA_VERSION,
    })
  })

  it('keeps production binding read-only for a non-canonical child command', async () => {
    const supervisor = createSupervisor()
    await supervisor.start()

    await expect(establishRuntimeCompatibility(supervisor)).resolves.toMatchObject({
      state: 'read-only',
      reason: 'app-server-command-mismatch',
    })
  })

  it('makes a pre-ready failure sticky for the whole supervisor generation', async () => {
    const supervisor = createSupervisor()
    const beforeStart = await establishRuntimeCompatibilityForTest(supervisor)
    await supervisor.start()
    const afterStart = await establishRuntimeCompatibilityForTest(supervisor)

    expect(beforeStart).toMatchObject({ state: 'read-only', reason: 'supervisor-not-ready' })
    expect(afterStart).toBe(beforeStart)
  })

  it('invalidates the issued identity on close, child failure and cross-supervisor use', async () => {
    const firstSupervisor = createSupervisor('malformed-error')
    const secondSupervisor = createSupervisor()
    await Promise.all([firstSupervisor.start(), secondSupervisor.start()])
    const firstBinding = await establishRuntimeCompatibilityForTest(firstSupervisor)
    const secondBinding = await establishRuntimeCompatibilityForTest(secondSupervisor)

    expect(isRuntimeCompatibilityCurrent(secondSupervisor, firstBinding)).toBe(false)
    expect(isRuntimeCompatibilityCurrent(firstSupervisor, secondBinding)).toBe(false)
    await expect(firstSupervisor.request('thread/list', {})).rejects.toBeDefined()
    expect(isRuntimeCompatibilityCurrent(firstSupervisor, firstBinding)).toBe(false)

    await secondSupervisor.close()
    expect(isRuntimeCompatibilityCurrent(secondSupervisor, secondBinding)).toBe(false)
  })

  it('does not put probe or initialize bait into supervisor logs or binding results', async () => {
    const events: SupervisorLogEvent[] = []
    const supervisor = createSupervisor('normal', { logger: (event) => events.push(event) })
    await supervisor.start()
    const compatibility = await establishRuntimeCompatibilityForTest(supervisor)
    const serialized = JSON.stringify({ events, compatibility })

    expect(serialized).not.toMatch(/FakeCodexHome|private|token|stderr|node\.exe/i)
  })
})

describe('strict initialize response and Windows paths', () => {
  const validInitialize = Object.freeze({
    userAgent: 'codex_cli_rs/0.151.0 test',
    codexHome: 'D:\\Users\\tester\\.codex',
    platformFamily: 'windows',
    platformOs: 'windows',
  })

  it('accepts exactly four owned plain data properties', () => {
    expect(isStrictInitializeResultForTest(validInitialize)).toBe(true)
    expect(isStrictInitializeResultForTest({ ...validInitialize, extra: true })).toBe(false)
    expect(isStrictInitializeResultForTest({ ...validInitialize, platformOs: undefined })).toBe(false)

    const accessor = { ...validInitialize }
    Object.defineProperty(accessor, 'userAgent', { enumerable: true, get: () => validInitialize.userAgent })
    expect(isStrictInitializeResultForTest(accessor)).toBe(false)

    const proxy = new Proxy({ ...validInitialize }, { ownKeys: () => { throw new Error('bait') } })
    expect(isStrictInitializeResultForTest(proxy)).toBe(false)
  })

  it.each(['init-unknown-field', 'init-missing-field', 'init-wrong-type', 'init-unsafe-home'])(
    'fails the supervisor closed for strict initialize mode %s',
    async (mode) => {
      const supervisor = createSupervisor(mode)
      await expect(supervisor.start()).rejects.toMatchObject({ code: 'protocol-error' })
      expect(supervisor.state).toBe('failed')
    },
  )

  it.each([
    ['D:\\Apps\\codex.exe', true],
    ['D:\\', false],
    ['codex.exe', false],
    ['\\\\server\\share\\codex.exe', false],
    ['\\\\?\\D:\\Apps\\codex.exe', false],
    ['D:\\Apps\\codex.exe:stream', false],
    ['D:\\Apps\\CON', false],
    ['D:\\Apps\\CONIN$', false],
    ['D:\\Apps\\bad.\\codex.exe', false],
    ['D:\\Apps\\bad name \\codex.exe', false],
    ['D:\\Apps\\bad|name\\codex.exe', false],
  ])('classifies safe drive-qualified path %s', (path, expected) => {
    expect(isSafeAbsoluteWindowsPath(path)).toBe(expected)
  })
})

class FakeProbeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = false
  unrefed = false
  killCalls = 0

  kill(): boolean {
    this.killed = true
    this.killCalls += 1
    queueMicrotask(() => this.emit('close', null))
    return true
  }

  unref(): void {
    this.unrefed = true
  }
}

class NoCloseProbeChild extends FakeProbeChild {
  override kill(): boolean {
    this.killed = true
    this.killCalls += 1
    queueMicrotask(() => this.emit('error', new Error('ASYNC_KILL_ERROR_BAIT')))
    return false
  }
}

class EventualCloseProbeChild extends NoCloseProbeChild {
  override kill(): boolean {
    const result = super.kill()
    if (this.killCalls === 1) setTimeout(() => this.emit('close', null), 20)
    return result
  }
}

type ProbeSpawner = Parameters<typeof runVersionProbeForTest>[1]

function fakeSpawner(child: FakeProbeChild): ProbeSpawner {
  return (() => child) as unknown as ProbeSpawner
}

describe('bounded canonical version probe', () => {
  const command = { executable: 'D:\\Apps\\codex.exe', args: ['app-server'] } as const

  it.each([
    ['codex-cli 0.151.0', 'matched'],
    ['codex-cli 0.151.0\n', 'matched'],
    ['codex-cli 0.151.0\r\n', 'matched'],
    ['\ufeffcodex-cli 0.151.0\n', 'version-mismatch'],
    ['codex-cli 0.151.0\nextra\n', 'version-mismatch'],
    ['codex-cli 0.150.0-alpha.8\n', 'version-mismatch'],
  ])('classifies exact output %j', async (output, expected) => {
    const child = new FakeProbeChild()
    const result = runVersionProbeForTest(command, fakeSpawner(child))
    child.stdout.write(Buffer.from(output, 'utf8'))
    child.emit('close', 0)
    await expect(result).resolves.toBe(expected)
  })

  it('allows bounded stderr without exposing its content', async () => {
    const child = new FakeProbeChild()
    const result = runVersionProbeForTest(command, fakeSpawner(child))
    child.stderr.write('RAW_STDERR_BAIT token=secret path=D:\\private')
    child.stdout.write('codex-cli 0.151.0\n')
    child.emit('close', 0)
    await expect(result).resolves.toBe('matched')
  })

  it.each(['stdout', 'stderr'] as const)('fails and cleans up on %s overflow', async (stream) => {
    const child = new FakeProbeChild()
    const result = runVersionProbeForTest(command, fakeSpawner(child))
    child[stream].write(Buffer.alloc(4 * 1024 + 1, 0x61))

    await expect(result).resolves.toBe('version-probe-output-overflow')
    expect(child.killed).toBe(true)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('settles and cleans up on timeout without waiting for close', async () => {
    const child = new FakeProbeChild()
    const result = runVersionProbeForTest(command, fakeSpawner(child), 5)

    await expect(result).resolves.toBe('version-probe-timeout')
    expect(child.killed).toBe(true)
    expect(child.killCalls).toBe(1)
    expect(child.unrefed).toBe(false)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('waits for eventual close after kill=false and preserves the timeout reason', async () => {
    const child = new EventualCloseProbeChild()
    const result = runVersionProbeForTest(command, fakeSpawner(child), 5)

    await expect(result).resolves.toBe('version-probe-timeout')
    expect(child.killCalls).toBe(1)
    expect(child.unrefed).toBe(false)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('uses two bounded kill attempts then reports termination failure without unref', async () => {
    const child = new NoCloseProbeChild()
    const result = runVersionProbeForTest(command, fakeSpawner(child), 5)

    await expect(result).resolves.toBe('version-probe-termination-failed')
    expect(child.killCalls).toBe(2)
    expect(child.unrefed).toBe(false)
    expect(child.listenerCount('error')).toBe(1)
    child.emit('close', null)
    expect(child.listenerCount('error')).toBe(0)
  })

  it('settles immediately on spawn error or a nonzero exit', async () => {
    const spawnErrorChild = new FakeProbeChild()
    const spawnError = runVersionProbeForTest(command, fakeSpawner(spawnErrorChild))
    spawnErrorChild.emit('error', new Error('BAIT_CAUSE'))
    await expect(spawnError).resolves.toBe('version-probe-spawn-failed')

    const exitChild = new FakeProbeChild()
    const exitFailure = runVersionProbeForTest(command, fakeSpawner(exitChild))
    exitChild.emit('close', 23)
    await expect(exitFailure).resolves.toBe('version-probe-exit-failed')

    const throwSpawner = (() => { throw new Error('BAIT_CAUSE') }) as ProbeSpawner
    await expect(runVersionProbeForTest(command, throwSpawner)).resolves.toBe(
      'version-probe-spawn-failed',
    )
  })
})
