import { useEffect, useState, type FormEvent } from 'react'
import type { CodexServeClient } from '@codex-plus/serve-client'

import { App } from './App.tsx'
import { ManagePage } from './ManagePage.tsx'
import { normalizePairingCode, redeemPairingCode } from './pairing-code-client.ts'
import { createConnectionLifecycle } from './connection-lifecycle.ts'

type PairingStage = 'restoring' | 'idle' | 'pairing' | 'authenticating' | 'establishing-session' | 'reconnecting'

const stageText: Record<PairingStage, string> = {
  restoring: '正在恢复此浏览器保存的设备连接…',
  idle: '账户已登录。在 Windows 软件点击“连接手机”，输入生成的 8 位配对码。',
  pairing: '正在验证配对码并绑定当前设备…',
  authenticating: '设备已绑定，正在连接 Relay…',
  'establishing-session': '正在建立端到端加密会话…',
  reconnecting: '连接已中断，正在使用已保存的设备授权重连…',
}

const failureText: Readonly<Record<string, string>> = Object.freeze({
  'invitation-expired': '配对码已过期，请在 Windows 软件重新点击“连接手机”。',
  'invitation-invalid': '配对码无效，请在 Windows 软件重新点击“连接手机”。',
  'pairing-denied': '本次设备绑定未完成，请重新生成配对码。',
  'pairing-unavailable': 'Windows Companion 或配对服务暂不可用，请重新生成配对码。',
  'storage-unavailable': '当前浏览器无法安全保存设备密钥，请检查 Chrome 站点存储设置。',
  failed: '配对失败，请重新生成配对码。',
})

export function FormalBootstrap({
  invitationFragment,
  allowLocalDemoFullAccess = false,
}: {
  invitationFragment: string
  allowLocalDemoFullAccess?: boolean
}) {
  const activeInvitationFragment = invitationFragment
  const [stage, setStage] = useState<PairingStage>(invitationFragment === '' ? 'restoring' : 'pairing')
  const [client, setClient] = useState<CodexServeClient>()
  const [connectionState, setConnectionState] = useState<'online' | 'reconnecting'>('reconnecting')
  const [error, setError] = useState('')
  const [fullAccessEnabled, setFullAccessEnabled] = useState(false)
  const [resettingDevice, setResettingDevice] = useState(false)
  const [pairingCode, setPairingCode] = useState('')
  const [redeemingCode, setRedeemingCode] = useState(false)

  const redeemCode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = normalizePairingCode(pairingCode)
    if (redeemingCode || normalized.length !== 8) return
    setRedeemingCode(true)
    setError('')
    try {
      const redeemed = await redeemPairingCode(normalized)
      if (redeemed === undefined) {
        setError('invitation-invalid')
        return
      }
      window.location.assign(`/pair#${redeemed.invitationFragment}`)
    } catch {
      setError('pairing-unavailable')
    } finally {
      setRedeemingCode(false)
    }
  }

  const resetStoredDevice = async () => {
    if (resettingDevice) return
    setResettingDevice(true)
    setError('')
    let store: Awaited<ReturnType<(typeof import('./browser-device-store.ts'))['openBrowserDeviceStore']>> | undefined
    try {
      const { openBrowserDeviceStore } = await import('./browser-device-store.ts')
      store = await openBrowserDeviceStore()
      await store.clear()
      store.close()
      store = undefined
      window.location.assign('/')
    } catch {
      store?.close()
      setError('storage-unavailable')
      setResettingDevice(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const lifecycle = createConnectionLifecycle({
      invitationFragment: activeInvitationFragment,
      isVisible: () => document.visibilityState !== 'hidden',
      connect: async fragment => {
        const { createEphemeralPairedClient } = await import('./paired-client.ts')
        return createEphemeralPairedClient({ invitationFragment: fragment,
          onStage: next => { if (!cancelled) setStage(next) },
        })
      },
      onReady: paired => {
        setClient(paired.client)
        setFullAccessEnabled(paired.permissionModes.includes('full-access'))
        setConnectionState(document.visibilityState === 'hidden' ? 'reconnecting' : 'online')
        setError('')
      },
      onReconnecting: () => {
        setConnectionState('reconnecting')
        setStage('reconnecting')
      },
      onFailure: detail => { setStage('idle'); setError(detail === 'unpaired' ? '' : detail) },
    })
    const foreground = () => lifecycle.foreground()
    const visibility = () => { if (document.visibilityState === 'hidden') lifecycle.background(); else foreground() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', foreground)
    window.addEventListener('pageshow', foreground)
    lifecycle.start()
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', foreground)
      window.removeEventListener('pageshow', foreground)
      lifecycle.stop()
    }
  }, [activeInvitationFragment])

  if (client !== undefined) {
    return window.location.pathname === '/manage'
      ? <ManagePage client={client} canCreatePairing connectionState={connectionState} />
      : <App client={client} fullAccessEnabled={fullAccessEnabled} connectionState={connectionState} managedConnection />
  }

  return (
    <main className="cp-connect-page">
      <section className="cp-connect-card" aria-labelledby="connect-title">
        <div className="cp-connect-logo" aria-hidden="true">⌘</div>
        <p className="cp-connect-eyebrow">Codex Plus</p>
        <h1 id="connect-title">连接 Windows 主机</h1>
        <p>{error !== '' ? (failureText[error] ?? failureText.failed) : stageText[stage]}</p>
        {activeInvitationFragment === '' && stage === 'idle'
          ? (
              <form className="cp-demo-login cp-pairing-code-form" onSubmit={event => { void redeemCode(event) }}>
                <label>
                  <span>8 位配对码</span>
                  <input
                    name="pairing-code"
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="one-time-code"
                    spellCheck={false}
                    maxLength={11}
                    value={pairingCode}
                    onChange={event => setPairingCode(normalizePairingCode(event.currentTarget.value))}
                    placeholder="例如 8K3M2P7R"
                    required
                  />
                </label>
                <button type="submit" disabled={redeemingCode || pairingCode.length !== 8}>
                  {redeemingCode ? '正在连接…' : '连接此设备'}
                </button>
              </form>
            )
          : activeInvitationFragment === '' && stage === 'reconnecting'
            ? <button type="button" disabled={resettingDevice} onClick={() => { void resetStoredDevice() }}>{resettingDevice ? '正在清除…' : '清除旧授权并重新配对'}</button>
            : <button type="button" disabled>{error !== '' ? '配对失败' : '正在连接'}</button>}
        <small>首次输入配对码后会保存本设备授权；以后登录账户即可直接恢复连接。</small>
      </section>
    </main>
  )
}
