import { useCallback, useEffect, useState } from 'react'
import type {
  CodexServeClient,
  ManagedDevice,
  ManagementEvent,
  ManagementLayers,
  ManagementSnapshot,
} from '@codex-plus/serve-client'

import { registerPairingCode } from './pairing-code-client.ts'

const layerRows: ReadonlyArray<{
  key: keyof ManagementLayers
  label: string
  detail: string
}> = [
  { key: 'gateway', label: 'Gateway', detail: '正式 Web 与加密 WebSocket 入口可达' },
  { key: 'relaySocket', label: 'Relay socket', detail: '当前浏览器已通过 Relay 设备认证' },
  { key: 'host', label: 'Windows Host', detail: 'Windows 端已接收本次加密请求' },
  { key: 'e2ee', label: '端到端加密', detail: '当前 generation 的会话已就绪' },
  { key: 'companion', label: 'Companion', detail: 'Host dispatcher 正在服务本次请求' },
  { key: 'appServer', label: 'Codex app-server', detail: '由 Windows runtime compatibility 判定' },
]

const stateLabels: Record<string, string> = {
  healthy: '健康',
  authenticated: '已认证',
  online: '在线',
  ready: '已就绪',
  compatible: '兼容可写',
  'read-only': '只读',
  unavailable: '不可用',
  offline: '离线',
  unknown: '未知',
  active: '已授权',
  revoked: '已撤销',
}

const eventLabels: Record<ManagementEvent['category'], string> = {
  gateway: 'Gateway',
  relay: 'Relay socket',
  host: 'Windows Host',
  e2ee: '端到端加密',
  companion: 'Companion',
  'app-server': 'Codex app-server',
  device: '当前设备',
}

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function formatTime(value: number | null): string {
  return value === null ? '暂无可信记录' : dateTime.format(new Date(value))
}

function shortFingerprint(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 9)}…${value.slice(-8)}`
}

function actionId(prefix: string): string {
  return `${prefix}.${globalThis.crypto.randomUUID()}`
}

function DeviceCard({
  device,
  busy,
  editing,
  editName,
  confirmingRevoke,
  onBeginRename,
  onEditName,
  onRename,
  onCancelRename,
  onBeginRevoke,
  onRevoke,
  onCancelRevoke,
}: {
  device: ManagedDevice
  busy: boolean
  editing: boolean
  editName: string
  confirmingRevoke: boolean
  onBeginRename: () => void
  onEditName: (value: string) => void
  onRename: () => void
  onCancelRename: () => void
  onBeginRevoke: () => void
  onRevoke: () => void
  onCancelRevoke: () => void
}) {
  return (
    <article className="cp-manage-device">
      <div className="cp-manage-device-head">
        <div>
          <h3>{device.displayName}</h3>
          <p>{device.isCurrent ? '当前已认证设备' : `设备 ${device.shortId}`}</p>
        </div>
        <span className={`cp-manage-badge cp-manage-badge-${device.status}`}>
          {stateLabels[device.status]}
        </span>
      </div>
      <dl className="cp-manage-device-meta">
        <div><dt>Presence</dt><dd>{stateLabels[device.presence]}</dd></div>
        <div><dt>授权 epoch</dt><dd>{device.authorizationEpoch}</dd></div>
        <div><dt>配对时间</dt><dd>{formatTime(device.pairedAt)}</dd></div>
        <div><dt>最近在线</dt><dd>{formatTime(device.lastSeenAt)}</dd></div>
        <div className="cp-manage-device-wide">
          <dt>签名指纹</dt>
          <dd title={device.signingFingerprint}>{shortFingerprint(device.signingFingerprint)}</dd>
        </div>
      </dl>
      {device.status === 'active' && (
        <div className="cp-manage-device-actions">
          {editing ? (
            <>
              <input aria-label="设备名称" maxLength={80} value={editName} disabled={busy} onChange={event => onEditName(event.currentTarget.value)} />
              <button type="button" disabled={busy || editName.trim() !== editName || editName.length < 1} onClick={onRename}>保存</button>
              <button type="button" disabled={busy} onClick={onCancelRename}>取消</button>
            </>
          ) : confirmingRevoke ? (
            <>
              <span>确认撤销此设备？</span>
              <button type="button" className="cp-manage-danger" disabled={busy} onClick={onRevoke}>确认撤销</button>
              <button type="button" disabled={busy} onClick={onCancelRevoke}>取消</button>
            </>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={onBeginRename}>重命名</button>
              <button type="button" className="cp-manage-danger" disabled={busy || device.isCurrent} title={device.isCurrent ? '当前远程设备不能撤销自身' : undefined} onClick={onBeginRevoke}>撤销</button>
            </>
          )}
        </div>
      )}
    </article>
  )
}

export function ManagePage({
  client,
  preview = false,
  canCreatePairing = false,
  connectionState = 'online',
  returnHref = '/',
}: {
  client: CodexServeClient
  preview?: boolean
  canCreatePairing?: boolean
  connectionState?: 'online' | 'reconnecting'
  returnHref?: string
}) {
  const [snapshot, setSnapshot] = useState<ManagementSnapshot>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [editingDevice, setEditingDevice] = useState('')
  const [editName, setEditName] = useState('')
  const [confirmingRevoke, setConfirmingRevoke] = useState('')
  const [pairing, setPairing] = useState<Readonly<{
    code: string
    expiresAt: number
  }>>()

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSnapshot(await client.readManagement())
    } catch {
      setError('无法从 Windows Host 读取管理状态。连接或授权不明确，已保持只读关闭。')
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    if (connectionState === 'online') void refresh()
  }, [connectionState, refresh])

  const createPairing = async () => {
    if (connectionState !== 'online') return
    if (!canCreatePairing || snapshot === undefined || busyAction !== '') return
    setBusyAction('pairing')
    setActionError('')
    try {
      const receipt = await client.createPairing({
        actionId: actionId('pairing'),
        expected: { hostId: snapshot.hostId, connectionGeneration: snapshot.connectionGeneration },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      if (receipt.state !== 'accepted') throw new Error('配对邀请结果尚不明确，请勿重复生成。')
      setPairing(await registerPairingCode({
        invitationFragment: receipt.invitationFragment,
        expiresAt: receipt.expiresAt,
      }))
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '无法生成配对邀请。')
    } finally {
      setBusyAction('')
    }
  }

  const renameDevice = async (device: ManagedDevice) => {
    if (connectionState !== 'online') return
    if (snapshot === undefined || busyAction !== '') return
    setBusyAction(device.authorizationId)
    setActionError('')
    try {
      const receipt = await client.renameDevice({
        actionId: actionId('rename'),
        deviceId: device.deviceId,
        authorizationId: device.authorizationId,
        authorizationEpoch: device.authorizationEpoch,
        displayName: editName,
        expected: { hostId: snapshot.hostId, connectionGeneration: snapshot.connectionGeneration },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      if (receipt.state !== 'accepted') throw new Error('重命名结果尚不明确，请勿重复操作。')
      setEditingDevice('')
      await refresh()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '无法重命名设备。')
    } finally {
      setBusyAction('')
    }
  }

  const revokeDevice = async (device: ManagedDevice) => {
    if (connectionState !== 'online') return
    if (snapshot === undefined || busyAction !== '' || device.isCurrent) return
    setBusyAction(device.authorizationId)
    setActionError('')
    try {
      const receipt = await client.revokeDevice({
        actionId: actionId('revoke'),
        deviceId: device.deviceId,
        authorizationId: device.authorizationId,
        authorizationEpoch: device.authorizationEpoch,
        expected: { hostId: snapshot.hostId, connectionGeneration: snapshot.connectionGeneration },
      })
      if (receipt.state === 'rejected') throw new Error(receipt.rejection.message)
      if (receipt.state !== 'accepted') {
        await refresh()
        throw new Error('Windows 已优先撤销；Relay 同步待确认，请刷新状态。')
      }
      setConfirmingRevoke('')
      await refresh()
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '无法撤销设备。')
    } finally {
      setBusyAction('')
    }
  }

  return (
    <main className="cp-manage-page">
      <div className="cp-manage-shell">
        {connectionState !== 'online' && <p role="status">正在恢复连接，以下为上次读取的状态，暂不可操作。</p>}
        <header className="cp-manage-header">
          <div>
            <p className="cp-manage-eyebrow">Codex Plus · 设备管理</p>
            <h1>设备与连接</h1>
            <p>{preview ? '以下为本地模拟数据，未连接真实设备或服务。' : '状态来自当前已配对设备与 Windows Host 的端到端加密响应。'}</p>
          </div>
          <div className="cp-manage-header-actions">
            {preview && <span className="cp-manage-preview">离线预览</span>}
            <a href={returnHref}>返回任务</a>
            <button type="button" onClick={() => { void refresh() }} disabled={loading}>
              {loading ? '读取中…' : '刷新状态'}
            </button>
          </div>
        </header>

        {error !== '' && <p className="cp-manage-error" role="alert">{error}</p>}
        {actionError !== '' && <p className="cp-manage-error" role="alert">{actionError}</p>}

        {snapshot === undefined ? (
          <section className="cp-manage-loading" aria-live="polite">
            {loading ? '正在读取加密管理快照…' : '当前没有可显示的受信快照。'}
          </section>
        ) : (
          <>
            <section className="cp-manage-section" aria-labelledby="connection-title">
              <div className="cp-manage-section-title">
                <div>
                  <h2 id="connection-title">连接链路</h2>
                  <p>每一层独立报告，不把 Relay 回执当作 Codex 已接受。</p>
                </div>
                <time dateTime={new Date(snapshot.generatedAt).toISOString()}>
                  更新于 {formatTime(snapshot.generatedAt)}
                </time>
              </div>
              <div className="cp-manage-layers">
                {layerRows.map((layer, index) => {
                  const state = snapshot.layers[layer.key]
                  const warning = state === 'read-only' || state === 'unavailable'
                  return (
                    <article className="cp-manage-layer" key={layer.key}>
                      <span className={`cp-manage-layer-index${warning ? ' cp-manage-layer-warning' : ''}`} aria-hidden="true">
                        {index + 1}
                      </span>
                      <div><h3>{layer.label}</h3><p>{layer.detail}</p></div>
                      <strong className={warning ? 'cp-manage-state-warning' : ''}>{stateLabels[state]}</strong>
                    </article>
                  )
                })}
              </div>
            </section>

            <section className="cp-manage-section" aria-labelledby="devices-title">
              <div className="cp-manage-section-title">
                <div>
                  <h2 id="devices-title">已知设备</h2>
                  <p>{snapshot.devices.length} 台 · 非当前 active 设备没有实时 authority 时显示“未知”。</p>
                </div>
                <button
                  type="button"
                  className="cp-manage-pair-button"
                  disabled={!canCreatePairing || busyAction !== ''}
                  title={canCreatePairing ? undefined : preview ? '离线预览不生成真实配对码' : '当前 Windows Host 暂未开放新增设备'}
                  onClick={() => { void createPairing() }}
                >
                  {busyAction === 'pairing' ? '生成中…' : '生成配对码'}
                </button>
              </div>
              {pairing !== undefined && (
                <div className="cp-manage-pairing" role="status">
                  <div className="cp-manage-pairing-content">
                    <div><strong>一次性配对码</strong><span>手机登录同一账户后输入；有效至 {formatTime(pairing.expiresAt)}，成功使用后立即失效。</span></div>
                    <div className="cp-manage-pairing-controls">
                      <output className="cp-manage-pairing-code" aria-label="一次性配对码">{pairing.code}</output>
                      <button type="button" onClick={() => {
                        void navigator.clipboard.writeText(pairing.code).catch(() => setActionError('无法访问剪贴板，请手动输入配对码。'))
                      }}>复制配对码</button>
                    </div>
                  </div>
                </div>
              )}
              <div className="cp-manage-devices">
                {snapshot.devices.map(device => (
                  <DeviceCard
                    key={device.authorizationId}
                    device={device}
                    busy={busyAction !== ''}
                    editing={editingDevice === device.authorizationId}
                    editName={editName}
                    confirmingRevoke={confirmingRevoke === device.authorizationId}
                    onBeginRename={() => {
                      setConfirmingRevoke('')
                      setEditingDevice(device.authorizationId)
                      setEditName(device.displayName)
                    }}
                    onEditName={setEditName}
                    onRename={() => { void renameDevice(device) }}
                    onCancelRename={() => setEditingDevice('')}
                    onBeginRevoke={() => {
                      setEditingDevice('')
                      setConfirmingRevoke(device.authorizationId)
                    }}
                    onRevoke={() => { void revokeDevice(device) }}
                    onCancelRevoke={() => setConfirmingRevoke('')}
                  />
                ))}
              </div>
              <p className="cp-manage-d5-note">{preview ? '离线预览不生成真实配对码；重命名与撤销仅影响本地模拟设备。' : `${canCreatePairing ? '由当前已授权设备生成的配对码会由 Windows 后台批准；' : '当前 Windows Host 暂未开放新增设备；'}撤销先写 Windows 权威，再同步 Relay。当前远程设备不能撤销自身。`}</p>
            </section>

            <section className="cp-manage-section" aria-labelledby="events-title">
              <div className="cp-manage-section-title">
                <div>
                  <h2 id="events-title">本次连接事件</h2>
                  <p>仅显示固定白名单状态，不包含任务正文、路径或密文。</p>
                </div>
              </div>
              <ol className="cp-manage-events">
                {snapshot.events.map(event => (
                  <li key={event.eventId}>
                    <span aria-hidden="true" />
                    <div><strong>{eventLabels[event.category]}</strong><p>{stateLabels[event.state]}</p></div>
                    <time dateTime={new Date(event.occurredAt).toISOString()}>{formatTime(event.occurredAt)}</time>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
      </div>
    </main>
  )
}
