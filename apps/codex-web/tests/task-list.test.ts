import { describe, expect, it, vi } from 'vitest'
import { createFixtureCodexServeClient } from '../../../packages/codex-serve-client/src/fixture.ts'
import { readTaskPage, mergeTaskSummaries } from '../src/task-list.ts'

describe('all-project task pages', () => {
  it('reads project labels after discovery and exposes every next cursor beyond ten pages', async () => {
    const client = createFixtureCodexServeClient()
    let discovered = 0
    vi.spyOn(client, 'listTasks').mockImplementation(async cursor => {
      discovered = cursor === undefined ? 1 : Number(cursor)
      return { tasks: [], ...(discovered === 12 ? {} : { nextCursor: String(discovered + 1) }) }
    })
    const labels = vi.spyOn(client, 'listWorkspaces').mockImplementation(async () => {
      expect(discovered).toBeGreaterThan(0)
      return [{ id: `project.${discovered}`, name: 'Project', pathLabel: 'Project', hostId: 'host.test', connectionGeneration: 1, connection: 'online', capabilities: { startTask: false } }]
    })
    let cursor: string | undefined
    do {
      const page = await readTaskPage(client, cursor)
      expect(page.workspaces[0]?.id).toBe(`project.${discovered}`)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    expect(labels).toHaveBeenCalledTimes(12)
  })

  it('merges overlapping task pages without losing the selected task from an earlier page', async () => {
    const client = createFixtureCodexServeClient()
    const { tasks } = await client.listTasks()
    const selected = tasks[0]!
    const updated = { ...selected, title: 'Updated', revision: selected.revision + 1 }
    const result = mergeTaskSummaries(tasks, [updated])
    expect(result).toHaveLength(tasks.length)
    expect(result[0]).toEqual(updated)
    expect(result.slice(1)).toEqual(tasks.slice(1))
  })

  it('rejects an unchanged cursor and lets the caller retry a failed page', async () => {
    const client = createFixtureCodexServeClient()
    const list = vi.spyOn(client, 'listTasks').mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce({ tasks: [], nextCursor: 'next' }).mockResolvedValue({ tasks: [] })
    await expect(readTaskPage(client, 'next')).rejects.toThrow('disconnected')
    await expect(readTaskPage(client, 'next')).rejects.toThrow('任务分页未前进')
    await expect(readTaskPage(client, 'next')).resolves.toMatchObject({ tasks: [] })
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('rejects a multi-page cursor cycle before it can continuously reload the directory', async () => {
    const client = createFixtureCodexServeClient()
    vi.spyOn(client, 'listTasks').mockResolvedValue({ tasks: [], nextCursor: 'page-a' })
    await expect(readTaskPage(client, 'page-b', new Set(['page-a']))).rejects.toThrow('任务分页未前进')
  })
})
