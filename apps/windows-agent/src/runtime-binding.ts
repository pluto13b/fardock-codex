import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process'
import { win32 as windowsPath } from 'node:path'
import type { Readable } from 'node:stream'
import { TextDecoder } from 'node:util'

import type { AppServerSupervisor, ChildCommand } from './supervisor.ts'

export const APP_SERVER_SCHEMA_VERSION = '0.153.4' as const

const PROBE_TIMEOUT_MS = 5_000
const PROBE_TERMINATION_GRACE_MS = 100
const PROBE_STREAM_LIMIT_BYTES = 4 * 1024
const COMPATIBLE_VERSIONS = ['0.151.0', APP_SERVER_SCHEMA_VERSION] as const
const EXPECTED_USER_AGENT = /^(?:codex_plus|codex_cli_rs|Codex Desktop)\/(0\.151\.0|0\.153\.4)(?:$| )/

const COMPATIBLE_CAPABILITIES = Object.freeze({
  resumeThread: true,
  sendTextTurn: true,
  streamCore: true,
  interruptTurn: true,
  steerTurn: true,
  attachments: true,
  resolveServerRequest: false,
} as const)

export type RuntimeBindingFailure =
  | 'supervisor-not-ready'
  | 'app-server-command-mismatch'
  | 'unsafe-executable-path'
  | 'version-probe-spawn-failed'
  | 'version-probe-timeout'
  | 'version-probe-output-overflow'
  | 'version-probe-termination-failed'
  | 'version-probe-exit-failed'
  | 'version-mismatch'
  | 'initialize-response-invalid'
  | 'user-agent-mismatch'
  | 'platform-mismatch'
  | 'lifecycle-changed'

export type RuntimeCompatibleCapabilities = typeof COMPATIBLE_CAPABILITIES

export type RuntimeCompatibility =
  | {
      readonly state: 'write-bound'
      readonly schemaVersion: typeof APP_SERVER_SCHEMA_VERSION
      readonly supervisorGeneration: number
      readonly capabilities: RuntimeCompatibleCapabilities
    }
  | {
      readonly state: 'read-only'
      readonly supervisorGeneration: number
      readonly reason: RuntimeBindingFailure
    }

export interface RuntimeBindingSource {
  readonly owner: object
  readonly generation: number
  readonly command: ChildCommand
  readonly initialize?: {
    readonly userAgent: string
    readonly platformFamily: string
    readonly platformOs: string
    readonly codexHomeValidated: true
  }
  readonly isCurrent: () => boolean
}

type EvaluationOutcome =
  | { readonly compatible: true; readonly generation: number }
  | {
      readonly compatible: false
      readonly generation: number
      readonly reason: RuntimeBindingFailure
    }

export type RuntimeBindingEvaluation = Readonly<EvaluationOutcome>

type ProbeOutcome =
  | { readonly matched: true }
  | { readonly matched: false; readonly reason: RuntimeBindingFailure }

type TestRequesterOptions = {
  readonly commandMatches: boolean
  readonly executablePathSafe: boolean
  readonly probe: ProbeOutcome | (() => ProbeOutcome | Promise<ProbeOutcome>)
}

/** Package-private test facts. This symbol is intentionally not re-exported by src/index.ts. */
export interface RuntimeBindingTestFacts {
  readonly commandMatches?: boolean
  readonly executablePathSafe?: boolean
  readonly probe?:
    | 'matched'
    | 'spawn-failed'
    | 'timeout'
    | 'overflow'
    | 'termination-failed'
    | 'exit-failed'
    | 'mismatch'
}

const requesterOptions = new WeakMap<object, TestRequesterOptions | null>()
const authenticEvaluations = new WeakMap<object, object>()
const currentBindings = new WeakMap<object, RuntimeCompatibility>()
const bindingAttempts = new WeakMap<object, Promise<RuntimeCompatibility>>()
const bindingMetadata = new WeakMap<object, {
  readonly owner: object
  readonly generation: number
  readonly writeBound: boolean
}>()
const productionRequester = Object.freeze({})
requesterOptions.set(productionRequester, null)

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function isReservedWindowsSegment(segment: string): boolean {
  const basename = segment.split('.')[0]?.toUpperCase()
  return (
    basename === 'CON' ||
    basename === 'PRN' ||
    basename === 'AUX' ||
    basename === 'NUL' ||
    basename === 'CONIN$' ||
    basename === 'CONOUT$' ||
    /^COM(?:[1-9]|[¹²³])$/.test(basename ?? '') ||
    /^LPT(?:[1-9]|[¹²³])$/.test(basename ?? '')
  )
}

export function isSafeAbsoluteWindowsPath(value: string): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    /[\u0001-\u001f\u007f<>"|?*]/.test(value) ||
    value.includes('/') ||
    !/^[A-Za-z]:\\/.test(value) ||
    !windowsPath.isAbsolute(value) ||
    value.slice(2).includes(':')
  ) {
    return false
  }
  const root = windowsPath.parse(value).root
  if (root.length === 0 || windowsPath.normalize(value) === root) return false
  const segments = value.slice(root.length).split('\\')
  if (segments.length === 0) return false
  return segments.every(
    (segment) => (
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.endsWith('.') &&
      !segment.endsWith(' ') &&
      !isReservedWindowsSegment(segment)
    ),
  )
}

function exactAppServerCommand(command: ChildCommand): boolean {
  return command.args.length === 1 && command.args[0] === 'app-server'
}

function canonicalVersionOutput(stdout: Buffer, expectedVersion?: string): boolean {
  let decoded: string
  try {
    decoded = fatalUtf8Decoder.decode(stdout)
  } catch {
    return false
  }
  return COMPATIBLE_VERSIONS.some(version => {
    if (expectedVersion !== undefined && version !== expectedVersion) return false
    const line = `codex-cli ${version}`
    return decoded === line || decoded === `${line}\n` || decoded === `${line}\r\n`
  })
}

type ProbeChild = ChildProcessByStdio<null, Readable, Readable>
type ProbeSpawner = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ProbeChild

const nativeProbeSpawner: ProbeSpawner = (executable, args, options) => (
  spawn(executable, [...args], options) as ProbeChild
)

async function runVersionProbeWith(
  command: ChildCommand,
  spawnProbe: ProbeSpawner,
  timeoutMs: number,
  expectedVersion?: string,
): Promise<ProbeOutcome> {
  let child: ProbeChild
  try {
    child = spawnProbe(command.executable, ['--version'], {
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return Object.freeze({ matched: false, reason: 'version-probe-spawn-failed' })
  }
  return new Promise<ProbeOutcome>((resolve) => {
    let stdout = Buffer.alloc(0)
    let stderrBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let terminationReason: RuntimeBindingFailure | undefined
    let terminationAttempts = 0
    const onStdout = (chunk: Buffer) => {
      if (settled || terminationReason !== undefined || !Buffer.isBuffer(chunk)) return
      if (stdout.length + chunk.length > PROBE_STREAM_LIMIT_BYTES) {
        terminate('version-probe-output-overflow')
        return
      }
      stdout = Buffer.concat([stdout, chunk])
    }
    const onStderr = (chunk: Buffer) => {
      if (settled || terminationReason !== undefined || !Buffer.isBuffer(chunk)) return
      stderrBytes += chunk.length
      if (stderrBytes > PROBE_STREAM_LIMIT_BYTES) {
        terminate('version-probe-output-overflow')
      }
    }
    const onError = () => {
      if (settled || terminationReason !== undefined) return
      if (child.pid === undefined) {
        finish({ matched: false, reason: 'version-probe-spawn-failed' }, true)
        return
      }
      terminate('version-probe-spawn-failed')
    }
    const onClose = (code: number | null) => {
      if (terminationReason !== undefined) {
        finish({ matched: false, reason: terminationReason })
        return
      }
      if (code !== 0) {
        finish({ matched: false, reason: 'version-probe-exit-failed' })
        return
      }
      finish(
        canonicalVersionOutput(stdout, expectedVersion)
          ? { matched: true }
          : { matched: false, reason: 'version-mismatch' },
      )
    }
    const cleanup = (absorbLateChildErrors: boolean) => {
      if (timer !== undefined) clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      child.stderr.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      if (absorbLateChildErrors) {
        const lateErrorSink = () => undefined
        const removeLateErrorSink = () => child.removeListener('error', lateErrorSink)
        child.on('error', lateErrorSink)
        child.once('close', removeLateErrorSink)
      }
      child.stdout.destroy()
      child.stderr.destroy()
    }
    const finish = (outcome: ProbeOutcome, absorbLateChildErrors = false) => {
      if (settled) return
      settled = true
      cleanup(absorbLateChildErrors)
      resolve(Object.freeze(outcome))
    }
    const terminate = (reason: RuntimeBindingFailure) => {
      if (settled) return
      if (terminationReason !== undefined) return
      terminationReason = reason
      if (timer !== undefined) clearTimeout(timer)
      const attemptTermination = () => {
        if (settled) return
        terminationAttempts += 1
        try {
          child.kill()
        } catch {
          // A bounded second attempt and final read-only result remain authoritative.
        }
        if (settled) return
        timer = setTimeout(() => {
          if (settled) return
          if (terminationAttempts < 2) {
            attemptTermination()
            return
          }
          finish(
            { matched: false, reason: 'version-probe-termination-failed' },
            true,
          )
        }, PROBE_TERMINATION_GRACE_MS)
      }
      attemptTermination()
    }
    child.stdout.on('data', onStdout)
    child.stderr.on('data', onStderr)
    child.on('error', onError)
    child.on('close', onClose)
    timer = setTimeout(() => terminate('version-probe-timeout'), timeoutMs)
  })
}

function runVersionProbe(command: ChildCommand, expectedVersion: string): Promise<ProbeOutcome> {
  return runVersionProbeWith(command, nativeProbeSpawner, PROBE_TIMEOUT_MS, expectedVersion)
}

/** Package-private low-level probe seam. It is deliberately absent from src/index.ts. */
export async function runVersionProbeForTest(
  command: ChildCommand,
  spawnProbe: ProbeSpawner,
  timeoutMs = 25,
): Promise<'matched' | RuntimeBindingFailure> {
  const outcome = await runVersionProbeWith(command, spawnProbe, timeoutMs)
  return outcome.matched ? 'matched' : outcome.reason
}

function failed(generation: number, reason: RuntimeBindingFailure): RuntimeBindingEvaluation {
  return Object.freeze({ compatible: false, generation, reason })
}

export async function evaluateRuntimeBindingSource(
  requester: object,
  source: RuntimeBindingSource,
): Promise<RuntimeBindingEvaluation> {
  const options = requesterOptions.get(requester)
  if (options === undefined || typeof source !== 'object' || source === null) {
    throw new Error('Runtime compatibility evaluation is not available.')
  }
  const generation = source.generation
  let outcome: RuntimeBindingEvaluation
  if (!Number.isSafeInteger(generation) || generation <= 0 || !source.isCurrent()) {
    outcome = failed(Number.isSafeInteger(generation) ? generation : 0, 'supervisor-not-ready')
  } else if (source.initialize === undefined || source.initialize.codexHomeValidated !== true) {
    outcome = failed(generation, 'initialize-response-invalid')
  } else if (!EXPECTED_USER_AGENT.test(source.initialize.userAgent)) {
    outcome = failed(generation, 'user-agent-mismatch')
  } else if (/[\u0000-\u001f\u007f]/.test(source.initialize.userAgent)) {
    outcome = failed(generation, 'user-agent-mismatch')
  } else if (
    source.initialize.platformFamily !== 'windows' ||
    source.initialize.platformOs !== 'windows'
  ) {
    outcome = failed(generation, 'platform-mismatch')
  } else if (!(options?.commandMatches ?? exactAppServerCommand(source.command))) {
    outcome = failed(generation, 'app-server-command-mismatch')
  } else if (!(options?.executablePathSafe ?? isSafeAbsoluteWindowsPath(source.command.executable))) {
    outcome = failed(generation, 'unsafe-executable-path')
  } else {
    const probe = options === null
      ? await runVersionProbe(source.command, EXPECTED_USER_AGENT.exec(source.initialize.userAgent)![1]!)
      : await (typeof options.probe === 'function' ? options.probe() : options.probe)
    if (!probe.matched) {
      outcome = failed(generation, probe.reason)
    } else if (!source.isCurrent()) {
      outcome = failed(generation, 'lifecycle-changed')
    } else {
      outcome = Object.freeze({ compatible: true, generation })
    }
  }
  authenticEvaluations.set(outcome, source.owner)
  return outcome
}

function issueReadOnly(
  supervisor: object,
  generation: number,
  reason: RuntimeBindingFailure,
): RuntimeCompatibility {
  const compatibility = Object.freeze({
    state: 'read-only' as const,
    supervisorGeneration: Number.isSafeInteger(generation) && generation > 0 ? generation : 0,
    reason,
  })
  currentBindings.set(supervisor, compatibility)
  bindingMetadata.set(compatibility, {
    owner: supervisor,
    generation: compatibility.supervisorGeneration,
    writeBound: false,
  })
  return compatibility
}

async function establishWithRequester(
  supervisor: AppServerSupervisor,
  requester: object,
): Promise<RuntimeCompatibility> {
  let evaluation: RuntimeBindingEvaluation
  try {
    evaluation = await supervisor.evaluateRuntimeCompatibility(requester)
  } catch {
    return issueReadOnly(supervisor, supervisor.generation, 'supervisor-not-ready')
  }
  if (authenticEvaluations.get(evaluation) !== supervisor) {
    return issueReadOnly(supervisor, supervisor.generation, 'initialize-response-invalid')
  }
  if (!evaluation.compatible) {
    return issueReadOnly(supervisor, evaluation.generation, evaluation.reason)
  }
  if (
    supervisor.generation !== evaluation.generation ||
    supervisor.state !== 'ready' ||
    !supervisor.ownsLiveChild
  ) {
    return issueReadOnly(supervisor, evaluation.generation, 'lifecycle-changed')
  }
  const compatibility = Object.freeze({
    state: 'write-bound' as const,
    schemaVersion: APP_SERVER_SCHEMA_VERSION,
    supervisorGeneration: evaluation.generation,
    capabilities: COMPATIBLE_CAPABILITIES,
  })
  currentBindings.set(supervisor, compatibility)
  bindingMetadata.set(compatibility, {
    owner: supervisor,
    generation: evaluation.generation,
    writeBound: true,
  })
  return compatibility
}

export function establishRuntimeCompatibility(
  supervisor: AppServerSupervisor,
): Promise<RuntimeCompatibility> {
  const existing = bindingAttempts.get(supervisor)
  if (existing !== undefined) return existing
  const attempt = establishWithRequester(supervisor, productionRequester)
  bindingAttempts.set(supervisor, attempt)
  return attempt
}

/** Package-private test seam. It is deliberately absent from the package root export. */
export function establishRuntimeCompatibilityForTest(
  supervisor: AppServerSupervisor,
  facts: RuntimeBindingTestFacts = {},
): Promise<RuntimeCompatibility> {
  const existing = bindingAttempts.get(supervisor)
  if (existing !== undefined) return existing
  const requester = Object.freeze({})
  const probeReason = {
    'spawn-failed': 'version-probe-spawn-failed',
    timeout: 'version-probe-timeout',
    overflow: 'version-probe-output-overflow',
    'termination-failed': 'version-probe-termination-failed',
    'exit-failed': 'version-probe-exit-failed',
    mismatch: 'version-mismatch',
  } as const
  const selectedProbe = facts.probe ?? 'matched'
  requesterOptions.set(requester, {
    commandMatches: facts.commandMatches ?? true,
    executablePathSafe: facts.executablePathSafe ?? true,
    probe: selectedProbe === 'matched'
      ? Object.freeze({ matched: true })
      : Object.freeze({ matched: false, reason: probeReason[selectedProbe] }),
  })
  const attempt = establishWithRequester(supervisor, requester)
  bindingAttempts.set(supervisor, attempt)
  return attempt
}

export function isRuntimeCompatibilityCurrent(
  supervisor: AppServerSupervisor,
  compatibility: RuntimeCompatibility,
): boolean {
  const metadata = bindingMetadata.get(compatibility)
  return (
    metadata !== undefined &&
    metadata.owner === supervisor &&
    metadata.writeBound &&
    currentBindings.get(supervisor) === compatibility &&
    metadata.generation === supervisor.generation &&
    supervisor.state === 'ready' &&
    supervisor.ownsLiveChild
  )
}
