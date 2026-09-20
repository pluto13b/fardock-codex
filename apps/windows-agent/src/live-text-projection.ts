import type { AssistantMessage } from '../../../packages/codex-serve-client/src/contracts.ts'
import type { Notification } from './supervisor.ts'

const MAX_TASKS = 256
const MAX_ITEMS = 16
const MAX_TASK_BYTES = 128 * 1024
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(value)
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export interface LiveTextSnapshot {
  readonly version: number
  readonly messages: readonly AssistantMessage[]
}

/** Display-only data from this supervisor; ownership is checked at every read. */
export function createLiveTextProjection(
  ownsTurn: (taskId: string, turnId: string) => boolean,
  onFirstSnapshot?: (durationMs: number) => void,
  onFirstText?: (durationMs: number) => void,
) {
  const tasks = new Map<string, {
    turnId: string; version: number; bytes: number
    items: Map<string, { text: string; bytes: number; truncated: boolean }>
    firstDeltaAt?: number
    reported?: boolean
    acceptedAt?: number
    textReported?: boolean
  }>()
  const reportFirstText = (task: NonNullable<ReturnType<typeof tasks.get>>) => {
    if (task.textReported || task.acceptedAt === undefined || task.firstDeltaAt === undefined) return
    task.textReported = true
    try { onFirstText?.(Math.max(0, task.firstDeltaAt - task.acceptedAt)) } catch { /* metrics only */ }
  }
  return {
    markAcceptedTurn(taskId: string, turnId: string) {
      if (!ownsTurn(taskId, turnId)) return
      let task = tasks.get(taskId)
      if (!task || task.turnId !== turnId) {
        if (!task && tasks.size >= MAX_TASKS) return
        task = { turnId, version: task?.version ?? 0, bytes: 0, items: new Map() }
        tasks.set(taskId, task)
      }
      if (task.acceptedAt !== undefined) return
      task.acceptedAt = Date.now()
      reportFirstText(task)
    },
    observe(notification: Notification) {
      const delta = notification.method === 'item/agentMessage/delta'
      const completed = notification.method === 'item/completed'
      if (!delta && !completed && notification.method !== 'item/started') return
      const params = object(notification.params)
      if (!params || !id(params.threadId) || !id(params.turnId)) return
      const item = object(params.item)
      if (!delta && item?.type !== 'agentMessage') return
      const itemId = delta ? params.itemId : item?.id
      const text = delta ? params.delta : item?.text
      if (!id(itemId) || typeof text !== 'string') return
      let task = tasks.get(params.threadId)
      if (!task) {
        if (tasks.size >= MAX_TASKS) return
        task = { turnId: params.turnId, version: 0, bytes: 0, items: new Map() }
        tasks.set(params.threadId, task)
      }
      if (task.turnId !== params.turnId) {
        if (ownsTurn(params.threadId, task.turnId) && !ownsTurn(params.threadId, params.turnId)) return
        task.turnId = params.turnId
        task.items.clear()
        task.bytes = 0
        task.firstDeltaAt = undefined
        task.reported = false
        task.acceptedAt = undefined
        task.textReported = false
      }
      const previous = task.items.get(itemId)
      if (!previous && task.items.size >= MAX_ITEMS) return
      if (delta && previous?.truncated) return
      const bytes = (delta ? previous?.bytes ?? 0 : 0) + Buffer.byteLength(text, 'utf8')
      if (bytes + task.bytes - (previous?.bytes ?? 0) > MAX_TASK_BYTES) {
        if (previous) previous.truncated = true
        else task.items.set(itemId, { text: '', bytes: 0, truncated: true })
        return
      }
      const next = delta ? (previous?.text ?? '') + text : text
      if (next === previous?.text) return
      task.bytes += bytes - (previous?.bytes ?? 0)
      task.items.set(itemId, { text: next, bytes, truncated: false })
      task.version += 1
      if (delta && text !== '' && task.firstDeltaAt === undefined) task.firstDeltaAt = Date.now()
      reportFirstText(task)
    },
    read(taskId: string): LiveTextSnapshot | undefined {
      const task = tasks.get(taskId)
      if (!task || !ownsTurn(taskId, task.turnId)) return undefined
      if (!task.reported && task.firstDeltaAt !== undefined) {
        task.reported = true
        try { onFirstSnapshot?.(Math.max(0, Date.now() - task.firstDeltaAt)) } catch { /* metrics do not affect the view */ }
      }
      return {
        version: task.version,
        messages: [...task.items].filter(([, item]) => item.text !== '').map(([itemId, item]) => ({
          id: itemId, turnId: task.turnId, kind: 'assistant', createdAt: null, markdown: item.text,
        })),
      }
    },
    clear() { tasks.clear() },
  }
}
