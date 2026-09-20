import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProductionDiagnosticLog } from '../src/production-diagnostics.ts'

const root = resolve(import.meta.dirname, '..', '..', '..', '.tmp', `diagnostics-${randomUUID()}`)

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('production diagnostic log', () => {
  it('writes only structured fixed fields and drains on close', async () => {
    const log = await createProductionDiagnosticLog(root)
    log.record({ event: 'request.completed', operation: 'task.read', outcome: 'succeeded', durationMs: 281 })
    log.record({ event: 'task.send-disabled', reason: 'status-syncing' })
    log.record({ event: 'app-server.request', method: 'turn/start', outcome: 'succeeded', durationMs: 23 })
    log.record({ event: 'request.boundary', outcome: 'succeeded', durationMs: 640 })
    log.record({ event: 'turn.first-text', durationMs: 7974 })
    await log.close()
    const lines = (await readFile(resolve(root, 'logs', 'companion.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'request.completed', operation: 'task.read', durationMs: 281 }),
      expect.objectContaining({ event: 'task.send-disabled', reason: 'status-syncing' }),
      expect.objectContaining({ event: 'app-server.request', method: 'turn/start', outcome: 'succeeded', durationMs: 23 }),
      expect.objectContaining({ event: 'request.boundary', durationMs: 640 }),
      expect.objectContaining({ event: 'turn.first-text', durationMs: 7974 }),
    ])
    expect(lines.join('\n')).not.toMatch(/task-id|prompt|password|ciphertext/i)
  })
})
