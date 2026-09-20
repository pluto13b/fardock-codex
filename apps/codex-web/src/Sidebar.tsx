import { useState, type ReactNode } from 'react'
import type { TaskSummary, WorkspaceSummary } from '@codex-plus/serve-client'
import sidebarCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-sidebar/src/client/SidebarRoot.module.css'
import rowsCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-workspace/src/client/rows/Rows.module.css'
import { IconChevronRightOutline14, IconCloseOutline16, IconFolderOpen16, IconNewChatOutline16, IconSearchOutline16, IconSettingsOutline16 } from './vendor/dsh-icons/index.tsx'

export function Sidebar({ workspaces, tasks, directoryPending, moreTasksControl, connection, activeTaskId, canStartTask, onNewTask, onPickTask, onClose, managementHref = '/manage' }: {
  managementHref?: string
  workspaces: WorkspaceSummary[]
  tasks: TaskSummary[]
  directoryPending: boolean
  moreTasksControl: ReactNode
  connection: WorkspaceSummary['connection']
  activeTaskId: string
  canStartTask: boolean
  onNewTask: () => void
  onPickTask: (taskId: string) => void
  onClose?: () => void
}) {
  const [projectId, setProjectId] = useState<string>()
  const [query, setQuery] = useState('')
  const search = query.trim().toLocaleLowerCase()
  const currentProjectId = tasks.find(task => task.id === activeTaskId)?.workspaceId
  const selected = workspaces.find(workspace => workspace.id === projectId)
  const matchesName = (name: string) => name.toLocaleLowerCase().includes(search)
  const projectTasks = (workspace: WorkspaceSummary) => tasks.filter(task => task.workspaceId === workspace.id && (matchesName(workspace.name) || matchesName(task.title)))
  const visibleProjects = workspaces.filter(workspace => matchesName(workspace.name) || projectTasks(workspace).length > 0)
  const visibleTasks = selected === undefined ? [] : projectTasks(selected)

  return <div className={`${sidebarCss.root} cp-sidebar`}>
    <div className={sidebarCss.logoRow}>
      <button type="button" className={`${sidebarCss.brand} ${sidebarCss.wide}`} disabled={!activeTaskId} onClick={() => onPickTask(activeTaskId)}>
        <span className={sidebarCss.brandIdentity}><span className="cp-logo-mark" aria-hidden="true">⌘</span><span className={sidebarCss.brandName}>Codex Plus</span></span>
      </button>
      {onClose && <button type="button" className={`${sidebarCss.iconButton} cp-mobile-only`} aria-label="关闭任务栏" onClick={onClose}><IconCloseOutline16 /></button>}
    </div>
    <button type="button" className={sidebarCss.newSession} disabled={!canStartTask} onClick={onNewTask} title={canStartTask ? '创建新任务' : '当前主机不允许新建任务'}>
      <IconNewChatOutline16 size={14} /><span className={sidebarCss.newSessionLabel}>新建任务</span>
    </button>
    <div className="cp-search" role="search">
      <IconSearchOutline16 size={14} />
      <input aria-label="搜索项目或任务" placeholder="搜索项目或任务" value={query} onChange={event => { setQuery(event.target.value); setProjectId(undefined) }} />
      {query && <button type="button" aria-label="清除搜索" onClick={() => setQuery('')}><IconCloseOutline16 size={14} /></button>}
    </div>
    <div className={`${sidebarCss.regionArea} cp-workspaces`}>
      <div className="cp-project-heading">
        {selected === undefined
          ? <><strong>{search ? '匹配项目' : '全部项目'}</strong><span>{search ? `${visibleProjects.length} / ` : ''}{workspaces.length}</span></>
          : <button type="button" className="cp-project-back" onClick={() => setProjectId(undefined)}><span aria-hidden="true">‹</span> 全部项目（{workspaces.length}）</button>}
      </div>
      {selected === undefined ? visibleProjects.map(workspace => {
        const count = projectTasks(workspace).length
        return <button type="button" key={workspace.id} className={`${rowsCss.projectRow} cp-project-select`} onClick={() => setProjectId(workspace.id)} aria-label={`打开项目 ${workspace.name}`} aria-current={workspace.id === currentProjectId ? 'true' : undefined}>
          <span className={rowsCss.slot}><span className={rowsCss.folder}><IconFolderOpen16 size={16} /></span></span>
          <span className={rowsCss.projectText}><span className={rowsCss.title}>{workspace.name}</span></span>
          <span className={rowsCss.meta}>{count === 0 && directoryPending ? '读取中' : count}</span>
          <IconChevronRightOutline14 />
        </button>
      }) : <section className="cp-workspace" aria-label={`项目 ${selected.name}`}>
        <div className={rowsCss.projectRow}><span className={rowsCss.slot}><IconFolderOpen16 size={16} /></span><strong className={rowsCss.title}>{selected.name}</strong><span className={rowsCss.meta}>{visibleTasks.length}</span></div>
        <div className="cp-task-list">
          {visibleTasks.map(task => <button type="button" key={task.id} className={`${rowsCss.sessionRow} ${activeTaskId === task.id ? rowsCss.selected : ''} cp-task-row`} onClick={() => onPickTask(task.id)}>
            <span className={rowsCss.slot}><span className={`cp-status-dot cp-status-${task.status}`} /></span><span className={rowsCss.title}>{task.title}</span><span className={rowsCss.time}>{task.updatedAt}</span>
          </button>)}
        </div>
        {visibleTasks.length === 0 && <p className="cp-directory-status">{directoryPending ? '正在读取这个项目的会话…' : '没有匹配的会话。'}</p>}
      </section>}
      {selected === undefined && visibleProjects.length === 0 && <p className="cp-directory-status">没有匹配的项目或任务。</p>}
      {moreTasksControl}
    </div>
    <div className={sidebarCss.footArea}>
      <a href={managementHref} className="cp-sidebar-footer" title="设备与连接"><IconSettingsOutline16 /><span>设备与连接</span></a>
      <div className="cp-connection"><span className={connection === 'online' ? 'cp-online-dot' : 'cp-status-dot cp-status-offline'} />{connection === 'online' ? '工作电脑已连接' : connection === 'reconnecting' ? '正在重新连接' : '工作电脑离线'}</div>
    </div>
  </div>
}
