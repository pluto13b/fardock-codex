import readline from 'node:readline'

const mode = process.argv[2] ?? 'normal'
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const loadedThreads = new Set()
let startedThreads = 0

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function thread(id) {
  return {
    id,
    sessionId: 'session-1',
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: 'idle' },
    path: null,
    cwd: 'D:\\workspace',
    cliVersion: '0.150.0-alpha.8',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

input.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.exit(31)
  }

  if (frame.method === 'model/list') {
    send({ id: frame.id, result: { data: ['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','gpt-5.4','gpt-5.4-mini','gpt-5.3-codex-spark'].map(model => ({ model, displayName: model, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort})), isDefault: model === 'gpt-6-astra' })), nextCursor: null } });
    return;
  }
  if (frame.method === 'initialize') {
    send({
      id: frame.id,
      result: {
        userAgent: 'codex_cli_rs/0.151.0 fake-app-server',
        codexHome: 'D:\\FakeCodexHome',
        platformFamily: 'windows',
        platformOs: 'windows',
      },
    })
    return
  }
  if (frame.method === 'initialized' && frame.id === undefined) return

  if (frame.method === 'thread/loaded/list') {
    send({ method: 'fake/write-seen', params: { method: frame.method, params: frame.params } })
    send({ id: frame.id, result: { data: [...loadedThreads], nextCursor: null } })
    return
  }

  if (frame.method === 'thread/start') {
    send({ method: 'fake/write-seen', params: { method: frame.method, params: frame.params } })
    const id = `thread-new-${++startedThreads}`
    loadedThreads.add(id)
    send({
      id: frame.id,
      result: {
        thread: thread(id),
        model: frame.params.model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: frame.params.cwd,
        instructionSources: [],
        approvalPolicy: frame.params.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: { type: frame.params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'workspaceWrite' },
        reasoningEffort: null,
      },
    })
    return
  }

  if (frame.method === 'thread/resume') {
    if (mode === 'resume-rejected') { send({ id: frame.id, error: { code: -32600, message: 'test rejected' } }); return }
    send({ method: 'fake/write-seen', params: { method: frame.method, params: frame.params } })
    const resumedId = mode === 'resume-mismatch' ? 'thread-other' : frame.params.threadId
    loadedThreads.add(resumedId)
    send({
      id: frame.id,
      result: {
        thread: thread(resumedId),
        model: 'gpt-test',
        modelProvider: 'openai',
        serviceTier: null,
        cwd: 'D:\\workspace',
        instructionSources: [],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'workspaceWrite' },
        reasoningEffort: null,
      },
    })
    return
  }

  if (frame.method === 'turn/start') {
    send({ method: 'fake/write-seen', params: { method: frame.method, params: frame.params } })
    if (mode === 'turn-rejected') { send({ id: frame.id, error: { code: -32600, message: 'test rejected' } }); return }
    if (mode === 'turn-timeout') return
    if (mode === 'turn-child-exit') process.exit(25)
    const requestInput = frame.params.input[0]
    send({
      id: frame.id,
      result: {
        turn: {
          id: mode === 'turn-active-id' ? 'turn-active' : 'turn-1',
          items: mode === 'empty-turn-items' ? [] : [{
            type: 'userMessage',
            id: 'message-1',
            clientId: mode === 'client-mismatch'
              ? 'different-action'
              : frame.params.clientUserMessageId,
            content: [{
              type: 'text',
              text: mode === 'text-mismatch' ? 'changed text' : requestInput.text,
              text_elements: [],
            }],
          }],
          itemsView: 'full',
          status: 'inProgress',
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      },
    })
    return
  }

  if (frame.method === 'turn/steer') {
    send({ method: 'fake/write-seen', params: { method: frame.method, params: frame.params } })
    send({ id: frame.id, result: { turnId: frame.params.expectedTurnId } })
    return
  }

  if (frame.method === 'turn/interrupt') {
    send({ method: 'fake/write-seen', params: { method: frame.method, params: frame.params } })
    send({ id: frame.id, result: {} })
    return
  }

  if (frame.id !== undefined) {
    send({ id: frame.id, error: { code: -32601, message: 'unsupported' } })
  }
})
