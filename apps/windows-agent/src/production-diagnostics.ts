import { appendFile, lstat, mkdir, rename, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'

const MAX_LOG_BYTES = 1024 * 1024

export type ProductionDiagnosticEvent = Readonly<{
  event: 'host.connected' | 'host.reconnect' | 'session.ready' | 'session.handshake-failed'
    | 'read.failed' | 'task.send-disabled' | 'app-server.failed' | 'request.completed'
    | 'text.first-snapshot' | 'request.boundary' | 'app-server.request' | 'turn.first-text'
  operation?: 'model.list' | 'manage.read' | 'workspace.list' | 'task.list' | 'task.read' | 'other'
  stage?: string
  category?: string
  reason?: string
  outcome?: 'succeeded' | 'failed' | 'timed-out'
  method?: import('./supervisor.ts').AppServerMethod | 'initialize'
  durationMs?: number
  frameBytes?: number
  generation?: number
}>

export interface ProductionDiagnosticLog {
  record(event: ProductionDiagnosticEvent): void
  close(): Promise<void>
}

async function rotate(file: string): Promise<void> {
  const size = await lstat(file).then(value => value.size).catch(() => 0)
  if (size < MAX_LOG_BYTES) return
  await unlink(`${file}.2`).catch(() => undefined)
  await rename(`${file}.1`, `${file}.2`).catch(() => undefined)
  await rename(file, `${file}.1`).catch(() => undefined)
}

export async function createProductionDiagnosticLog(stateDirectory: string): Promise<ProductionDiagnosticLog> {
  const directory = resolve(stateDirectory, 'logs')
  const file = resolve(directory, 'companion.jsonl')
  await mkdir(directory, { recursive: true })
  let pending = Promise.resolve()
  let closed = false
  return Object.freeze({
    record(event: ProductionDiagnosticEvent) {
      if (closed) return
      const entry = { timestamp: Date.now(), ...event }
      pending = pending.then(async () => {
        await rotate(file)
        await appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
      }).catch(() => undefined)
    },
    async close() {
      closed = true
      await pending
    },
  })
}
