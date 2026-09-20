import readline from 'node:readline'

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function baseThread({ id, cwd = 'D:\\Workspace\\Alpha', status, turns = [], preview = `Preview ${id}` }) {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview,
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1_725_000_000,
    updatedAt: 1_725_000_123,
    recencyAt: 1_725_000_123,
    status,
    path: null,
    cwd,
    cliVersion: '0.144.1',
    source: 'vscode',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: { sha: null, branch: 'main', originUrl: 'https://bait.invalid/private.git' },
    name: null,
    turns,
  }
}

function fullTurn(overrides = {}) {
  return {
    id: 'turn-active',
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt: 1_725_000_100,
    completedAt: null,
    durationMs: null,
    items: [
      {
        type: 'userMessage',
        id: 'item-user',
        clientId: null,
        content: [
          { type: 'text', text: '  原文\nEmoji 😀  ', text_elements: [] },
          { type: 'localImage', path: 'D:\\Workspace\\Alpha\\.tmp\\attachments\\secret.png' },
          { type: 'mention', name: 'notes.md', path: 'D:\\Workspace\\Alpha\\.tmp\\attachments\\notes.md' },
        ],
      },
      {
        type: 'agentMessage',
        id: 'item-agent',
        text: '回答保持原文',
        phase: 'commentary',
        memoryCitation: null,
      },
      {
        type: 'reasoning',
        id: 'item-reasoning',
        summary: ['第一段', '第二段'],
        content: ['RAW_REASONING_CONTENT_BAIT'],
      },
      {
        type: 'commandExecution',
        id: 'item-command',
        command: 'pnpm test',
        cwd: 'D:\\Workspace\\Alpha',
        processId: null,
        source: 'agent',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'ok\n',
        exitCode: 0,
        durationMs: 42,
      },
      {
        type: 'fileChange',
        id: 'item-file',
        status: 'completed',
        changes: [
          {
            path: 'D:\\Workspace\\Alpha\\src\\file.ts',
            kind: { type: 'update', move_path: 'D:\\Workspace\\Alpha\\src\\renamed.ts' },
            diff: '--- a/src/file.ts\n+++ b/src/file.ts\n-old\n+new\n+next\n',
          },
        ],
      },
      {
        type: 'plan',
        id: 'item-plan',
        text: '先读取，再执行。',
      },
      {
        type: 'webSearch',
        id: 'item-web',
        query: '当前北京时间',
        action: null,
      },
      {
        type: 'futureTool',
        id: 'item-future',
        raw: 'RAW_UNKNOWN_PAYLOAD_BAIT',
        localPath: 'D:\\Workspace\\Alpha\\PRIVATE_BAIT',
      },
      { type: 'hookPrompt', id: 'item-hook', fragments: [{ text: 'PRIVATE_BAIT', hookRunId: 'hook-1' }] },
      { type: 'mcpToolCall', id: 'item-mcp', server: 'docs', tool: 'search', status: 'completed' },
      { type: 'dynamicToolCall', id: 'item-dynamic', namespace: 'browser', tool: 'open', status: 'completed' },
      { type: 'collabAgentToolCall', id: 'item-collab', tool: 'wait', status: 'completed', receiverThreadIds: ['private-thread'] },
      { type: 'subAgentActivity', id: 'item-subagent', kind: 'interacted' },
      { type: 'imageView', id: 'item-image-view', path: 'D:\\Workspace\\Alpha\\PRIVATE_BAIT.png' },
      { type: 'sleep', id: 'item-sleep', durationMs: 250 },
      { type: 'imageGeneration', id: 'item-image-gen', status: 'completed' },
      { type: 'enteredReviewMode', id: 'item-review-enter', review: 'PRIVATE_BAIT' },
      { type: 'exitedReviewMode', id: 'item-review-exit', review: 'PRIVATE_BAIT' },
      { type: 'contextCompaction', id: 'item-compact' },
    ],
    ...overrides,
  }
}

function summaryTurn(id, suffix) {
  return {
    id,
    itemsView: 'summary',
    status: 'completed',
    error: null,
    startedAt: 1_725_000_100,
    completedAt: 1_725_000_120,
    durationMs: 20,
    items: [
      {
        type: 'userMessage',
        id: `item-summary-user-${suffix}`,
        clientId: null,
        content: [
          { type: 'text', text: `question-${suffix}`, text_elements: [] },
          ...(suffix === '1' ? [
            { type: 'localImage', path: 'C:\\Outside\\secret.png' },
            { type: 'mention', name: 'report.pdf', path: 'C:\\Outside\\report.pdf' },
          ] : []),
        ],
      },
      {
        type: 'agentMessage',
        id: `item-summary-agent-${suffix}`,
        text: `answer-${suffix}`,
        phase: 'final_answer',
        memoryCitation: null,
      },
    ],
  }
}

function readThread(threadId) {
  if (threadId === 'thread-unauthorized') {
    return baseThread({ id: threadId, cwd: 'D:\\Secret\\Outside', status: { type: 'idle' } })
  }
  if (threadId === 'thread-device-cwd') {
    return baseThread({ id: threadId, cwd: '//?/D:/Workspace/Alpha', status: { type: 'idle' } })
  }
  if (threadId === 'thread-rooted-cwd') {
    return baseThread({ id: threadId, cwd: '\\Workspace\\Alpha', status: { type: 'idle' } })
  }
  if (threadId === 'thread-case-mismatch') {
    return baseThread({ id: threadId, cwd: 'D:\\Workspace\\alpha', status: { type: 'idle' } })
  }
  if (threadId === 'thread-mismatch') {
    return baseThread({ id: 'different-thread', status: { type: 'idle' } })
  }
  if (threadId === 'thread-partial') {
    return baseThread({
      id: threadId,
      status: { type: 'idle' },
      turns: [fullTurn({ id: 'turn-partial', status: 'completed', itemsView: 'summary' })],
    })
  }
  if (threadId === 'thread-duplicate') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[1].id = 'item-user'
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-path-escape') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[4].changes[0].path = '..\\outside.ts'
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-drive-relative') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[4].changes[0].path = 'C:outside.ts'
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-move-escape') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[4].changes[0].kind.move_path = '..\\outside.ts'
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-file-case-mismatch') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[4].changes[0].path = 'D:\\Workspace\\alpha\\secret.ts'
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-move-case-mismatch') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[4].changes[0].kind.move_path = 'D:\\Workspace\\alpha\\renamed.ts'
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-unknown-status') {
    return baseThread({ id: threadId, status: { type: 'mystery' } })
  }
  if (threadId === 'thread-inconsistent') {
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [fullTurn()] })
  }
  if (threadId === 'thread-idle-full') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items[0].content = [turn.items[0].content[0]]
    turn.items = turn.items.filter(item => ![
      'webSearch', 'futureTool', 'hookPrompt', 'mcpToolCall', 'dynamicToolCall',
      'collabAgentToolCall', 'subAgentActivity', 'imageView', 'sleep',
      'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction',
    ].includes(item.type))
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-live-clean') {
    const turn = fullTurn()
    turn.items[0].content = [turn.items[0].content[0]]
    turn.items = turn.items.filter(item => ![
      'webSearch', 'futureTool', 'hookPrompt', 'mcpToolCall', 'dynamicToolCall',
      'collabAgentToolCall', 'subAgentActivity', 'imageView', 'sleep',
      'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction',
    ].includes(item.type))
    return baseThread({ id: threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [turn] })
  }
  if (threadId === 'thread-attachments') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items = turn.items.slice(0, 2)
    const prefix = 'Attached file report.txt: '
    const path = 'D:\\Workspace\\Alpha\\.tmp\\attachments\\PRIVATE_BAIT.txt'
    turn.items[0].content.push({
      type: 'text',
      text: `${prefix}${path}`,
      text_elements: [{
        byteRange: { start: Buffer.byteLength(prefix), end: Buffer.byteLength(`${prefix}${path}`) },
        placeholder: 'report.txt',
      }],
    })
    return baseThread({ id: threadId, status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-other' || threadId === 'thread-same-project-name') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items = turn.items.slice(0, 2)
    turn.items[0].content = [turn.items[0].content[0]]
    return baseThread({ id: threadId, cwd: threadId === 'thread-other' ? 'E:\\OtherProject' : 'F:\\OtherProject', status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-archived') {
    const turn = fullTurn({ status: 'completed', completedAt: 1_725_000_120 })
    turn.items = turn.items.slice(0, 2)
    turn.items[0].content = [turn.items[0].content[0]]
    return baseThread({ id: threadId, cwd: 'F:\\ArchivedProject', status: { type: 'idle' }, turns: [turn] })
  }
  if (threadId === 'thread-owned-summary-pages') {
    return baseThread({ id: threadId, status: { type: 'active', activeFlags: [] } })
  }
  if (threadId === 'thread-summary-pages') {
    return baseThread({ id: threadId, cwd: 'E:\\OtherProject', status: { type: 'notLoaded' } })
  }
  return baseThread({
    id: threadId,
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
    turns: [fullTurn()],
  })
}

input.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.exit(41)
  }

  if (frame.method === 'model/list') {
    send({ id: frame.id, result: { data: ['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.4','gpt-5.4-mini','gpt-5.3-codex-spark'].map(model => ({ model, displayName: model, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})), isDefault: model === 'gpt-6-astra' })), nextCursor: null } });
    return;
  }
  if (frame.method === 'initialize') {
    send({
      id: frame.id,
      result: {
        userAgent: 'fake-read-app-server',
        codexHome: 'D:\\FAKE_CODEX_HOME_BAIT',
        platformFamily: 'windows',
        platformOs: 'windows',
      },
    })
    return
  }

  if (frame.method === 'initialized') return

  if (frame.method === 'thread/list') {
    send({ method: 'fake/request-observed', params: frame.params })
    if (process.argv[2] === 'root-workspaces') {
      send({ id: frame.id, result: { data: [
        baseThread({ id: 'thread-normal', status: { type: 'idle' } }),
        baseThread({ id: 'thread-drive-root', cwd: 'D:/', status: { type: 'idle' } }),
        baseThread({ id: 'thread-share-root', cwd: '//fileserver/share/', status: { type: 'idle' } }),
      ], nextCursor: null, backwardsCursor: null } })
      return
    }
    const archived = frame.params.archived === true
    const continuation = frame.params.cursor === 'next-page'
    send({
      id: frame.id,
      result: {
        data: archived ? [
          baseThread({
            id: 'thread-archived',
            cwd: 'F:\\ArchivedProject',
            status: { type: 'idle' },
            preview: 'x'.repeat(3345),
          }),
        ] : continuation ? [] : [
          baseThread({ id: 'thread-not-loaded', status: { type: 'notLoaded' } }),
          baseThread({
            id: 'thread-active',
            status: { type: 'active', activeFlags: ['waitingOnUserInput'] },
          }),
          baseThread({ id: 'thread-idle-full', status: { type: 'idle' } }),
          ...('cwd' in frame.params ? [] : [baseThread({ id: 'thread-other', cwd: 'E:\\OtherProject', status: { type: 'idle' } })]),
        ],
        nextCursor: archived || continuation ? null : 'next-page',
        backwardsCursor: 'previous-page',
      },
    })
    return
  }

  if (frame.method === 'thread/read') {
    send({ method: 'fake/request-observed', params: frame.params })
    if (['thread-owned-active', 'thread-owned-summary-pages'].includes(frame.params?.threadId) && frame.params?.includeTurns === true) {
      send({ id: frame.id, error: { code: -32603, message: 'active full read unavailable' } })
      return
    }
    const thread = readThread(frame.params?.threadId)
    send({
      id: frame.id,
      result: {
        thread: frame.params?.includeTurns === false ? { ...thread, turns: [] } : thread,
      },
    })
    return
  }

  if (frame.method === 'thread/turns/list') {
    send({ method: 'fake/request-observed', params: frame.params })
    if (!['thread-summary-pages', 'thread-owned-summary-pages'].includes(frame.params?.threadId)) {
      send({ id: frame.id, error: { code: -32602, message: 'unknown thread' } })
      return
    }
    const second = frame.params?.cursor === 'turn-page-2'
    send({
      id: frame.id,
      result: {
        data: [{ ...summaryTurn(second ? 'turn-summary-1' : 'turn-summary-2', second ? '1' : '2'),
          ...(frame.params.threadId === 'thread-owned-summary-pages' && !second ? { status: 'inProgress', completedAt: null } : {}),
        }],
        nextCursor: second ? null : 'turn-page-2',
        backwardsCursor: second ? 'turn-page-1' : null,
      },
    })
    return
  }

  send({ id: frame.id, error: { code: -32601, message: 'unsupported' } })
})
