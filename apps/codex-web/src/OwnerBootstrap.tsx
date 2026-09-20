import { useEffect, useState, type FormEvent } from 'react'

import { FormalBootstrap } from './FormalBootstrap.tsx'

type OwnerSession = Readonly<{ authenticated: true; username: string }>

function ownerSession(value: unknown): OwnerSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 2
    || keys[0] !== 'authenticated'
    || keys[1] !== 'username'
    || record.authenticated !== true
    || typeof record.username !== 'string'
    || record.username.length < 1
    || record.username.length > 128
  ) return undefined
  return Object.freeze({ authenticated: true, username: record.username })
}

export function OwnerBootstrap({ invitationFragment }: { invitationFragment: string }) {
  const [session, setSession] = useState<OwnerSession>()
  const [checking, setChecking] = useState(true)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    }).then(async response => {
      const value: unknown = await response.json()
      if (!cancelled) setSession(ownerSession(value))
    }).catch(() => {
      if (!cancelled) setError('登录服务暂不可用。')
    }).finally(() => {
      if (!cancelled) setChecking(false)
    })
    return () => { cancelled = true }
  }, [])

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const value: unknown = await response.json()
      const authenticated = ownerSession(value)
      if (!response.ok || authenticated === undefined) {
        throw new Error(response.status === 429 ? 'rate-limited' : 'invalid')
      }
      setPassword('')
      setSession(authenticated)
    } catch (reason) {
      setError(reason instanceof Error && reason.message === 'rate-limited'
        ? '尝试次数过多，请一分钟后再试。'
        : '账户或密码错误。')
    } finally {
      setPending(false)
    }
  }

  const logout = async () => {
    if (pending) return
    setPending(true)
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
    } finally {
      setSession(undefined)
      setPassword('')
      setPending(false)
    }
  }

  if (session !== undefined) {
    return (
      <>
        <button className="cp-owner-logout" type="button" disabled={pending} onClick={() => { void logout() }}>
          {pending ? '正在退出…' : `${session.username} · 退出`}
        </button>
        <FormalBootstrap invitationFragment={invitationFragment} />
      </>
    )
  }

  return (
    <main className="cp-connect-page">
      <section className="cp-connect-card" aria-labelledby="owner-login-title">
        <div className="cp-connect-logo" aria-hidden="true">⌘</div>
        <p className="cp-connect-eyebrow">Codex Plus</p>
        <h1 id="owner-login-title">登录 Owner 账户</h1>
        <p>{checking ? '正在检查登录状态…' : error || '登录后管理你已登记的 Windows 主机和 Codex 对话。'}</p>
        {!checking && (
          <form className="cp-demo-login" onSubmit={event => { void login(event) }}>
            <label>
              <span>账户</span>
              <input
                name="username"
                autoComplete="username"
                value={username}
                onChange={event => setUsername(event.target.value)}
                maxLength={128}
                required
              />
            </label>
            <label>
              <span>密码</span>
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                minLength={8}
                maxLength={512}
                required
              />
            </label>
            <button type="submit" disabled={pending}>{pending ? '正在登录…' : '登录'}</button>
          </form>
        )}
        <small>密码只用于 Gateway owner 会话；Codex 凭据不会发送到服务器。</small>
      </section>
    </main>
  )
}
