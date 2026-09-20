import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { createOwnerPasswordVerifier } from '../src/owner-auth.ts'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const tsxCli = fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url))
const testRoot = fileURLToPath(new URL('../../../.tmp/relay-cli-tests/', import.meta.url))
const children = new Set<ChildProcessWithoutNullStreams>()

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing-test-port')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

function baseEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TMP: testRoot,
    TEMP: testRoot,
  }
}

function launch(environment: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [tsxCli, 'src/production-cli.ts'], {
    cwd: packageRoot,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  return child
}

async function waitForLine(
  stream: NodeJS.ReadableStream,
  predicate: (line: string) => boolean,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('cli-output-timeout')), 5_000)
    stream.on('data', chunk => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!predicate(line)) continue
        clearTimeout(timer)
        resolve(line)
        return
      }
    })
    stream.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  if (child.signalCode !== null) return null
  return await new Promise(resolve => child.once('exit', code => resolve(code)))
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await waitForExit(child).catch(() => undefined)
  }
  children.clear()
  await rm(testRoot, { recursive: true, force: true })
})

describe('production Gateway CLI', () => {
  it('fails with a fixed error when explicit production configuration is absent', async () => {
    await mkdir(testRoot, { recursive: true })
    const child = launch({ ...baseEnvironment(), NODE_ENV: 'production' })
    const stderr = await waitForLine(child.stderr, line => line.includes('gateway.start_failed'))
    expect(JSON.parse(stderr)).toEqual({ event: 'gateway.start_failed', reason: 'configuration' })
    expect(await waitForExit(child)).toBe(1)
  })

  it('starts the standalone process and serves health without Vite or local-runner', async () => {
    const directory = join(testRoot, 'valid')
    const webRoot = join(directory, 'web')
    const secretFile = join(directory, 'relay-bootstrap')
    const ownerVerifierFile = join(directory, 'owner-verifier.json')
    await mkdir(join(webRoot, 'assets'), { recursive: true })
    await writeFile(
      join(webRoot, 'index.html'),
      '<!doctype html><title>Codex Plus</title><script type="module" src="/assets/app.js"></script>',
      'utf8',
    )
    await writeFile(join(webRoot, 'assets', 'app.js'), 'globalThis.__GATEWAY_CLI_TEST__=true', 'utf8')
    await writeFile(secretFile, Buffer.alloc(32, 0x65).toString('base64url'), 'utf8')
    await writeFile(ownerVerifierFile, JSON.stringify(await createOwnerPasswordVerifier({
      username: 'owner',
      password: 'test owner password',
    }, () => Buffer.alloc(16, 5))), 'utf8')
    const port = await availablePort()
    const child = launch({
      ...baseEnvironment(),
      CODEX_PLUS_MODE: 'production',
      CODEX_PLUS_BIND: '127.0.0.1',
      CODEX_PLUS_PORT: String(port),
      CODEX_PLUS_PUBLIC_ORIGIN: 'https://gateway.example.test',
      CODEX_PLUS_TRUSTED_PROXY_IPS: '127.0.0.1',
      CODEX_PLUS_STATE_FILE: join(directory, 'data', 'relay-state.json'),
      CODEX_PLUS_WEB_ROOT: webRoot,
      CODEX_PLUS_BOOTSTRAP_CREDENTIAL_FILE: secretFile,
      CODEX_PLUS_OWNER_VERIFIER_FILE: ownerVerifierFile,
      CODEX_PLUS_LOG_LEVEL: 'info',
    })
    const started = await waitForLine(child.stdout, line => line.includes('relay.started'))
    expect(JSON.parse(started)).toMatchObject({ event: 'relay.started' })
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(await health.text()).toBe('{"status":"ok"}')
    child.kill()
  })
})
