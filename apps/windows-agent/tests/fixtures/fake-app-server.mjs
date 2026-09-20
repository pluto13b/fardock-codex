import readline from 'node:readline'

const mode = process.argv[2] ?? 'normal'
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
const handshake = []
let initialized = false
let initializeParams
let serverAnswerCount = 0

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function afterInitialized() {
  send({
    method: 'fake/handshake',
    params: { order: [...handshake], initializeParams },
  })
  if (mode === 'malformed') process.stdout.write('{broken\n')
  if (mode === 'oversized') process.stdout.write(`${'x'.repeat(4096)}\n`)
  if (mode === 'binary') process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]))
  if (mode === 'primitive') process.stdout.write('42\n')
  if (mode === 'bom-jsonl') {
    process.stdout.write(Buffer.from([0xef, 0xbb, 0xbf]))
    send({ method: 'fake/bom-prefixed', params: {} })
  }
  if (mode === 'unknown-response') send({ id: 999999, result: {} })
  if (mode === 'early-exit-ready') process.exit(23)
  if (mode === 'stderr-bait') {
    process.stderr.write('RAW_STDERR_BAIT token=secret-token path=D:\\private\\bait prompt=BAIT_PROMPT\n')
  }
  if (mode === 'stderr-overflow') process.stderr.write('s'.repeat(4096))
  if (
    mode === 'server-known' ||
    mode === 'server-known-twice' ||
    mode === 'server-known-after-timeout'
  ) {
    send({
      id: 'server-approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'BAIT_COMMAND', reason: 'BAIT_PROMPT' },
    })
    if (mode === 'server-known-twice') {
      send({
        id: 'server-approval-2',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'SECOND_BAIT_COMMAND' },
      })
    }
    if (mode === 'server-known-after-timeout') {
      setTimeout(() => {
        send({
          id: 'server-approval-2',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'SECOND_BAIT_COMMAND' },
        })
      }, 80)
    }
  }
  if (mode === 'server-unknown') {
    send({ id: 71, method: 'account/chatgptAuthTokens/refresh', params: { bait: 'TOKEN_BAIT' } })
  }
  if (mode === 'server-duplicate-mixed') {
    const first = {
      id: 'server-duplicate-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'MUST_NOT_ACCEPT' },
    }
    const second = {
      id: 'server-duplicate-1',
      method: 'account/chatgptAuthTokens/refresh',
      params: { bait: 'TOKEN_BAIT' },
    }
    process.stdout.write(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)
  }
  if (mode === 'server-sequential-reuse') {
    send({
      id: 'server-reused-1',
      method: 'item/commandExecution/requestApproval',
      params: { sequence: 0 },
    })
  }
  if (mode === 'server-many-sequential') {
    send({
      id: 'server-sequential-0',
      method: 'item/commandExecution/requestApproval',
      params: { sequence: 0 },
    })
  }
  if (mode === 'notification-flood') {
    for (let index = 0; index < 8; index += 1) {
      send({ method: 'fake/notification', params: { index } })
    }
  }
  if (mode === 'shutdown-ignore') setInterval(() => undefined, 10_000)
}

function answerRequest(frame) {
  const result = { method: frame.method, params: frame.params, initialized }
  if (mode === 'timeout' && frame.method === 'thread/list') return
  if (mode === 'duplicate-response' && frame.method === 'thread/list') {
    send({ id: frame.id, result })
    setTimeout(() => send({ id: frame.id, result }), 5)
    return
  }
  if (mode === 'malformed-error' && frame.method === 'thread/list') {
    send({ id: frame.id, error: { code: 'not-a-number', message: 'bait' } })
    return
  }
  if (mode === 'out-of-order' && frame.method === 'thread/list') {
    setTimeout(() => send({ id: frame.id, result }), 40)
    return
  }
  if (frame.method === 'thread/read') {
    send({ method: 'thread/updated', params: { source: 'fake' } })
  }
  send({ id: frame.id, result })
}

input.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.exit(31)
  }

  if (frame.method === 'initialize') {
    handshake.push('initialize')
    initializeParams = frame.params
    if (mode === 'early-exit') process.exit(22)
    if (mode === 'preinit-notification') {
      send({ method: 'fake/too-early', params: {} })
    }
    const result = {
      userAgent: mode === 'init-user-agent-mismatch'
        ? 'codex_cli_rs/0.150.0-alpha.8 fake-app-server'
        : mode === 'init-user-agent-control'
          ? 'codex_cli_rs/0.151.0 fake\napp-server'
        : mode === 'init-own-user-agent'
          ? 'codex_plus/0.153.4 (Windows; codex_plus; 0.1.0)'
        : mode === 'init-own-unknown-version'
          ? 'codex_plus/0.154.0 (Windows; codex_plus; 0.1.0)'
        : mode === 'init-desktop-user-agent'
          ? 'Codex Desktop/0.151.0 (Windows 10; x86_64) test'
          : 'codex_cli_rs/0.151.0 fake-app-server',
      codexHome: mode === 'init-unsafe-home'
        ? '\\\\?\\C:\\private\\bait'
        : 'D:\\FakeCodexHome',
      platformFamily: mode === 'init-platform-mismatch' ? 'linux' : 'windows',
      platformOs: 'windows',
      ...(mode === 'init-unknown-field' ? { unknown: 'BAIT_UNKNOWN' } : {}),
    }
    if (mode === 'init-missing-field') delete result.platformOs
    if (mode === 'init-wrong-type') result.userAgent = 42
    if (mode === 'post-response-notification-same-chunk') {
      process.stdout.write(
        `${JSON.stringify({ id: frame.id, result })}\n${JSON.stringify({ method: 'account/updated', params: {} })}\n`,
      )
    } else {
      send({ id: frame.id, result })
    }
    return
  }

  if (frame.method === 'initialized' && frame.id === undefined) {
    handshake.push('initialized')
    initialized = true
    afterInitialized()
    return
  }

  if (frame.id !== undefined && frame.method !== undefined) {
    answerRequest(frame)
    return
  }

  if (frame.id !== undefined && frame.method === undefined) {
    send({ method: 'fake/server-answer', params: frame })
    serverAnswerCount += 1
    if (mode === 'server-sequential-reuse' && serverAnswerCount === 1) {
      send({
        id: 'server-reused-1',
        method: 'item/commandExecution/requestApproval',
        params: { sequence: 1 },
      })
    }
    if (mode === 'server-many-sequential' && serverAnswerCount < 40) {
      send({
        id: `server-sequential-${serverAnswerCount}`,
        method: 'item/commandExecution/requestApproval',
        params: { sequence: serverAnswerCount },
      })
    }
  }
})
