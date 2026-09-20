import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  type ApprovalRequestMessage,
  type CodexServeClient,
  type InlineAttachment,
  type PermissionMode,
  type ModelOption,
  type ConnectionState,
  type QuestionAnswerValue,
  type QuestionMessage,
  type ReasoningEffort,
  type TaskMessage,
  type TaskSnapshot,
  type TaskStatus,
  type TaskSummary,
  type WorkspaceSummary,
  type UserInput,
  MAX_INLINE_ATTACHMENT_TOTAL_BYTES,
} from '@codex-plus/serve-client'

import frameCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-layout/src/client/AppFrame.module.css'
import inputCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css'
import approvalCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/skeleton/ApprovalPanel.module.css'
import messageCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/chat/MessageItem.module.css'
import reasoningCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/chat/ReasoningRow.module.css'
import commandCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-conversation/src/client/chat/GenericCommandCard.module.css'
import modelCss from '../../../vendor/deepseek-harness-ui/official/packages/client/ui-model-selection/src/client/ModelSelect.module.css'
import {
  IconBranchOutline16,
  IconBrowseOutline16,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconCodeOutline16,
  IconCopyOutline16,
  IconDataOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconPanelLeftOutline16,
  IconPaperclipOutline16,
  IconPlusOutline16,
  IconSendOutline16,
  IconSettingsOutline16,
  IconShareOutline16,
  IconThinkOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
} from './vendor/dsh-icons/index.tsx'
import { createTaskRefresh } from './task-refresh.ts'
import { readTaskPage, mergeTaskSummaries } from './task-list.ts'
import { Sidebar } from './Sidebar.tsx'
import { selectModelSettings } from './model-selection.ts'
import { acceptedSendRevision, reconcileTaskPoll } from './task-polling.ts'
import { useBufferedReply, useComposerSizing, useConversationMotion, usePanelMotion } from './mobile-motion.ts'

type ControlMenu = 'add' | 'permission' | 'model' | 'effort' | null

interface QueuedTurn {
  taskId: string
  actionId: string
  text: string
  model: string
  effort: ReasoningEffort
  permission: PermissionMode
  attachments: readonly DraftAttachment[]
}

interface DraftAttachment extends InlineAttachment {
  kind: 'localImage' | 'file'
  previewUrl?: string
}

const ACTIVE_TASK_POLL_MS = 500
const MAX_ATTACHMENTS_PER_TURN = 4

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x8000)))
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function inferredMediaType(file: File): string {
  if (file.type) return file.type.toLowerCase()
  const extension = file.name.toLowerCase().split('.').pop()
  return ({
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}

async function compressImage(file: File): Promise<Blob> {
  if (file.size <= MAX_INLINE_ATTACHMENT_TOTAL_BYTES) return file
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('无法处理图片。')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolveBlob => canvas.toBlob(resolveBlob, 'image/webp', 0.8))
    if (blob === null) throw new Error('无法压缩图片。')
    return blob
  } finally {
    bitmap.close()
  }
}

function turnInputs(text: string, attachments: readonly DraftAttachment[]): UserInput[] {
  return [
    ...(text.length === 0 ? [] : [{ type: 'text' as const, text }]),
    ...attachments.map(attachment => ({
      type: attachment.kind,
      attachmentId: attachment.attachmentId,
      name: attachment.name,
    })),
  ]
}

function attachmentSidecars(attachments: readonly DraftAttachment[]): InlineAttachment[] {
  return attachments.map(attachment => ({
    attachmentId: attachment.attachmentId,
    name: attachment.name,
    mediaType: attachment.mediaType,
    byteLength: attachment.byteLength,
    contentBase64Url: attachment.contentBase64Url,
  }))
}
const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  none: '无',
  minimal: '最低',
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: '极高',
}

function effortLabel(value: ReasoningEffort, mobileMotion = false): string {
  return mobileMotion && value === 'ultra' ? '极限' : EFFORT_LABEL[value] ?? value
}

function taskTimeLabel(value: string): string {
  const stamp = Date.parse(value)
  if (!Number.isFinite(stamp)) return value
  const minutes = Math.max(0, Math.floor((Date.now() - stamp) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  return new Date(stamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'syncing': return '同步中'
    case 'running': return '运行中'
    case 'waiting-approval': return '等待批准'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'unknown': return '状态未知'
    case 'offline': return '离线'
    default: return '已结束'
  }
}

function uid(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  return `${prefix}-${suffix}`
}

export function App({ client, preview = false, mobileMotion = false, renderMobileStatus, fullAccessEnabled = false, connectionState = 'online', managedConnection = false }: { client: CodexServeClient; preview?: boolean; mobileMotion?: boolean; renderMobileStatus?: (state: ConnectionState, running: boolean) => React.ReactNode; fullAccessEnabled?: boolean; connectionState?: ConnectionState; managedConnection?: boolean }) {
  mobileMotion = mobileMotion && preview
  const [models, setModels] = useState<ModelOption[]>([])
  const [viewReady, setViewReady] = useState(false)
  const activeTaskRef = useRef('')
  const taskSelectionRef = useRef(0)
  const clientRef = useRef(client)
  const loadedClientRef = useRef<CodexServeClient | undefined>(undefined)
  clientRef.current = client
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([])
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const sidebarTasks = useMemo(() => mobileMotion ? tasks.map(task => ({ ...task, updatedAt: taskTimeLabel(task.updatedAt) })) : tasks, [tasks, mobileMotion])
  const [nextTaskCursor, setNextTaskCursor] = useState<string>()
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false)
  const visitedTaskCursorsRef = useRef(new Set<string>())
  const directoryClientRef = useRef<CodexServeClient | undefined>(undefined)
  const [directoryRetry, setDirectoryRetry] = useState(0)
  const [taskListError, setTaskListError] = useState('')
  const [snapshots, setSnapshots] = useState<Record<string, TaskSnapshot>>({})
  const [activeTaskId, setActiveTaskId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionPending, updateActionPending] = useState(false)
  const actionBusyRef = useRef(false)
  const setActionPending = (value: boolean) => { actionBusyRef.current = value; updateActionPending(value) }
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null)
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([])
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const viewportWidthRef = useRef(viewportWidth)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth >= 1240)
  const [menu, setMenu] = useState<ControlMenu>(null)
  const [draft, setDraft] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([])
  const draftOwnerRef = useRef('')
  const taskDraftsRef = useRef(new Map<string, { text: string; attachments: DraftAttachment[] }>())
  useLayoutEffect(() => {
    if (!mobileMotion || draftOwnerRef.current === activeTaskId) return
    if (draftOwnerRef.current) taskDraftsRef.current.set(draftOwnerRef.current, { text: draft, attachments: draftAttachments })
    const restored = taskDraftsRef.current.get(activeTaskId)
    draftOwnerRef.current = activeTaskId
    setDraft(restored?.text ?? ''); setDraftAttachments(restored?.attachments ?? [])
  }, [activeTaskId, mobileMotion])
  const [attachmentPending, setAttachmentPending] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [autoQueueBlocked, setAutoQueueBlocked] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [newTaskDraft, setNewTaskDraft] = useState('')
  const [newTaskPending, setNewTaskPending] = useState(false)
  const [newTaskError, setNewTaskError] = useState<string | null>(null)
  const newTaskMotion = usePanelMotion<HTMLElement>(newTaskOpen, mobileMotion, 'dialog')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<ReasoningEffort>('')
  const [permission, setPermission] = useState<PermissionMode>(() => fullAccessEnabled ? 'full-access' : 'ask')
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const overlayHistoryRef = useRef(false)
  const snapshotsRef = useRef(snapshots)

  useEffect(() => {
    snapshotsRef.current = snapshots
  }, [snapshots])

  const authoritativeSnapshot = snapshots[activeTaskId]
  const snapshot: TaskSnapshot | undefined = useMemo(() => authoritativeSnapshot === undefined ? undefined : ({
    ...authoritativeSnapshot,
    host: { ...authoritativeSnapshot.host, state: connectionState === 'online' && viewReady ? authoritativeSnapshot.host.state : 'reconnecting' },
    model,
    effort,
    permission,
  }), [authoritativeSnapshot, effort, model, permission, connectionState, viewReady])

  useEffect(() => {
    if (connectionState !== 'online' || (loadedClientRef.current === client && viewReady)) return
    let cancelled = false
    const load = async () => {
      if (activeTaskRef.current === '') setLoading(true)
      setViewReady(false)
      setLoadError(null)
      setTaskListError('')
      setNextTaskCursor(undefined)
      setLoadingMoreTasks(false)
      directoryClientRef.current = undefined
      visitedTaskCursorsRef.current = new Set()
      try {
        const [page, nextModels] = await Promise.all([readTaskPage(client), client.listModels()])
        if (cancelled) return
        directoryClientRef.current = client
        setModels(nextModels)
        setWorkspaces(page.workspaces)
        setTasks(page.tasks)
        setNextTaskCursor(page.nextCursor)
        const preferredId = activeTaskRef.current || page.tasks[0]?.id
        if (preferredId === undefined) throw new Error(page.nextCursor === undefined ? '当前电脑没有可用任务。' : '本页没有任务，请加载更多历史。')
        const loadSelection = taskSelectionRef.current
        const firstSnapshot = await client.readTask(preferredId)
        if (cancelled || loadSelection !== taskSelectionRef.current) return
        setModels(nextModels)
        const selection = selectModelSettings(nextModels, model || firstSnapshot.model, effort || firstSnapshot.effort)
        setModel(selection.model)
        setEffort(selection.effort)
        setWorkspaces(current => current.some(workspace => workspace.id === firstSnapshot.workspace.id)
          ? current : [...current, firstSnapshot.workspace])
        setTasks(current => mergeTaskSummaries(current, [firstSnapshot.task]))
        setSnapshots({ [firstSnapshot.task.id]: firstSnapshot })
        activeTaskRef.current = firstSnapshot.task.id
        setActiveTaskId(firstSnapshot.task.id)
        setRunningTaskId(firstSnapshot.task.status === 'running' || firstSnapshot.task.status === 'syncing' ? firstSnapshot.task.id : null)
        loadedClientRef.current = client
        setViewReady(true)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '加载任务失败。')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [client, connectionState])

  useEffect(() => {
    if (nextTaskCursor === undefined || connectionState !== 'online' || directoryClientRef.current !== client) return
    const owner = client
    const cursor = nextTaskCursor
    let cancelled = false
    setLoadingMoreTasks(true)
    setTaskListError('')
    void readTaskPage(owner, cursor, visitedTaskCursorsRef.current).then(page => {
      if (cancelled || clientRef.current !== owner) return
      visitedTaskCursorsRef.current.add(cursor)
      setTasks(current => mergeTaskSummaries(current, page.tasks))
      setWorkspaces(page.workspaces)
      setNextTaskCursor(page.nextCursor)
    }, () => {
      if (!cancelled && clientRef.current === owner) setTaskListError('项目目录暂未加载完整，请重试。')
    }).finally(() => {
      if (!cancelled && clientRef.current === owner) setLoadingMoreTasks(false)
    })
    return () => { cancelled = true }
  }, [client, connectionState, nextTaskCursor, directoryRetry])

  useEffect(() => {
    const next = snapshots[activeTaskId]
    if (!next) return
    const settings = selectModelSettings(models, next.model, next.effort)
    setModel(settings.model)
    setEffort(settings.effort)
    setPermission(next.permission)
    setSidebarOpen(false)
    setMenu(null)
  }, [activeTaskId])

  useEffect(() => {
    const onResize = () => {
      const nextWidth = window.innerWidth
      if (viewportWidthRef.current === nextWidth) return
      viewportWidthRef.current = nextWidth
      setViewportWidth(nextWidth)
      setSidebarOpen(false)
      setDetailsOpen(false)
      setMenu(null)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const overlay = mobileMotion && newTaskOpen
        ? document.querySelector<HTMLElement>('.cp-new-task-dialog')
        : menu
        ? document.querySelector<HTMLElement>('.cp-control-menu:not([inert])')
        : sidebarOpen
          ? document.querySelector<HTMLElement>('.cp-sidebar-col')
          : detailsOpen && viewportWidth < 900
            ? document.querySelector<HTMLElement>('.cp-details-col')
            : null
      if (event.key === 'Tab' && overlay) {
        const focusable = Array.from(overlay.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        if (focusable.length > 0) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        return
      }
      if (event.key !== 'Escape') return
      if (mobileMotion && newTaskOpen) {
        event.preventDefault()
        if (!newTaskPending) setNewTaskOpen(false)
      } else if (menu) {
        event.preventDefault()
        setMenu(null)
      } else if (detailsOpen && viewportWidth < 900) {
        event.preventDefault()
        setDetailsOpen(false)
      } else if (sidebarOpen) {
        event.preventDefault()
        setSidebarOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [detailsOpen, menu, sidebarOpen, viewportWidth, mobileMotion, newTaskOpen, newTaskPending])

  const mobileOverlayOpen = viewportWidth < 900 && (menu !== null || sidebarOpen || detailsOpen || (mobileMotion && newTaskOpen))

  useEffect(() => {
    if (!mobileOverlayOpen) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      const overlay = mobileMotion && newTaskOpen
        ? document.querySelector<HTMLElement>('.cp-new-task-dialog')
        : menu
        ? document.querySelector<HTMLElement>('.cp-control-menu:not([inert])')
        : sidebarOpen
          ? document.querySelector<HTMLElement>('.cp-sidebar-col')
          : document.querySelector<HTMLElement>('.cp-details-col')
      const focus = mobileMotion && newTaskOpen ? overlay?.querySelector<HTMLElement>('textarea') : overlay?.querySelector<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')
      focus?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      previousFocusRef.current?.focus()
    }
  }, [detailsOpen, menu, mobileOverlayOpen, sidebarOpen, mobileMotion, newTaskOpen])

  useEffect(() => {
    const closeAllOverlays = () => {
      overlayHistoryRef.current = false
      setMenu(null)
      setSidebarOpen(false)
      setDetailsOpen(false)
      if (mobileMotion && !newTaskPending) setNewTaskOpen(false)
    }
    window.addEventListener('popstate', closeAllOverlays)
    if (mobileOverlayOpen && !overlayHistoryRef.current) {
      window.history.pushState({ ...(window.history.state ?? {}), codexPlusOverlay: true }, '')
      overlayHistoryRef.current = true
    } else if (!mobileOverlayOpen && overlayHistoryRef.current) {
      overlayHistoryRef.current = false
      if (window.history.state?.codexPlusOverlay === true) window.history.back()
    }
    return () => window.removeEventListener('popstate', closeAllOverlays)
  }, [mobileOverlayOpen, mobileMotion, newTaskPending])

  const storeSnapshot = useCallback((next: TaskSnapshot) => {
    setSnapshots(current => ({ ...current, [next.task.id]: next }))
    setTasks(current => current.map(task => task.id === next.task.id ? next.task : task))
  }, [])

  useEffect(() => {
    if (!activeTaskId || actionBusyRef.current || actionPending || connectionState !== 'online' || !viewReady) return
    let cancelled = false
    const refresh = createTaskRefresh({
      isVisible: () => document.visibilityState !== 'hidden',
      intervalMs: () => {
        const status = snapshotsRef.current[activeTaskId]?.task.status
        return status === 'running' || status === 'syncing' || status === 'waiting-approval' ? ACTIVE_TASK_POLL_MS : 5_000
      },
      read: async () => {
        const next = await client.readTask(activeTaskId)
        if (cancelled) return
        const reconciled = reconcileTaskPoll(snapshotsRef.current[activeTaskId], next)
        if (reconciled.kind === 'retry') return
        storeSnapshot(reconciled.snapshot)
        setRefreshError('')
        if (next.task.status !== 'running' && next.task.status !== 'syncing') {
          setRunningTaskId(current => current === activeTaskId ? null : current)
        }
      },
      onError: count => { if (!cancelled && count >= 2) setRefreshError('暂未收到任务更新，正在重试；已提交的消息不会重复发送。') },
    })
    const visible = () => { if (document.visibilityState !== 'hidden') refresh.refresh() }
    if (!managedConnection) document.addEventListener('visibilitychange', visible)
    refresh.refresh()
    return () => { cancelled = true; refresh.stop(); document.removeEventListener('visibilitychange', visible) }
  }, [actionPending, activeTaskId, client, connectionState, viewReady, storeSnapshot, managedConnection])

  const refreshModels = async () => {
    if (connectionState !== 'online' || !viewReady) return
    const owner = client
    try {
      const next = await client.listModels()
      if (owner !== clientRef.current) return
      setModels(next)
      const settings = selectModelSettings(next, model, effort)
      setModel(settings.model)
      setEffort(settings.effort)
    } catch { setLoadError('暂时无法刷新模型目录，请等待连接恢复。') }
  }

  const addAttachments = async (files: FileList) => {
    if (attachmentPending || files.length === 0) return
    setAttachmentPending(true)
    setAttachmentError(null)
    const created: DraftAttachment[] = []
    try {
      if (draftAttachments.length + files.length > MAX_ATTACHMENTS_PER_TURN) {
        throw new Error(`每次最多选择 ${MAX_ATTACHMENTS_PER_TURN} 个附件。`)
      }
      for (const file of Array.from(files)) {
        if (file.name.length === 0 || file.name.length > 256 || /[\u0000-\u001f\u007f]/.test(file.name)) {
          throw new Error('附件名称无效。')
        }
        const originalMediaType = inferredMediaType(file)
        const image = ['image/png', 'image/jpeg', 'image/webp'].includes(originalMediaType)
        const allowedFile = originalMediaType.startsWith('text/') || [
          'application/json', 'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ].includes(originalMediaType)
        if (!image && !allowedFile) throw new Error(`暂不支持 ${file.name} 的文件类型。`)
        const blob = image ? await compressImage(file) : file
        if (blob.size > MAX_INLINE_ATTACHMENT_TOTAL_BYTES) throw new Error(`${file.name} 超过 256 KiB 限制。`)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const mediaType = image && blob !== file ? 'image/webp' : originalMediaType
        created.push({
          kind: image ? 'localImage' : 'file',
          attachmentId: uid('attachment'),
          name: file.name,
          mediaType,
          byteLength: bytes.byteLength,
          contentBase64Url: bytesToBase64Url(bytes),
          ...(image ? { previewUrl: URL.createObjectURL(blob) } : {}),
        })
      }
      const total = [...draftAttachments, ...created].reduce((sum, attachment) => sum + attachment.byteLength, 0)
      if (total > MAX_INLINE_ATTACHMENT_TOTAL_BYTES) throw new Error('附件总大小超过 256 KiB 限制。')
      setDraftAttachments(current => [...current, ...created])
    } catch (error) {
      for (const attachment of created) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      setAttachmentError(error instanceof Error ? error.message : '附件处理失败。')
    } finally {
      setAttachmentPending(false)
    }
  }

  const removeDraftAttachment = (attachmentId: string) => {
    setDraftAttachments(current => {
      const removed = current.find(attachment => attachment.attachmentId === attachmentId)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      return current.filter(attachment => attachment.attachmentId !== attachmentId)
    })
  }

  const send = async (queued?: QueuedTurn) => {
    const taskId = queued?.taskId ?? activeTaskId
    const turnSnapshot = queued === undefined && taskId === activeTaskId ? snapshot : snapshots[taskId]
    const originalText = queued?.text ?? draft
    const originalAttachments = queued?.attachments ?? draftAttachments
    if (connectionState !== 'online' || !viewReady || !models.some(option => option.id === model && option.supportedReasoningEfforts.includes(effort))) return
    if (!turnSnapshot || (!originalText.trim() && originalAttachments.length === 0) || actionBusyRef.current || actionPending || turnSnapshot.host.state !== 'online') return
    const actionId = queued?.actionId ?? uid('action')
    const turnSettings = queued ?? { model, effort, permission }
    if (queued === undefined && runningTaskId === taskId) {
      setQueuedTurns(current => [...current, {
        taskId,
        actionId,
        text: originalText,
        model: turnSettings.model,
        effort: turnSettings.effort,
        permission: turnSettings.permission,
        attachments: Object.freeze([...originalAttachments]),
      }])
      setDraft('')
      setDraftAttachments([])
      setMenu(null)
      setLoadError(null)
      return
    }
    const canSend = turnSnapshot.capabilities.sendTurn
    const canSteer = turnSnapshot.capabilities.steerTurn && turnSnapshot.activeTurnId !== undefined
    if (!canSend && !canSteer) return
    const expected = {
      hostId: turnSnapshot.host.hostId,
      connectionGeneration: turnSnapshot.host.generation,
      revision: turnSnapshot.revision,
    }
    setActionPending(true)
    setLoadError(null)
    try {
      const receipt = canSend
        ? await client.sendTurn(taskId, {
          actionId,
          input: turnInputs(originalText, originalAttachments),
          ...(originalAttachments.length === 0 ? {} : { attachments: attachmentSidecars(originalAttachments) }),
          settings: {
            model: turnSettings.model,
            effort: turnSettings.effort,
            permission: turnSettings.permission,
          },
          expected,
        })
        : await client.steerTurn(taskId, {
          actionId,
          input: turnInputs(originalText, originalAttachments),
          ...(originalAttachments.length === 0 ? {} : { attachments: attachmentSidecars(originalAttachments) }),
          expected,
        })
      let acceptedRevision: number | undefined
      try {
        acceptedRevision = acceptedSendRevision(receipt)
      } catch (error) {
        try { storeSnapshot(await client.readTask(taskId)) } catch { /* the indeterminate error remains authoritative */ }
        throw error
      }
      if (queued === undefined && activeTaskRef.current === taskId) {
        setDraft('')
        setDraftAttachments([])
      } else if (queued !== undefined) {
        setQueuedTurns(current => current.filter(item => item.actionId !== queued.actionId))
        setAutoQueueBlocked(false)
      }
      for (const attachment of originalAttachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      setRunningTaskId(taskId)
      setSnapshots(current => {
        const currentSnapshot = current[taskId]
        if (currentSnapshot === undefined) return current
        const revision = acceptedRevision ?? currentSnapshot.revision
        const nextTask = {
          ...currentSnapshot.task,
          status: 'running' as const,
          revision,
          completionReason: undefined,
        }
        return {
          ...current,
          [taskId]: {
            ...currentSnapshot,
            revision,
            task: nextTask,
            capabilities: { ...currentSnapshot.capabilities, sendTurn: false, steerTurn: false },
            messages: [
              ...currentSnapshot.messages,
              {
                id: actionId,
                kind: 'user' as const,
                createdAt: new Date().toISOString(),
                text: [
                  originalText,
                  ...originalAttachments.map(attachment => attachment.kind === 'localImage' ? `[Image: ${attachment.name}]` : `[File: ${attachment.name}]`),
                ].filter(Boolean).join('\n'),
              },
            ],
          },
        }
      })
      setTasks(current => current.map(task => task.id === taskId ? {
        ...task,
        status: 'running',
        revision: acceptedRevision ?? task.revision,
        completionReason: undefined,
      } : task))
    } catch (error) {
      if (queued !== undefined) setAutoQueueBlocked(true)
      setLoadError(error instanceof Error ? error.message : '发送失败，草稿已保留。')
    } finally {
      setActionPending(false)
    }
  }

  const adjustDirection = async (item: QueuedTurn) => {
    const currentSnapshot = snapshots[item.taskId]
    if (
      actionBusyRef.current || actionPending
      || runningTaskId !== item.taskId
      || currentSnapshot?.host.state !== 'online'
    ) return
    setActionPending(true)
    setLoadError(null)
    try {
      const receipt = await client.steerTurn(item.taskId, {
        actionId: item.actionId,
        input: turnInputs(item.text, item.attachments),
        ...(item.attachments.length === 0 ? {} : { attachments: attachmentSidecars(item.attachments) }),
        expected: {
          hostId: currentSnapshot.host.hostId,
          connectionGeneration: currentSnapshot.host.generation,
          revision: currentSnapshot.revision,
        },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      const revision = acceptedSendRevision(receipt) ?? currentSnapshot.revision
      setQueuedTurns(current => current.filter(candidate => candidate.actionId !== item.actionId))
      setAutoQueueBlocked(false)
      for (const attachment of item.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      setSnapshots(current => {
        const value = current[item.taskId]
        if (value === undefined) return current
        return {
          ...current,
          [item.taskId]: {
            ...value,
            revision,
            task: { ...value.task, revision },
            messages: [
              ...value.messages,
              {
                id: item.actionId,
                kind: 'user' as const,
                createdAt: new Date().toISOString(),
                text: [
                  item.text,
                  ...item.attachments.map(attachment => attachment.kind === 'localImage' ? `[Image: ${attachment.name}]` : `[File: ${attachment.name}]`),
                ].filter(Boolean).join('\n'),
              },
            ],
          },
        }
      })
      setTasks(current => current.map(task => task.id === item.taskId ? { ...task, revision } : task))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '调整方向失败，消息仍在队列中。')
    } finally {
      setActionPending(false)
    }
  }

  useEffect(() => {
    if (document.visibilityState === 'hidden' || connectionState !== 'online' || !viewReady || runningTaskId !== null || actionBusyRef.current || actionPending || autoQueueBlocked) return
    const next = queuedTurns[0]
    if (next === undefined) return
    const nextSnapshot = snapshots[next.taskId]
    if (nextSnapshot?.host.state !== 'online' || !nextSnapshot.capabilities.sendTurn) return
    void send(next)
  }, [actionPending, autoQueueBlocked, queuedTurns, runningTaskId, snapshots, connectionState, viewReady])

  const startNewTask = async () => {
    const workspace = workspaces.find(value => value.capabilities.startTask && value.connection === 'online')
    const text = newTaskDraft
    if (workspace === undefined || !text.trim() || newTaskPending) return
    setNewTaskPending(true)
    setNewTaskError(null)
    const actionId = uid('task')
    try {
      const receipt = await client.startTask({
        actionId,
        workspaceId: workspace.id,
        input: [{ type: 'text', text }],
        settings: { model, effort, permission },
        expected: { hostId: workspace.hostId, connectionGeneration: workspace.connectionGeneration },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      if (receipt.state !== 'accepted' || receipt.task === undefined) {
        throw new Error('新任务结果尚不明确，请勿重复创建。')
      }
      const task = receipt.task
      const nextSnapshot: TaskSnapshot = {
        authoritative: true,
        host: { hostId: workspace.hostId, generation: workspace.connectionGeneration, state: 'online' },
        revision: receipt.revision ?? task.revision,
        sequence: receipt.revision ?? task.revision,
        cursor: `demo-new-${receipt.revision ?? task.revision}`,
        capabilities: { sendTurn: false, steerTurn: false, interruptTurn: false, resolveApproval: false, answerQuestion: false },
        activeTurnId: task.activeTurnId,
        task,
        workspace,
        model,
        effort,
        permission,
        messages: [{ id: actionId, kind: 'user', createdAt: new Date().toISOString(), text }],
        sources: [],
      }
      setTasks(current => [task, ...current.filter(value => value.id !== task.id)])
      setSnapshots(current => ({ ...current, [task.id]: nextSnapshot }))
      if (mobileMotion) activeTaskRef.current = task.id
      setActiveTaskId(task.id)
      setRunningTaskId(task.id)
      setNewTaskDraft('')
      setNewTaskOpen(false)
    } catch (error) {
      setNewTaskError(error instanceof Error ? error.message : '新建任务失败。')
    } finally {
      setNewTaskPending(false)
    }
  }

  const resolveApproval = async (message: ApprovalRequestMessage, state: 'approved' | 'denied') => {
    if (!snapshot || actionBusyRef.current || actionPending || !snapshot.capabilities.resolveApproval || message.state !== 'pending') return
    setActionPending(true)
    setLoadError(null)
    try {
      const receipt = await client.resolveRequest({
        type: 'approval',
        actionId: uid('approval'),
        taskId: message.taskId,
        turnId: message.turnId,
        hostId: message.hostId,
        connectionGeneration: message.connectionGeneration,
        requestId: message.requestId,
        requestNonce: message.requestNonce,
        issuedAt: message.issuedAt,
        expiresAt: message.expiresAt,
        decision: state === 'approved' ? 'approve-once' : 'deny',
        expected: {
          hostId: snapshot.host.hostId,
          connectionGeneration: snapshot.host.generation,
          revision: snapshot.revision,
        },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection?.message ?? '审批已被拒绝。')
      if (receipt.state !== 'accepted') throw new Error('审批结果尚不明确，请勿重复提交。')
      storeSnapshot(await client.readTask(activeTaskId))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '审批失败。')
    } finally {
      setActionPending(false)
    }
  }

  const resolveQuestion = async (message: QuestionMessage, answers: QuestionAnswerValue[]) => {
    if (!snapshot || actionBusyRef.current || actionPending || !snapshot.capabilities.answerQuestion || message.state !== 'pending') return
    setActionPending(true)
    setLoadError(null)
    try {
      const receipt = await client.resolveRequest({
        type: 'question',
        actionId: uid('answer'),
        taskId: message.taskId,
        turnId: message.turnId,
        hostId: message.hostId,
        connectionGeneration: message.connectionGeneration,
        requestId: message.requestId,
        requestNonce: message.requestNonce,
        issuedAt: message.issuedAt,
        expiresAt: message.expiresAt,
        answers,
        expected: {
          hostId: snapshot.host.hostId,
          connectionGeneration: snapshot.host.generation,
          revision: snapshot.revision,
        },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      if (receipt.state !== 'accepted') throw new Error('回答结果尚不明确，请勿重复提交。')
      storeSnapshot(await client.readTask(activeTaskId))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '回答失败。')
    } finally {
      setActionPending(false)
    }
  }

  const interruptActiveTurn = async () => {
    if (!snapshot?.activeTurnId || actionBusyRef.current || actionPending || !snapshot.capabilities.interruptTurn) return
    setActionPending(true)
    setLoadError(null)
    try {
      const receipt = await client.interruptTurn(snapshot.task.id, {
        actionId: uid('interrupt'),
        turnId: snapshot.activeTurnId,
        expected: {
          hostId: snapshot.host.hostId,
          connectionGeneration: snapshot.host.generation,
          revision: snapshot.revision,
        },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      if (receipt.state !== 'accepted') throw new Error('中断结果尚不明确，请勿重复操作。')
      setRunningTaskId(current => current === snapshot.task.id ? null : current)
      storeSnapshot(await client.readTask(snapshot.task.id))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '中断失败。')
    } finally {
      setActionPending(false)
    }
  }

  const pickTask = async (taskId: string) => {
    const selection = ++taskSelectionRef.current
    activeTaskRef.current = taskId
    const currentClient = client
    setSidebarOpen(false)
    if (snapshots[taskId]) setActiveTaskId(taskId)
    setMenu(null)
    setLoadError(null)
    try {
      const next = await client.readTask(taskId)
      if (selection !== taskSelectionRef.current || currentClient !== clientRef.current) return
      storeSnapshot(next)
      loadedClientRef.current = currentClient
      setViewReady(true)
      setActiveTaskId(taskId)
      setRunningTaskId(next.task.status === 'running' || next.task.status === 'syncing' ? taskId : null)
      if (taskId === runningTaskId && next.task.status !== 'running' && next.task.status !== 'syncing') {
        setRunningTaskId(null)
      }
    } catch {
      if (selection !== taskSelectionRef.current || currentClient !== clientRef.current) return
      setLoadError('暂时无法读取此任务，请稍后重试。')
    }
  }

  if (loading && !snapshot) return <div className="cp-loading">{preview ? '正在加载离线 UI 预览…' : '正在读取任务…'}</div>
  const moreTasksControl = <>
    {taskListError && <p role="alert">{taskListError}</p>}
    {nextTaskCursor !== undefined && !taskListError && <p className="cp-directory-status" role="status">{connectionState === 'online' ? '正在读取完整项目目录…' : '连接恢复后继续读取项目目录。'}</p>}
    {nextTaskCursor !== undefined && taskListError && <button type="button" className="cp-button" disabled={loadingMoreTasks || connectionState !== 'online'} onClick={() => setDirectoryRetry(value => value + 1)}>重试目录加载</button>}
  </>
  if (!snapshot) return <main className="cp-directory-only"><p className="cp-directory-status" role={loadError ? 'alert' : 'status'}>{loadError ? '暂时无法读取当前会话，可以选择其他项目和会话。' : '正在读取会话，也可以从项目目录选择。'}</p><Sidebar workspaces={workspaces} tasks={tasks} directoryPending={nextTaskCursor !== undefined} moreTasksControl={moreTasksControl} connection={connectionState} activeTaskId={activeTaskId} canStartTask={false} onNewTask={() => {}} onPickTask={taskId => { void pickTask(taskId) }} /></main>
  const mobileLayout = viewportWidth < 900
  const activeTaskRunning = runningTaskId === activeTaskId
  const activeQueuedTurns = queuedTurns.filter(item => item.taskId === activeTaskId)
  const composerDisabledReason = !models.some(option => option.id === model && option.supportedReasoningEfforts.includes(effort))
    ? '正在同步可用模型与推理强度。'
    : snapshot.host.state === 'reconnecting'
      ? '手机连接恢复中，草稿已保留。'
    : snapshot.host.state !== 'online'
      ? '工作电脑离线：当前为只读快照。'
    : actionPending
      ? '正在等待动作回执…'
      : !activeTaskRunning && !snapshot.capabilities.sendTurn && !snapshot.capabilities.steerTurn
        ? '当前任务正在等待批准或不允许发送。'
        : undefined

  return (
    <div
      className={`${frameCss.frame} cp-frame${mobileMotion ? ' cp-mobile-motion' : ''}`}
      data-details-collapsed={detailsOpen ? undefined : ''}
      style={{ gridTemplateColumns: detailsOpen ? '280px minmax(0, 1fr) 336px' : '280px minmax(0, 1fr) 0px' }}
    >
      <div className="cp-mobile-scrim" aria-hidden="true" data-open={sidebarOpen || detailsOpen ? '' : undefined} onClick={() => { setSidebarOpen(false); setDetailsOpen(false) }} />
      <aside className={`${frameCss.sidebarCol} cp-sidebar-col`} data-open={sidebarOpen ? '' : undefined} inert={mobileLayout && !sidebarOpen ? true : undefined} aria-hidden={mobileLayout && !sidebarOpen || undefined} role={sidebarOpen ? 'dialog' : undefined} aria-modal={sidebarOpen || undefined} aria-label={sidebarOpen ? '任务列表' : undefined}>
        <Sidebar workspaces={workspaces} tasks={sidebarTasks} directoryPending={nextTaskCursor !== undefined} moreTasksControl={moreTasksControl} connection={snapshot.host.state} activeTaskId={activeTaskId} canStartTask={workspaces.some(value => value.capabilities.startTask && value.connection === 'online')} onNewTask={() => { setNewTaskOpen(true); if (mobileMotion) setSidebarOpen(false) }} onPickTask={taskId => { void pickTask(taskId) }} onClose={() => setSidebarOpen(false)} managementHref={mobileMotion ? './app.html?view=manage' : undefined} />
      </aside>

      <main className={`${frameCss.centerCol} cp-center-col`}>
        <TaskHeader
          snapshot={snapshot}
          interruptPending={actionPending}
          onInterrupt={() => { void interruptActiveTurn() }}
          onOpenSidebar={() => setSidebarOpen(true)}
          onToggleDetails={() => setDetailsOpen(value => !value)}
        />
        {preview && mobileMotion && (renderMobileStatus?.(snapshot.host.state, activeTaskRunning) ?? <div className="cp-preview-badge">离线预览 · 未连接真实服务</div>)}
        <Conversation
          mobileMotion={mobileMotion}
          snapshot={snapshot}
          running={activeTaskRunning}
          onResolveApproval={resolveApproval}
          onResolveQuestion={resolveQuestion}
          approvalDisabled={actionPending || !snapshot.capabilities.resolveApproval}
          questionDisabled={actionPending || !snapshot.capabilities.answerQuestion}
        />
        {preview && !mobileMotion && <div className="cp-preview-badge">离线 UI 预览 · 所有动作只修改本地模拟数据</div>}
        {activeQueuedTurns.length > 0 && (
          <div className="cp-queued-turns" aria-label="排队消息">
            {activeQueuedTurns.map(item => (
              <div className="cp-queued-turn" key={item.actionId}>
                <span className="cp-queue-icon" aria-hidden="true">↳</span>
                <span className="cp-queue-thumbnail" aria-hidden="true">
                  {item.attachments[0]?.previewUrl
                    ? <img src={item.attachments[0].previewUrl} alt="" />
                    : item.attachments.length > 0 ? <IconPaperclipOutline16 /> : null}
                </span>
                <span className="cp-queue-text">{item.text || item.attachments.map(attachment => attachment.name).join('、')}</span>
                <button type="button" className="cp-adjust-direction" onClick={() => { void adjustDirection(item) }}>
                  <span aria-hidden="true">↪</span>调整方向
                </button>
                <button type="button" aria-label="删除排队消息" onClick={() => {
                  for (const attachment of item.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
                  setQueuedTurns(current => current.filter(candidate => candidate.actionId !== item.actionId))
                  setAutoQueueBlocked(false)
                }}>
                  <IconTrashOutline16 />
                </button>
                <button type="button" aria-label="更多排队操作" disabled><IconEllipsisOutline16 /></button>
              </div>
            ))}
          </div>
        )}
        {refreshError && <p role="status" className="cp-connection">{refreshError}</p>}
        {loadError && <div className="cp-action-error" role="alert">{loadError}</div>}
        <Composer
          mobileMotion={mobileMotion}
          draft={draft}
          setDraft={setDraft}
          models={models}
          onModelsOpen={() => { void refreshModels() }}
          model={model}
          effort={effort}
          permission={permission}
          fullAccessEnabled={fullAccessEnabled}
          menu={menu}
          setMenu={setMenu}
          setModel={setModel}
          setEffort={setEffort}
          setPermission={setPermission}
          disabled={composerDisabledReason !== undefined || attachmentPending}
          disabledReason={attachmentPending ? '正在处理附件…' : composerDisabledReason}
          settingsDisabled={!activeTaskRunning && !snapshot.capabilities.sendTurn}
          attachments={draftAttachments}
          attachmentPending={attachmentPending}
          attachmentError={attachmentError}
          onFiles={files => { void addAttachments(files) }}
          onRemoveAttachment={removeDraftAttachment}
          onSend={() => { void send() }}
        />
      </main>

      <aside className={`${frameCss.detailsCol} cp-details-col`} data-open={detailsOpen ? '' : undefined} inert={mobileLayout && !detailsOpen ? true : undefined} aria-hidden={mobileLayout && !detailsOpen || undefined} role={detailsOpen && mobileLayout ? 'dialog' : undefined} aria-modal={detailsOpen && mobileLayout || undefined} aria-label={detailsOpen ? '环境信息' : undefined}>
        <EnvironmentPanel snapshot={snapshot} onClose={() => setDetailsOpen(false)} />
      </aside>
      {(mobileMotion ? newTaskMotion.mounted : newTaskOpen) && (
        <div className="cp-new-task-backdrop" role="presentation" inert={!newTaskOpen || undefined} aria-hidden={!newTaskOpen || undefined} onMouseDown={event => { if (event.target === event.currentTarget && !newTaskPending) setNewTaskOpen(false) }}>
          {mobileMotion && <button ref={newTaskMotion.scrim} className="cp-dialog-scrim" aria-hidden="true" tabIndex={-1} disabled={newTaskPending} onClick={() => setNewTaskOpen(false)} />}
          <section ref={mobileMotion ? newTaskMotion.panel : undefined} className="cp-new-task-dialog" role={newTaskOpen ? 'dialog' : undefined} aria-modal={newTaskOpen || undefined} aria-labelledby="new-task-title">
            <div className="cp-new-task-head"><strong id="new-task-title">新建 Codex 任务</strong><button type="button" aria-label="关闭" disabled={newTaskPending} onClick={() => setNewTaskOpen(false)}><IconCloseOutline16 /></button></div>
            <textarea autoFocus aria-label="新任务消息" placeholder="描述要完成的任务" value={newTaskDraft} disabled={newTaskPending} onChange={event => setNewTaskDraft(event.currentTarget.value)} />
            <small>{model} · {effortLabel(effort, mobileMotion)} · {permission === 'full-access' ? '完全访问' : permission === 'read-only' ? '只读' : '请求批准'}</small>
            {newTaskError && <div className="cp-new-task-error" role="alert">{newTaskError}</div>}
            <button type="button" className="cp-button cp-button-primary" disabled={newTaskPending || !newTaskDraft.trim()} onClick={() => { void startNewTask() }}>{newTaskPending ? '正在创建…' : '创建并运行'}</button>
          </section>
        </div>
      )}
    </div>
  )
}

function TaskHeader({ snapshot, interruptPending, onInterrupt, onOpenSidebar, onToggleDetails }: {
  snapshot: TaskSnapshot
  interruptPending: boolean
  onInterrupt: () => void
  onOpenSidebar: () => void
  onToggleDetails: () => void
}) {
  return (
    <header className="cp-task-header">
      <button type="button" className="cp-header-icon cp-mobile-only" aria-label="打开任务栏" onClick={onOpenSidebar}>
        <IconPanelLeftOutline16 />
      </button>
      <div className="cp-task-title">
        <IconFolderClose16 size={16} />
        <strong>{snapshot.task.title}</strong>
        <button type="button" aria-label="任务菜单" disabled title="等待任务动作适配器"><IconEllipsisOutline16 /></button>
      </div>
      <div className="cp-header-actions">
        {snapshot.capabilities.interruptTurn && snapshot.activeTurnId !== undefined && (
          <button type="button" className="cp-interrupt-button" disabled={interruptPending} onClick={onInterrupt}>停止</button>
        )}
        <button type="button" className="cp-share cp-desktop-only" disabled title="尚未接入安全分享"><IconShareOutline16 /><span>分享</span></button>
        <button type="button" className="cp-open-location cp-desktop-only" disabled title="等待 Windows Companion 提供真实能力">
          <IconBrowseOutline16 /><span>打开位置</span><IconChevronDownOutline14 />
        </button>
        <button type="button" className="cp-header-icon" aria-label="环境信息" onClick={onToggleDetails}>
          <IconDataOutline16 />
        </button>
      </div>
    </header>
  )
}

function Conversation({ snapshot, running, onResolveApproval, onResolveQuestion, approvalDisabled, questionDisabled, mobileMotion = false }: {
  mobileMotion?: boolean
  snapshot: TaskSnapshot
  running: boolean
  onResolveApproval: (message: ApprovalRequestMessage, state: 'approved' | 'denied') => void
  onResolveQuestion: (message: QuestionMessage, answers: QuestionAnswerValue[]) => void
  approvalDisabled: boolean
  questionDisabled: boolean
}) {
  const userRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const userMessages = snapshot.messages.filter(message => message.kind === 'user')
  const lastMessage = snapshot.messages.at(-1)
  // Capture the entry snapshot only: browsing an existing task never retypes it.
  const entryMessageIds = useMemo(() => new Set(snapshot.messages.map(message => message.id)), [snapshot.task.id])
  const flushReply = snapshot.host.state !== 'online' || (snapshot.task.status !== 'running' && snapshot.task.status !== 'completed') || (snapshot.task.completionReason !== undefined && snapshot.task.completionReason !== 'completed')
  const motion = useConversationMotion(mobileMotion, snapshot.task.id, lastMessage?.id, lastMessage?.kind === 'user')

  return (
    <section className="cp-conversation" aria-label="任务对话" ref={motion.viewport} onScroll={motion.onScroll}>
      <div className="cp-message-rail cp-desktop-only" aria-label="用户消息导航">
        {userMessages.map(message => (
          <button
            type="button"
            key={message.id}
            aria-label="跳转到用户消息"
            onClick={() => userRefs.current[message.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
        ))}
      </div>
      <div className="cp-conversation-inner" ref={motion.content}>
        <div className="cp-session-meta">
          <span className={`cp-status-dot cp-status-${snapshot.task.status}`} />
          {statusLabel(snapshot.task.status)} · {snapshot.workspace.name} · {snapshot.branch ?? '无分支'}
        </div>
        {snapshot.messages.map(message => (
          <div
            className="cp-message-seat"
            key={mobileMotion ? `${snapshot.task.id}/${message.id}` : message.id}
            data-message-id={mobileMotion ? message.id : undefined}
            ref={element => { if (message.kind === 'user') userRefs.current[message.id] = element }}
          >
            <Message
              message={message}
              onResolveApproval={onResolveApproval}
              onResolveQuestion={onResolveQuestion}
              approvalDisabled={approvalDisabled}
              questionDisabled={questionDisabled}
              mobileMotion={mobileMotion}
              animateReply={!entryMessageIds.has(message.id)}
              replyMode={flushReply ? 'immediate' : running && message.turnId === snapshot.activeTurnId && message.id === lastMessage?.id ? 'streaming' : 'complete'}
            />
          </div>
        ))}
        {running && (
          <div className="cp-thinking-row" role="status" aria-live="polite">
            <span className="cp-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{mobileMotion && lastMessage?.kind === 'assistant' ? '正在回复' : '正在思考'}</span>
          </div>
        )}
      </div>
      {motion.away && <button type="button" className="cp-jump-latest" onClick={motion.latest}><IconChevronDownOutline14 />回到最新</button>}
    </section>
  )
}

const BufferedAssistant = memo(function BufferedAssistant({ source, enabled, mode }: {
  source: string; enabled: boolean; mode: 'streaming' | 'complete' | 'immediate'
}) {
  const reply = useBufferedReply(source, enabled, mode)
  return <div className="cp-assistant-copy" data-revealing={reply.pending || undefined} aria-busy={reply.pending || undefined}>{renderInlineMarkdown(reply.text, reply.pending)}</div>
})

function Message({ message, onResolveApproval, onResolveQuestion, approvalDisabled, questionDisabled, mobileMotion = false, animateReply = false, replyMode = 'immediate' }: {
  message: TaskMessage
  onResolveApproval: (message: ApprovalRequestMessage, state: 'approved' | 'denied') => void
  onResolveQuestion: (message: QuestionMessage, answers: QuestionAnswerValue[]) => void
  approvalDisabled: boolean
  questionDisabled: boolean
  mobileMotion?: boolean
  animateReply?: boolean
  replyMode?: 'streaming' | 'complete' | 'immediate'
}) {
  if (message.kind === 'user') {
    return (
      <div className={messageCss.userRow}>
        <div className={messageCss.userStack}>
          <div className={messageCss.bubble}>{message.text}</div>
        </div>
      </div>
    )
  }

  if (message.kind === 'assistant') {
    if (mobileMotion) return <BufferedAssistant source={message.markdown} enabled={animateReply} mode={replyMode} />
    return <div className="cp-assistant-copy">{renderInlineMarkdown(message.markdown)}</div>
  }

  if (message.kind === 'reasoning') {
    return (
      <div className={reasoningCss.root} data-state={message.state}>
        <div className={`${reasoningCss.row} cp-activity-row`}>
          <IconThinkOutline16 className={reasoningCss.leading} />
          <span className={reasoningCss.title}>{message.title}</span>
          <span className={reasoningCss.separator} />
          <span className={reasoningCss.summary}>{message.summary}</span>
        </div>
      </div>
    )
  }

  if (message.kind === 'tool') {
    return (
      <details className={commandCss.root} open={message.state === 'running'} data-state={message.state}>
        <summary className={`${commandCss.row} cp-activity-row`}>
          <IconCodeOutline16 className={commandCss.leading} />
          <span className={commandCss.title}>{message.title}</span>
          <span className={commandCss.separator} />
          <span className={commandCss.summary}>{message.summary}</span>
        </summary>
        {(message.command || message.output) && <pre className={commandCss.body}>{message.command}{message.output ? `\n${message.output}` : ''}</pre>}
      </details>
    )
  }

  if (message.kind === 'diff') {
    return (
      <div className="cp-diff-card">
        <div className="cp-diff-head">
          <span className="cp-diff-icon"><IconCodeOutline16 /></span>
          <div><strong>已编辑 {message.files.length} 个文件</strong><span>离线模拟变更</span></div>
          <button type="button" disabled title="等待真实 diff reader">审查</button>
        </div>
        <div className="cp-diff-files">
          {message.files.map(file => (
            <div key={file.path}><span>{file.path}</span><code><i>+{file.additions}</i> <b>-{file.deletions}</b></code></div>
          ))}
        </div>
      </div>
    )
  }

  if (message.kind === 'question') {
    return <QuestionCard message={message} disabled={questionDisabled} onResolve={onResolveQuestion} />
  }

  return <ApprovalCard message={message} disabled={approvalDisabled} onResolve={onResolveApproval} />
}

function QuestionCard({ message, disabled, onResolve }: {
  message: QuestionMessage
  disabled: boolean
  onResolve: (message: QuestionMessage, answers: QuestionAnswerValue[]) => void
}) {
  const [values, setValues] = useState<Record<string, string[]>>({})
  if (message.state !== 'pending') {
    return <div className="cp-resolution"><IconCheckOutline16 />已回答 · {message.title}</div>
  }
  const complete = message.questions.every(question => (values[question.id]?.length ?? 0) > 0)
  const choose = (questionId: string, value: string, multiple: boolean) => {
    setValues(current => {
      const existing = current[questionId] ?? []
      const next = multiple
        ? existing.includes(value) ? existing.filter(item => item !== value) : [...existing, value]
        : [value]
      return { ...current, [questionId]: next }
    })
  }
  return (
    <div className="cp-question-card">
      <strong>{message.title}</strong>
      <span>{message.detail}</span>
      {message.questions.map(question => (
        <fieldset key={question.id}>
          <legend>{question.detail && <small>{question.detail}</small>}{question.prompt}</legend>
          {question.choices?.map(choice => (
            <button
              type="button"
              key={choice}
              aria-pressed={values[question.id]?.includes(choice) === true}
              disabled={disabled}
              onClick={() => choose(question.id, choice, question.multiple === true)}
            >{choice}</button>
          ))}
          {(question.allowFreeform === true || !question.choices?.length) && (
            <input
              aria-label={`${question.prompt}的回答`}
              disabled={disabled}
              value={question.choices?.includes(values[question.id]?.[0] ?? '') ? '' : values[question.id]?.[0] ?? ''}
              onChange={event => setValues(current => ({
                ...current,
                [question.id]: event.currentTarget.value.trim() === '' ? [] : [event.currentTarget.value],
              }))}
            />
          )}
        </fieldset>
      ))}
      <button
        type="button"
        className="cp-button cp-button-primary"
        disabled={disabled || !complete}
        onClick={() => onResolve(message, message.questions.map(question => ({
          questionId: question.id,
          values: values[question.id] ?? [],
        })))}
      >提交回答</button>
    </div>
  )
}

function ApprovalCard({ message, disabled, onResolve }: {
  message: ApprovalRequestMessage
  disabled: boolean
  onResolve: (message: ApprovalRequestMessage, state: 'approved' | 'denied') => void
}) {
  if (message.state !== 'pending') {
    return <div className="cp-resolution"><IconCheckOutline16 />{message.state === 'approved' ? '已批准一次' : '已拒绝'} · {message.title}</div>
  }
  return (
    <div className={`${approvalCss.root} cp-approval-root`}>
      <div className={approvalCss.card}>
        <div className={approvalCss.strip}><span className={approvalCss.dot} />需要你的批准</div>
        <div className={approvalCss.body}>
          <div className={approvalCss.headline}>{message.title}</div>
          <div className="cp-approval-detail">{message.detail}</div>
          {message.command && <code className={approvalCss.command}>{message.command}</code>}
        </div>
        <div className={approvalCss.actionRow}>
          <button type="button" className="cp-button" disabled={disabled} onClick={() => onResolve(message, 'denied')}>拒绝</button>
          <button type="button" className="cp-button cp-button-primary" disabled={disabled} onClick={() => onResolve(message, 'approved')}>仅批准本次</button>
        </div>
      </div>
    </div>
  )
}

function Composer({
  draft, setDraft, models, onModelsOpen, model, effort, permission, fullAccessEnabled, menu, setMenu, setModel, setEffort, setPermission, disabled, disabledReason, settingsDisabled,
  attachments, attachmentPending, attachmentError, onFiles, onRemoveAttachment, onSend, mobileMotion = false,
}: {
  mobileMotion?: boolean
  draft: string
  setDraft: (value: string) => void
  models: readonly ModelOption[]
  onModelsOpen: () => void
  model: string
  effort: ReasoningEffort
  permission: PermissionMode
  fullAccessEnabled: boolean
  menu: ControlMenu
  setMenu: (menu: ControlMenu) => void
  setModel: (model: string) => void
  setEffort: (effort: ReasoningEffort) => void
  setPermission: (permission: PermissionMode) => void
  disabled: boolean
  disabledReason?: string
  settingsDisabled: boolean
  attachments: readonly DraftAttachment[]
  attachmentPending: boolean
  attachmentError: string | null
  onFiles: (files: FileList) => void
  onRemoveAttachment: (attachmentId: string) => void
  onSend: () => void
}) {
  const toggle = (next: ControlMenu) => setMenu(menu === next ? null : next)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useComposerSizing(mobileMotion, draft)
  return (
    <div className={`${inputCss.root} cp-composer-root`}>
      {disabledReason && <div className={inputCss.notice}>{disabledReason}</div>}
      {attachmentError && <div className="cp-attachment-error" role="alert">{attachmentError}</div>}
      <input
        ref={fileInputRef}
        className="cp-file-input"
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,text/*,.json,.pdf,.docx,.xlsx,.pptx"
        onChange={event => {
          if (event.currentTarget.files) onFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <div className={`${inputCss.card} cp-composer-card`}>
        {attachments.length > 0 && (
          <div className="cp-attachment-chips" aria-label="待发送附件">
            {attachments.map(attachment => (
              <div className="cp-attachment-chip" key={attachment.attachmentId}>
                {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <IconPaperclipOutline16 />}
                <span>{attachment.name}</span>
                <small>{Math.ceil(attachment.byteLength / 1024)} KiB</small>
                <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.attachmentId)}><IconCloseOutline16 /></button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="cp-composer-input"
          aria-label="给 Codex 发送消息"
          placeholder={disabled ? disabledReason : '随心输入'}
          value={draft}
          disabled={disabled}
          onChange={event => setDraft(event.currentTarget.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              if (mobileMotion && window.matchMedia('(pointer: coarse)').matches && !event.ctrlKey && !event.metaKey) return
              event.preventDefault()
              onSend()
            }
          }}
        />
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <div className="cp-menu-anchor">
              <button type="button" className={inputCss.add} aria-label="添加" aria-expanded={menu === 'add'} onClick={() => toggle('add')}>
                <IconPlusOutline16 />
              </button>
              {(mobileMotion || menu === 'add') && (
                <ControlMenuShell className="cp-add-menu" open={menu === 'add'} mobileMotion={mobileMotion} onDismiss={() => setMenu(null)}>
                  <button type="button" className={modelCss.option} disabled={attachmentPending} onClick={() => { setMenu(null); fileInputRef.current?.click() }}><IconPaperclipOutline16 /><span className={modelCss.optionCopy}><span className={modelCss.modelName}>图片和文件</span><span className={modelCss.description}>图片自动压缩，附件总计不超过 256 KiB</span></span></button>
                </ControlMenuShell>
              )}
            </div>
            <div className="cp-menu-anchor">
              <button type="button" className={`cp-permission-trigger ${permission === 'full-access' ? 'cp-full-access' : ''}`} aria-expanded={menu === 'permission'} disabled={settingsDisabled} onClick={() => toggle('permission')}>
                <IconWarningOutline16 />{permission === 'ask' ? '请求批准' : permission === 'read-only' ? '只读' : '完全访问'}<IconChevronDownOutline14 />
              </button>
              {(mobileMotion || menu === 'permission') && (
                <ControlMenuShell open={menu === 'permission'} mobileMotion={mobileMotion} onDismiss={() => setMenu(null)}>
                  <div className={modelCss.groupTitle}>Codex 如何执行操作</div>
                  <ChoiceRow selected={permission === 'ask'} title="请求批准" detail="遇到风险操作时询问" onClick={() => { setPermission('ask'); setMenu(null) }} />
                  <ChoiceRow selected={permission === 'read-only'} title="只读" detail="不允许修改工作区" onClick={() => { setPermission('read-only'); setMenu(null) }} />
                  {fullAccessEnabled
                    ? <ChoiceRow selected={permission === 'full-access'} title="完全访问" detail="允许修改工作区并运行命令" onClick={() => { setPermission('full-access'); setMenu(null) }} />
                    : <div className="cp-disabled-choice"><span>完全访问</span><small>远程端禁止提权</small></div>}
                </ControlMenuShell>
              )}
            </div>
          </div>
          <div className={inputCss.trailing}>
            <div className={`${modelCss.root} cp-menu-anchor`}>
              <button type="button" className={modelCss.trigger} aria-expanded={menu === 'model'} disabled={settingsDisabled} onClick={() => { if (menu !== 'model') onModelsOpen(); toggle('model') }}>
                <span className={modelCss.triggerLabel}>{models.find(option => option.id === model)?.displayName ?? model}</span>
                <IconChevronDownOutline14 className={menu === 'model' ? modelCss.chevronOpen : modelCss.chevron} />
              </button>
              {(mobileMotion || menu === 'model') && (
                <ControlMenuShell open={menu === 'model'} mobileMotion={mobileMotion} onDismiss={() => setMenu(null)}>
                  {models.map(option => <ChoiceRow key={option.id} selected={model === option.id} title={option.displayName} onClick={() => { const settings = selectModelSettings(models, option.id, effort); setModel(settings.model); setEffort(settings.effort); setMenu(null) }} />)}
                </ControlMenuShell>
              )}
            </div>
            <div className={`${modelCss.root} cp-menu-anchor`}>
              <button type="button" className={modelCss.trigger} aria-expanded={menu === 'effort'} disabled={settingsDisabled} onClick={() => toggle('effort')}>
                <span className={`${modelCss.triggerEffort} cp-effort`}>{effortLabel(effort, mobileMotion)}</span>
                <IconChevronDownOutline14 className={menu === 'effort' ? modelCss.chevronOpen : modelCss.chevron} />
              </button>
              {(mobileMotion || menu === 'effort') && (
                <ControlMenuShell open={menu === 'effort'} mobileMotion={mobileMotion} onDismiss={() => setMenu(null)}>
                  <div className={modelCss.groupTitle}>推理强度</div>
                  {models.find(option => option.id === model)?.supportedReasoningEfforts.map(option => <ChoiceRow key={option} selected={effort === option} title={effortLabel(option, mobileMotion)} onClick={() => { setEffort(option); setMenu(null) }} />)}
                </ControlMenuShell>
              )}
            </div>
            <button type="button" className={inputCss.primary} aria-label="发送" disabled={disabled || (!draft.trim() && attachments.length === 0)} onClick={onSend}>
              <IconSendOutline16 />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ControlMenuShell({ children, className = '', onDismiss, open = true, mobileMotion = false }: {
  children: React.ReactNode
  className?: string
  onDismiss: () => void
  open?: boolean
  mobileMotion?: boolean
}) {
  const presence = usePanelMotion(open, mobileMotion)
  if (mobileMotion) return presence.mounted ? <div className="cp-motion-menu-layer" data-exiting={!open || undefined} inert={!open || undefined} aria-hidden={!open || undefined}>
    <button ref={presence.scrim} type="button" className="cp-menu-backdrop" aria-hidden="true" tabIndex={-1} onClick={onDismiss} />
    <div ref={presence.panel} className={`${modelCss.menu} cp-control-menu ${className}`} inert={!open || undefined} role={open ? 'dialog' : undefined} aria-modal={open || undefined} aria-label="输入设置">{children}</div>
  </div> : null
  return (
    <>
      <button type="button" className="cp-menu-backdrop" aria-hidden="true" tabIndex={-1} onClick={onDismiss} />
      <div className={`${modelCss.menu} cp-control-menu ${className}`} role="dialog" aria-modal="true" aria-label="输入设置">{children}</div>
    </>
  )
}

function ChoiceRow({ selected, title, detail, onClick }: {
  selected: boolean
  title: string
  detail?: string
  onClick: () => void
}) {
  return (
    <button type="button" className={`${modelCss.option} ${selected ? modelCss.selected : ''}`} aria-pressed={selected} onClick={onClick}>
      <span className={modelCss.optionCopy}><span className={modelCss.modelName}>{title}</span>{detail && <span className={modelCss.description}>{detail}</span>}</span>
      <span className={modelCss.check}>{selected && <IconCheckOutline16 />}</span>
    </button>
  )
}

function EnvironmentPanel({ snapshot, onClose }: { snapshot: TaskSnapshot; onClose: () => void }) {
  return (
    <div className="cp-environment-panel">
      <div className="cp-sheet-handle cp-mobile-only" />
      <div className="cp-environment-title"><strong>环境信息</strong><button type="button" aria-label="关闭环境信息" onClick={onClose}><IconCloseOutline16 /></button></div>
      <div className="cp-environment-section">
        <EnvironmentRow icon={<IconCodeOutline16 />} label="变更" value="3 个文件" />
        <EnvironmentRow icon={<IconFolderClose16 />} label="本机" value={snapshot.workspace.name} />
        <EnvironmentRow icon={<IconBranchOutline16 />} label={snapshot.branch ?? '无分支'} />
        <EnvironmentRow icon={<IconShareOutline16 />} label="提交或推送" muted />
        <EnvironmentRow icon={<span className="cp-github">●</span>} label="尚未连接拉取请求" muted />
      </div>
      <div className="cp-environment-section">
        <div className="cp-section-title">子智能体</div>
        <EnvironmentRow icon={<span className="cp-agent-orbs">✣ ◉ ✦</span>} label="3 完成" />
      </div>
      <div className="cp-environment-section">
        <div className="cp-section-title">来源</div>
        {snapshot.sources.map(source => <EnvironmentRow key={source} icon={<IconDataOutline16 />} label={source.split(/[\\/]/).pop() ?? source} />)}
        <EnvironmentRow icon={<IconBrowseOutline16 />} label="查看全部" muted />
      </div>
      <p className="cp-environment-note">预览只读取本地模拟数据；未接通的动作保持禁用。</p>
    </div>
  )
}

function EnvironmentRow({ icon, label, value, muted = false }: {
  icon: React.ReactNode
  label: string
  value?: string
  muted?: boolean
}) {
  return <div className={`cp-environment-row ${muted ? 'is-muted' : ''}`}><span>{icon}</span><strong>{label}</strong>{value && <small>{value}</small>}{!muted && value && <IconChevronRightOutline14 />}</div>
}

function renderInlineMarkdown(text: string, progressive = false) {
  const chunks = text.split(progressive ? /(`[^`]*(?:`|$)|\*\*[^*]*(?:\*\*|$))/g : /(`[^`]+`|\*\*[^*]+\*\*)/g)
  return chunks.map((chunk, index) => {
    if (progressive && chunk.startsWith('`')) return <code key={index}>{chunk.slice(1).replace(/`$/, '')}</code>
    if (progressive && chunk.startsWith('**')) return <strong key={index}>{chunk.slice(2).replace(/\*\*?$/, '')}</strong>
    if (chunk.startsWith('`') && chunk.endsWith('`')) return <code key={index}>{chunk.slice(1, -1)}</code>
    if (chunk.startsWith('**') && chunk.endsWith('**')) return <strong key={index}>{chunk.slice(2, -2)}</strong>
    return <span key={index}>{chunk}</span>
  })
}
