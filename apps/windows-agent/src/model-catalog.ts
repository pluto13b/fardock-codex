import { ModelCatalogSchema } from '../../../packages/protocol/src/index.ts'
import type { ModelOption } from '../../../packages/codex-serve-client/src/index.ts'
import type { AppServerSupervisor } from './supervisor.ts'

const CACHE_MS = 30_000
const catalogs = new WeakMap<AppServerSupervisor, { loadedAt: number; pending: Promise<readonly ModelOption[]> }>()

/** Only the owned app-server discovers models; no API credentials or display-name mapping. */
export function readModelCatalog(supervisor: AppServerSupervisor): Promise<readonly ModelOption[]> {
  const cached = catalogs.get(supervisor)
  if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.pending
  const pending = load(supervisor)
  const entry = { loadedAt: Date.now(), pending }
  catalogs.set(supervisor, entry)
  void pending.catch(() => { if (catalogs.get(supervisor) === entry) catalogs.delete(supervisor) })
  return pending
}

async function load(supervisor: AppServerSupervisor): Promise<readonly ModelOption[]> {
  const models: unknown[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 4; page += 1) {
    const result = await supervisor.request<unknown>('model/list', {
      limit: 32, includeHidden: false, ...(cursor === undefined ? {} : { cursor }),
    })
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('model-catalog:invalid')
    const record = result as Record<string, unknown>
    if (!Array.isArray(record.data) || record.data.length > 128) throw new Error('model-catalog:invalid')
    for (const value of record.data) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('model-catalog:invalid')
      const model = value as Record<string, unknown>
      if (typeof model.hidden !== 'boolean') throw new Error('model-catalog:invalid')
      if (model.hidden) continue
      models.push({
        id: model.model,
        displayName: model.displayName,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.map(option => option?.reasoningEffort) : undefined,
        isDefault: model.isDefault,
      })
      if (models.length > 128) throw new Error('model-catalog:capacity')
    }
    if (record.nextCursor === null) {
      const parsed = ModelCatalogSchema.parse(models)
      return Object.freeze(parsed.map(model => Object.freeze({
        ...model,
      })))
    }
    if (typeof record.nextCursor !== 'string' || record.nextCursor.length > 512 || cursors.has(record.nextCursor)) throw new Error('model-catalog:invalid')
    cursor = record.nextCursor
    cursors.add(cursor)
  }
  throw new Error('model-catalog:capacity')
}

export async function requireModelSettings(supervisor: AppServerSupervisor, settings: { model: string; effort: string }): Promise<void> {
  const models = await readModelCatalog(supervisor)
  if (!models.some(model => model.id === settings.model && model.supportedReasoningEfforts.includes(settings.effort))) {
    throw new Error('model-catalog:unsupported')
  }
}
