import type { CodexServeClient, TaskSummary } from '@codex-plus/serve-client'

/** Listing registers the projects on the Host; fetch their labels afterwards. */
export async function readTaskPage(client: CodexServeClient, cursor?: string, visitedCursors?: ReadonlySet<string>) {
  const page = await client.listTasks(cursor)
  if (page.nextCursor !== undefined && (page.nextCursor === cursor || visitedCursors?.has(page.nextCursor))) {
    throw new Error('任务分页未前进，请稍后重试。')
  }
  const workspaces = await client.listWorkspaces()
  return { ...page, workspaces }
}

export function mergeTaskSummaries(current: readonly TaskSummary[], incoming: readonly TaskSummary[]): TaskSummary[] {
  const tasks = new Map(current.map(task => [task.id, task]))
  for (const task of incoming) tasks.set(task.id, task)
  return [...tasks.values()]
}
