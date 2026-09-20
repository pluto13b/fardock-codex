import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  AppServerReadProjection,
  AppServerReadProjectionError,
  AppServerSupervisor,
  type Notification,
  type SupervisorLogEvent,
} from '../src/index.ts'

const fakeChild = fileURLToPath(new URL('./fixtures/fake-read-app-server.mjs', import.meta.url))
const supervisors = new Set<AppServerSupervisor>()
const workspace = Object.freeze({
  id: 'workspace-alpha',
  name: 'Alpha',
  path: 'D:\\Workspace\\Alpha',
  pathLabel: 'Workspace / Alpha',
})

async function createProjection(options: {
  readonly pageSize?: number
  readonly workspaces?: readonly (typeof workspace)[]
  readonly logs?: SupervisorLogEvent[]
  readonly notifications?: Notification[]
  readonly allowAllLocalThreads?: boolean
  readonly paginateTurns?: boolean
  readonly fixtureMode?: string
} = {}): Promise<AppServerReadProjection> {
  const supervisor = new AppServerSupervisor({
    command: { executable: process.execPath, args: [fakeChild, ...(options.fixtureMode === undefined ? [] : [options.fixtureMode])] },
    clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
    allowedMethods: ['thread/list', 'thread/read', 'thread/turns/list'],
    limits: {
      initializationTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      shutdownGraceMs: 100,
    },
    ...(options.logs === undefined
      ? {}
      : { logger: (event: SupervisorLogEvent) => options.logs?.push(event) }),
  })
  supervisors.add(supervisor)
  if (options.notifications !== undefined) {
    supervisor.onNotification((notification) => options.notifications?.push(notification))
  }
  const projection = new AppServerReadProjection({
    supervisor,
    workspaces: options.workspaces ?? [workspace],
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.allowAllLocalThreads === undefined ? {} : { allowAllLocalThreads: options.allowAllLocalThreads }),
    ...(options.paginateTurns === undefined ? {} : { paginateTurns: options.paginateTurns }),
  })
  await supervisor.start()
  return projection
}

afterEach(async () => {
  await Promise.all([...supervisors].map((supervisor) => supervisor.close()))
  supervisors.clear()
})

describe('AppServerReadProjection list/read compatibility', () => {
  it('keeps legitimate drive and UNC root tasks in the all-local directory without exposing paths', async () => {
    const projection = await createProjection({ allowAllLocalThreads: true, fixtureMode: 'root-workspaces' })
    const page = await projection.listTasks()
    expect(page.tasks).toHaveLength(3)
    expect(projection.listAuthorizedWorkspaces().map(value => value.name)).toEqual(['Alpha', '磁盘 D', 'share'])
    expect(JSON.stringify(page)).not.toContain('D:/')
    expect(JSON.stringify(page)).not.toContain('fileserver')
    const restricted = await createProjection({ fixtureMode: 'root-workspaces' })
    await expect(restricted.listTasks()).rejects.toMatchObject({ code: 'unauthorized-workspace' })
  })
  it('lists all projects and archived threads in the authorized all-local scope without exposing cwd', async () => {
    const notifications: Notification[] = []
    const projection = await createProjection({ allowAllLocalThreads: true, notifications })
    const pages = []
    let cursor: string | undefined
    for (let index = 0; index < 4; index += 1) {
      const page = await projection.listTasks(cursor)
      pages.push(page)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    const tasks = pages.flatMap(page => page.tasks)
    const otherWorkspace = tasks.find(task => task.id === 'thread-other')!.workspaceId
    const archivedWorkspace = tasks.find(task => task.id === 'thread-archived')!.workspaceId
    expect(otherWorkspace).not.toBe('workspace-alpha')
    expect(archivedWorkspace).not.toBe(otherWorkspace)
    expect(tasks).toContainEqual(expect.objectContaining({
      id: 'thread-archived',
      workspaceId: archivedWorkspace,
      title: 'x'.repeat(256),
    }))
    const task = await projection.readTask('thread-other')
    expect(task.workspace).toEqual({ id: otherWorkspace, name: 'OtherProject', pathLabel: 'OtherProject' })
    expect(projection.listAuthorizedWorkspaces()).toEqual([
      { id: 'workspace-alpha', name: 'Alpha', pathLabel: 'Workspace / Alpha' },
      task.workspace,
      { id: archivedWorkspace, name: 'ArchivedProject', pathLabel: 'ArchivedProject' },
    ])
    expect(JSON.stringify({ pages, task })).not.toContain('E:\\OtherProject')
    expect(notifications).toContainEqual(expect.objectContaining({
      method: 'fake/request-observed',
      params: expect.not.objectContaining({ cwd: expect.anything() }),
    }))
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: {
        cursor: null,
        limit: 50,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: true,
        modelProviders: [],
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'],
        useStateDbOnly: true,
      },
    })
  })
  it('keeps same-name projects distinct and keeps a read-before-list workspace stable', async () => {
    const projection = await createProjection({ allowAllLocalThreads: true })
    const selected = await projection.readTask('thread-other')
    const sameName = await projection.readTask('thread-same-project-name')
    const listed = await projection.listTasks()
    expect(listed.tasks.find(task => task.id === 'thread-other')?.workspaceId).toBe(selected.workspace.id)
    expect(sameName.workspace).toMatchObject({ name: 'OtherProject (2)' })
    expect(sameName.workspace.id).not.toBe(selected.workspace.id)
    expect((await projection.readTask('thread-same-project-name')).workspace).toEqual(sameName.workspace)
    const restarted = await createProjection({ allowAllLocalThreads: true })
    expect((await restarted.readTask('thread-same-project-name')).workspace.id).toBe(sameName.workspace.id)
    expect((await restarted.readTask('thread-other')).workspace.id).toBe(selected.workspace.id)
    expect(JSON.stringify(projection.listAuthorizedWorkspaces())).not.toMatch(/[A-Z]:\\\\/)
  })
  it('lists only configured workspaces and preserves upstream status without invented authority', async () => {
    const notifications: Notification[] = []
    const projection = await createProjection({ notifications })
    expect(projection.listAuthorizedWorkspaces()).toEqual([{
      id: 'workspace-alpha',
      name: 'Alpha',
      pathLabel: 'Workspace / Alpha',
    }])
    const page = await projection.listTasks('opaque-cursor')

    expect(page).toEqual({
      authoritative: false,
      schemaVersion: '0.153.4',
      tasks: [
        expect.objectContaining({
          id: 'thread-not-loaded',
          workspaceId: 'workspace-alpha',
          status: { type: 'notLoaded' },
        }),
        expect.objectContaining({
          id: 'thread-active',
          status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
        }),
        expect.objectContaining({
          id: 'thread-idle-full',
          status: { type: 'idle' },
        }),
      ],
      nextCursor: 'next-page',
    })
    expect(page).not.toHaveProperty('revision')
    expect(page).not.toHaveProperty('sequence')
    expect(page).not.toHaveProperty('capabilities')
    expect(JSON.stringify(page)).not.toContain('D:\\\\Workspace')
    expect(Object.isFrozen(page)).toBe(true)
    expect(Object.isFrozen(page.tasks)).toBe(true)
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: {
        cursor: 'opaque-cursor',
        limit: 50,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        cwd: ['D:\\Workspace\\Alpha'],
        useStateDbOnly: true,
      },
    })
  })

  it('reads a bounded newest summary window and preserves only accepted owned active authority', async () => {
    const notifications: Notification[] = []
    const projection = await createProjection({
      allowAllLocalThreads: true,
      paginateTurns: true,
      notifications,
    })
    const task = await projection.readTask('thread-summary-pages')

    expect(task.completeness).toBe('full')
    expect(task.task.status).toEqual({ type: 'notLoaded' })
    expect(task.turns.map(turn => turn.id)).toEqual(['turn-summary-1', 'turn-summary-2'])
    expect(task.turns.flatMap(turn => turn.items).map(item => item.kind)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ])
    expect(task.turns[0]?.items[0]).toMatchObject({
      kind: 'user',
      inputs: [
        { type: 'text', text: 'question-1' },
        { type: 'localImage', name: 'secret.png' },
        { type: 'file', name: 'report.pdf' },
      ],
    })
    expect(JSON.stringify(task)).not.toContain('C:\\\\Outside')
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: { threadId: 'thread-summary-pages', includeTurns: false },
    })
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: {
        threadId: 'thread-summary-pages',
        cursor: null,
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    })
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: {
        threadId: 'thread-summary-pages',
        cursor: 'turn-page-2',
        limit: 1,
        sortDirection: 'desc',
        itemsView: 'summary',
      },
    })
    const owned = await projection.readTask('thread-idle-full', { full: true })
    expect(owned.completeness).toBe('full')
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: { threadId: 'thread-idle-full', includeTurns: true },
    })
    projection.registerOwnedActiveTask({
      taskId: 'thread-owned-active',
      workspaceId: 'workspace-alpha',
      actionId: 'action-owned-active',
      turnId: 'turn-owned-active',
      title: 'Owned active task',
      text: 'exact active input',
      now: 1_725_000_100_000,
    })
    const active = await projection.readTask('thread-owned-active', { full: true })
    expect(active).toMatchObject({
      completeness: 'full',
      activeTurnId: 'turn-owned-active',
      task: { id: 'thread-owned-active', status: { type: 'active', activeFlags: [] } },
      turns: [{
        id: 'turn-owned-active',
        status: 'inProgress',
        items: [{ kind: 'user', id: 'action-owned-active', inputs: [{ type: 'text', text: 'exact active input' }] }],
      }],
    })
  })

  it('projects a full timeline, preserves text boundaries, and strips local path payloads', async () => {
    const logs: SupervisorLogEvent[] = []
    const notifications: Notification[] = []
    const projection = await createProjection({ logs, notifications })
    const task = await projection.readTask('thread-active')

    expect(task.authoritative).toBe(false)
    expect(task.completeness).toBe('partial')
    expect(task.activeTurnId).toBe('turn-active')
    expect(task.workspace).toEqual({
      id: 'workspace-alpha',
      name: 'Alpha',
      pathLabel: 'Workspace / Alpha',
    })
    expect(task.turns[0]?.items.map((item) => item.kind)).toEqual([
      'user',
      'assistant',
      'reasoning',
      'command',
      'fileChange',
      'plan',
      'webSearch',
      'compatibility',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
      'operation',
    ])
    expect(task.turns[0]?.items.every((item) => item.createdAt === null)).toBe(true)
    const user = task.turns[0]?.items[0]
    expect(user?.kind).toBe('user')
    if (user?.kind !== 'user') throw new Error('expected projected user item')
    expect(user.inputs).toEqual([
      { type: 'text', text: '  原文\nEmoji 😀  ' },
      { type: 'localImage', name: 'secret.png' },
      { type: 'file', name: 'notes.md' },
    ])
    const fileChange = task.turns[0]?.items[4]
    expect(fileChange?.kind).toBe('fileChange')
    if (fileChange?.kind !== 'fileChange') throw new Error('expected projected file change')
    expect(fileChange.changes).toEqual([
      {
        path: 'src/file.ts',
        kind: 'update',
        movePath: 'src/renamed.ts',
        additions: 2,
        deletions: 1,
      },
    ])
    const webSearch = task.turns[0]?.items[6]
    expect(webSearch).toMatchObject({ kind: 'webSearch', query: '当前北京时间', actionType: 'other' })
    expect(task.turns[0]?.items.filter(item => item.kind === 'operation').map(item => item.title)).toEqual([
      'Hook prompt',
      'MCP · docs',
      'browser',
      'Sub-agent',
      'Sub-agent activity',
      'Image viewed',
      'Wait',
      'Image generation',
      'Entered review mode',
      'Exited review mode',
      'Context compacted',
    ])
    expect(task.compatibility).toEqual([
      {
        code: 'unsupported-item',
        turnId: 'turn-active',
        itemId: 'item-future',
        itemType: 'futureTool',
      },
    ])

    const serialized = JSON.stringify(task)
    expect(serialized).not.toContain('D:\\\\Workspace')
    expect(serialized).not.toContain('PRIVATE_BAIT')
    expect(serialized).not.toContain('RAW_UNKNOWN_PAYLOAD_BAIT')
    expect(serialized).not.toContain('RAW_REASONING_CONTENT_BAIT')
    expect(serialized).not.toContain('private.git')
    expect(JSON.stringify(logs)).not.toContain('Workspace')
    expect(notifications).toContainEqual({
      method: 'fake/request-observed',
      params: { threadId: 'thread-active', includeTurns: true },
    })
  })

  it('projects local images and file mentions without exposing Host paths', async () => {
    const projection = await createProjection()
    const task = await projection.readTask('thread-attachments')
    expect(task.completeness).toBe('full')
    const user = task.turns[0]?.items[0]
    expect(user).toMatchObject({
      kind: 'user',
      inputs: [
        { type: 'text', text: '  原文\nEmoji 😀  ' },
        { type: 'localImage', name: 'secret.png' },
        { type: 'file', name: 'notes.md' },
        { type: 'text', text: '[File: report.txt]' },
      ],
    })
    expect(JSON.stringify(task)).not.toContain('D:\\Workspace')
  })

  it.each([
    ['thread-mismatch', 'task-mismatch'],
    ['thread-unauthorized', 'unauthorized-workspace'],
    ['thread-device-cwd', 'unauthorized-workspace'],
    ['thread-rooted-cwd', 'unauthorized-workspace'],
    ['thread-case-mismatch', 'unauthorized-workspace'],
    ['thread-partial', 'protocol-error'],
    ['thread-duplicate', 'protocol-error'],
    ['thread-path-escape', 'unauthorized-workspace'],
    ['thread-drive-relative', 'unauthorized-workspace'],
    ['thread-move-escape', 'unauthorized-workspace'],
    ['thread-file-case-mismatch', 'unauthorized-workspace'],
    ['thread-move-case-mismatch', 'unauthorized-workspace'],
    ['thread-unknown-status', 'protocol-error'],
    ['thread-inconsistent', 'protocol-error'],
  ])('fails closed for incompatible read %s', async (threadId, code) => {
    const projection = await createProjection()
    await expect(projection.readTask(threadId)).rejects.toMatchObject({ code })
  })

  it('rejects invalid workspace configuration and unbounded public inputs', async () => {
    const supervisor = new AppServerSupervisor({
      command: { executable: process.execPath, args: [fakeChild] },
      clientInfo: { name: 'codex_plus', title: 'Codex Plus', version: '0.0.0' },
      allowedMethods: ['thread/list', 'thread/read'],
    })
    supervisors.add(supervisor)
    expect(
      () =>
        new AppServerReadProjection({
          supervisor,
          workspaces: [workspace, { ...workspace, id: 'second', path: 'd:\\workspace\\alpha\\' }],
        }),
    ).toThrowError(AppServerReadProjectionError)
    expect(
      () => new AppServerReadProjection({ supervisor, workspaces: [workspace], pageSize: 101 }),
    ).toThrowError(AppServerReadProjectionError)
    expect(
      () => new AppServerReadProjection({ supervisor, workspaces: [workspace], paginateTurns: true }),
    ).not.toThrow()
    for (const unsafePath of ['//?/D:/Workspace/Alpha', '//./pipe/codex', '\\rooted', 'D:\\']) {
      expect(
        () =>
          new AppServerReadProjection({
            supervisor,
            workspaces: [{ ...workspace, path: unsafePath }],
          }),
      ).toThrowError(AppServerReadProjectionError)
    }
    const sparseWorkspaces = new Array(2) as (typeof workspace)[]
    sparseWorkspaces[0] = workspace
    expect(
      () => new AppServerReadProjection({ supervisor, workspaces: sparseWorkspaces }),
    ).toThrowError(AppServerReadProjectionError)
    const oversizedWorkspaces = new Proxy(
      Array.from({ length: 33 }, (_, index) => ({
        ...workspace,
        id: `workspace-${index}`,
        path: `D:\\Workspace\\Project-${index}`,
      })),
      {
        get(target, property, receiver) {
          if (property === 'length') return 1
          return Reflect.get(target, property, receiver)
        },
      },
    )
    expect(
      () => new AppServerReadProjection({ supervisor, workspaces: oversizedWorkspaces }),
    ).toThrowError(AppServerReadProjectionError)

    const projection = new AppServerReadProjection({
      supervisor,
      workspaces: [workspace],
    })
    await expect(projection.readTask('')).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(projection.listTasks('x'.repeat(4_097))).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })
})
