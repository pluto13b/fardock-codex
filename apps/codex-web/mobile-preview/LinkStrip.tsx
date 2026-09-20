import type { ConnectionState } from '@codex-plus/serve-client'
import { IconLinkOutline14 } from '../src/vendor/dsh-icons/index.tsx'

export function MobilePreviewLinkStrip({ state, running }: { state: ConnectionState; running: boolean }) {
  const online = state === 'online'
  const label = state === 'online' ? '电脑在线' : state === 'reconnecting' ? '恢复中' : '电脑离线'
  return (
    <div className="cp-link-strip" data-state={state} data-running={online && running || undefined} role="status" aria-label="模拟链路状态">
      <span className="cp-link-demo" title="离线界面预览，未连接真实服务">模拟</span>
      <span className="cp-link-state"><i className="cp-link-dot" key={state} aria-hidden="true" />{label}</span>
      {/* A fixed presentation sample, never a measurement of fixture execution. */}
      <span className="cp-link-latency" title="模拟链路往返延迟，不包含模型生成时间" aria-label={online ? '模拟往返延迟 48 毫秒' : '当前没有可用延迟数据'}>
        <IconLinkOutline14 /><span className="cp-link-value" key={state}>{online ? '48' : '—'}<small>ms</small></span>
      </span>
      <span className="cp-link-security">{online ? '已加密' : '只读'}</span>
    </div>
  )
}
