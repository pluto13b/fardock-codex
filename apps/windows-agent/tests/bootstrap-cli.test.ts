import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const testRoot = join(workspaceRoot, '.tmp', 'bootstrap-cli-tests', randomUUID())
const identityFile = join(testRoot, 'identity.dpapi')
const exportFile = join(testRoot, 'relay-bootstrap')
const tsxCli = join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const cli = fileURLToPath(new URL('../src/bootstrap-cli.ts', import.meta.url))

async function run(command: string, includeExport: boolean): Promise<Readonly<{
  code: number | null
  stdout: string
  stderr: string
}>> {
  const args = [
    tsxCli,
    cli,
    command,
    '--workspace-root',
    workspaceRoot,
    '--identity-file',
    identityFile,
    ...(includeExport ? ['--export-file', exportFile] : []),
  ]
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspaceRoot,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TMP: join(workspaceRoot, '.tmp'),
        TEMP: join(workspaceRoot, '.tmp'),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.once('error', reject)
    child.once('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true })
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('Windows bootstrap CLI', () => {
  it('creates, inspects, and consumes bootstrap without printing the credential', async () => {
    const created = await run('create', true)
    expect(created.code).toBe(0)
    const createdEvent = JSON.parse(created.stdout)
    expect(createdEvent).toMatchObject({ event: 'bootstrap.created' })
    const credential = await readFile(exportFile, 'utf8')
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(`${created.stdout}${created.stderr}`).not.toContain(credential)

    const duplicate = await run('create', true)
    expect(duplicate.code).toBe(1)
    expect(duplicate.stderr).toBe('{"event":"bootstrap.failed"}\n')
    expect(await readFile(exportFile, 'utf8')).toBe(credential)

    const before = await run('inspect', false)
    expect(JSON.parse(before.stdout)).toMatchObject({
      event: 'bootstrap.identity',
      bootstrapPresent: true,
    })
    expect((await run('mark-registered', false)).code).toBe(0)
    const after = await run('inspect', false)
    expect(JSON.parse(after.stdout)).toMatchObject({
      event: 'bootstrap.identity',
      bootstrapPresent: false,
    })
  }, 30_000)
})
