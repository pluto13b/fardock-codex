import { useState, type FormEvent } from 'react'

import { FormalBootstrap } from './FormalBootstrap.tsx'

export function LocalDemoBootstrap() {
  const [invitationFragment, setInvitationFragment] = useState('')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('123456')
  const [loginPending, setLoginPending] = useState(false)
  const [error, setError] = useState('')

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (loginPending) return
    setLoginPending(true)
    setError('')
    try {
      const response = await fetch('/api/local-demo-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        throw new Error(response.status === 401 ? 'invalid-credentials' : 'demo-unavailable')
      }
      const fragment = typeof body === 'object' && body !== null
        ? (body as { invitationFragment?: unknown }).invitationFragment
        : undefined
      if (typeof fragment !== 'string' || fragment.length === 0 || fragment.length > 16_384) {
        throw new Error('demo-unavailable')
      }
      setInvitationFragment(fragment)
    } catch (reason) {
      setError(reason instanceof Error && reason.message === 'invalid-credentials'
        ? '账户或密码错误。'
        : '本机 Demo Companion 未启动或不可用。')
    } finally {
      setLoginPending(false)
    }
  }

  if (invitationFragment !== '') {
    return <FormalBootstrap invitationFragment={invitationFragment} allowLocalDemoFullAccess />
  }

  return (
    <main className="cp-connect-page">
      <section className="cp-connect-card" aria-labelledby="connect-title">
        <div className="cp-connect-logo" aria-hidden="true">⌘</div>
        <p className="cp-connect-eyebrow">Codex Plus</p>
        <h1 id="connect-title">登录本机 Demo</h1>
        <p>{error || '使用本机测试账户直接连接 Windows Companion。'}</p>
        <form className="cp-demo-login" onSubmit={event => { void login(event) }}>
          <label>
            <span>账户</span>
            <input name="username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} />
          </label>
          <label>
            <span>密码</span>
            <input name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
          </label>
          <button type="submit" disabled={loginPending}>{loginPending ? '正在连接…' : '连接本机 Demo'}</button>
        </form>
        <small>仅用于 127.0.0.1 本机测试；不会读取或上传 OpenAI 账户密码。</small>
      </section>
    </main>
  )
}
