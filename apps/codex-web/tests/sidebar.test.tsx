import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { createFixtureCodexServeClient } from '../../../packages/codex-serve-client/src/fixture.ts'
import { Sidebar } from '../src/Sidebar.tsx'

it('shows every real project before expanding any long task list', async () => {
  const fixture = createFixtureCodexServeClient()
  const [baseWorkspace] = await fixture.listWorkspaces()
  const { tasks: baseTasks } = await fixture.listTasks()
  const workspaces = Array.from({ length: 14 }, (_, index) => ({ ...baseWorkspace!, id: `project.${index}`, name: `项目 ${index + 1}` }))
  const tasks = Array.from({ length: 150 }, (_, index) => ({ ...baseTasks[0]!, id: `task.${index}`, workspaceId: workspaces[index < 100 ? 0 : index % 14]!.id }))
  const markup = renderToStaticMarkup(createElement(Sidebar, {
    workspaces, tasks, directoryPending: false, moreTasksControl: null, connection: 'online', activeTaskId: tasks[0]!.id,
    canStartTask: false, onNewTask() {}, onPickTask() {}, onClose() {},
  }))
  expect(markup.match(/aria-label="打开项目 /gu)).toHaveLength(14)
  expect(markup).toContain('全部项目')
  expect(markup).not.toContain('cp-task-row')
  expect(markup).toContain('搜索项目或任务')
})
