import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const MAX_DPAPI_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 4 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export class WindowsDpapiError extends Error {
  constructor(readonly code: string) {
    super(`windows-dpapi:${code}`)
    this.name = 'WindowsDpapiError'
  }
}

function fail(code: string): never {
  throw new WindowsDpapiError(code)
}

export interface WindowsDpapiOptions {
  powershellExecutable?: string
  scriptPath?: string
  timeoutMs?: number
}

function defaultPowerShell(): string {
  return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
}

async function runPowerShell(
  operation: 'protect' | 'unprotect' | 'restrict-file',
  input: Buffer | undefined,
  targetPath: string | undefined,
  options: WindowsDpapiOptions,
): Promise<Buffer> {
  if (process.platform !== 'win32') fail('unsupported-platform')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail('invalid-options')
  const executable = options.powershellExecutable ?? defaultPowerShell()
  const scriptPath = options.scriptPath ?? resolve(import.meta.dirname, '..', 'scripts', 'dpapi.ps1')
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Operation',
    operation,
    ...(targetPath === undefined ? [] : ['-TargetPath', targetPath]),
  ]

  return await new Promise<Buffer>((resolveResult, rejectResult) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const finish = (error?: WindowsDpapiError, value?: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const chunk of stdout) chunk.fill(0)
      if (error !== undefined) rejectResult(error)
      else if (value !== undefined) resolveResult(value)
      else rejectResult(new WindowsDpapiError('operation-failed'))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new WindowsDpapiError('timeout'))
    }, timeoutMs)
    child.stdout.on('data', chunk => {
      const bytes = Buffer.from(chunk)
      stdoutBytes += bytes.byteLength
      if (stdoutBytes > MAX_DPAPI_BYTES) {
        child.kill()
        finish(new WindowsDpapiError('output-too-large'))
        return
      }
      stdout.push(bytes)
    })
    child.stderr.on('data', chunk => {
      stderrBytes += Buffer.byteLength(chunk)
      if (stderrBytes > MAX_STDERR_BYTES) child.kill()
    })
    child.once('error', () => finish(new WindowsDpapiError('spawn-failed')))
    child.once('close', code => {
      if (code !== 0 || stderrBytes > MAX_STDERR_BYTES) {
        finish(new WindowsDpapiError('operation-failed'))
        return
      }
      const output = Buffer.concat(stdout)
      if (operation === 'restrict-file') {
        if (output.toString('utf8') !== 'ok') finish(new WindowsDpapiError('operation-failed'))
        else finish(undefined, Buffer.alloc(0))
        return
      }
      if (output.byteLength < 1 || output.byteLength > MAX_DPAPI_BYTES) {
        output.fill(0)
        finish(new WindowsDpapiError('invalid-output'))
        return
      }
      finish(undefined, output)
    })
    if (input === undefined) child.stdin.end()
    else child.stdin.end(input)
  })
}

export async function protectForCurrentWindowsUser(
  plaintext: Buffer,
  options: WindowsDpapiOptions = {},
): Promise<Buffer> {
  if (!Buffer.isBuffer(plaintext) || plaintext.byteLength < 1 || plaintext.byteLength > MAX_DPAPI_BYTES) {
    fail('invalid-input')
  }
  return await runPowerShell('protect', plaintext, undefined, options)
}

export async function unprotectForCurrentWindowsUser(
  ciphertext: Buffer,
  options: WindowsDpapiOptions = {},
): Promise<Buffer> {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1 || ciphertext.byteLength > MAX_DPAPI_BYTES) {
    fail('invalid-input')
  }
  return await runPowerShell('unprotect', ciphertext, undefined, options)
}

export async function restrictFileToCurrentWindowsUser(
  filePath: string,
  options: WindowsDpapiOptions = {},
): Promise<void> {
  if (typeof filePath !== 'string' || filePath.length < 1) fail('invalid-input')
  await runPowerShell('restrict-file', undefined, filePath, options)
}
