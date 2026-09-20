import { link, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { createOwnerPasswordVerifier } from './owner-auth.ts'

const MAX_STDIN_BYTES = 4 * 1_024

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function stdinJson(): Promise<Readonly<{ username: string; password: string }>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_STDIN_BYTES) throw new Error('invalid-input')
    chunks.push(value)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid-input')
  const record = parsed as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'password,username'
    || typeof record.username !== 'string'
    || typeof record.password !== 'string'
  ) throw new Error('invalid-input')
  return Object.freeze({ username: record.username, password: record.password })
}

async function run(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') throw new Error('invalid-arguments')
  const output = resolve(process.argv[3]!)
  if (!isAbsolute(output)) throw new Error('invalid-output')
  const projectRoot = await realpath(resolve(import.meta.dirname, '..', '..', '..'))
  const temporaryRoot = resolve(projectRoot, '.tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const canonicalTemporaryRoot = await realpath(temporaryRoot)
  if (!within(canonicalTemporaryRoot, output) || output === canonicalTemporaryRoot) {
    throw new Error('invalid-output')
  }
  await mkdir(dirname(output), { recursive: true })
  const input = await stdinJson()
  const verifier = await createOwnerPasswordVerifier(input)
  const temporary = `${output}.${process.pid}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(verifier)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, output)
    await unlink(temporary)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  process.stdout.write(`${JSON.stringify({ event: 'owner.verifier.created', file: output })}\n`)
}

void run().catch(() => {
  process.stderr.write(`${JSON.stringify({ event: 'owner.verifier.failed' })}\n`)
  process.exitCode = 1
})
