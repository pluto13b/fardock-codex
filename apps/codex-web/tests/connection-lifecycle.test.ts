import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFixtureCodexServeClient } from '../../../packages/codex-serve-client/src/fixture.ts'
import type { EphemeralPairedClient } from '../src/paired-client.ts'
import { createConnectionLifecycle } from '../src/connection-lifecycle.ts'

function endpoint() {
  let disconnect: (() => void) | undefined
  const client = createFixtureCodexServeClient()
  const read = vi.spyOn(client, 'listWorkspaces')
  const paired: EphemeralPairedClient = {
    client, permissionModes: ['ask'], close: vi.fn(async () => {}),
    onUnexpectedDisconnect: listener => { disconnect = () => listener(new Error('closed')); return () => { disconnect = undefined } },
  }
  return { paired, read, disconnect: () => disconnect?.() }
}

afterEach(() => vi.useRealTimers())
describe('foreground connection recovery', () => {
  it('keeps a healthy session across background/foreground and coalesces foreground checks', async () => {
    vi.useFakeTimers()
    const target = endpoint()
    const connect = vi.fn(async () => target.paired)
    const onReady = vi.fn()
    const lifecycle = createConnectionLifecycle({ invitationFragment: '', connect, isVisible: () => true, onReady, onReconnecting: vi.fn(), onFailure: vi.fn() })
    lifecycle.start(); await vi.advanceTimersByTimeAsync(0)
    lifecycle.background(); lifecycle.foreground(); lifecycle.foreground()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(target.read).toHaveBeenCalledTimes(1)
    expect(target.paired.close).not.toHaveBeenCalled()
    expect(onReady).toHaveBeenCalledTimes(2)
    lifecycle.stop()
  })
  it('reconnects once on foreground when the socket failed in the background', async () => {
    vi.useFakeTimers()
    let visible = true
    const first = endpoint(); const second = endpoint()
    const connect = vi.fn().mockResolvedValueOnce(first.paired).mockResolvedValue(second.paired)
    const lifecycle = createConnectionLifecycle({ invitationFragment: '', connect, isVisible: () => visible, onReady: vi.fn(), onReconnecting: vi.fn(), onFailure: vi.fn() })
    lifecycle.start(); await vi.advanceTimersByTimeAsync(0)
    visible = false; first.disconnect(); await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(1)
    visible = true; lifecycle.foreground(); lifecycle.foreground(); await vi.advanceTimersByTimeAsync(0)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect).toHaveBeenLastCalledWith('')
    lifecycle.stop()
  })
  it('resumes an idle retained session without replacing the client or consuming another invitation', async () => {
    vi.useFakeTimers()
    let visible = true
    const target = endpoint()
    target.paired.tryResume = vi.fn(async () => true)
    target.paired.setPageVisible = vi.fn()
    const connect = vi.fn(async () => target.paired)
    const onReady = vi.fn()
    const lifecycle = createConnectionLifecycle({ invitationFragment: 'initial-only', connect, isVisible: () => visible, onReady, onReconnecting: vi.fn(), onFailure: vi.fn() })
    lifecycle.start(); await vi.advanceTimersByTimeAsync(0)
    visible = false; lifecycle.background(); target.disconnect()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(target.paired.setPageVisible).toHaveBeenLastCalledWith(false)
    expect(target.paired.close).not.toHaveBeenCalled()
    visible = true; lifecycle.foreground(); lifecycle.foreground()
    await vi.advanceTimersByTimeAsync(0)
    expect(target.paired.tryResume).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(onReady).toHaveBeenLastCalledWith(target.paired)
    expect(target.paired.setPageVisible).toHaveBeenLastCalledWith(true)
    lifecycle.stop()
    expect(target.paired.close).toHaveBeenCalledTimes(1)
  })
  it('uses the physical socket check before issuing a session request on foreground', async () => {
    vi.useFakeTimers()
    const target = endpoint()
    target.paired.checkConnection = vi.fn(async () => false)
    target.paired.tryResume = vi.fn(async () => true)
    const connect = vi.fn(async () => target.paired)
    const lifecycle = createConnectionLifecycle({ invitationFragment: '', connect, isVisible: () => true, onReady: vi.fn(), onReconnecting: vi.fn(), onFailure: vi.fn() })
    lifecycle.start(); await vi.advanceTimersByTimeAsync(0)
    lifecycle.background(); lifecycle.foreground()
    await vi.advanceTimersByTimeAsync(0)
    expect(target.paired.checkConnection).toHaveBeenCalledTimes(1)
    expect(target.read).not.toHaveBeenCalled()
    expect(target.paired.tryResume).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    lifecycle.stop()
  })
  it('coalesces a connection check across rapid background and foreground events', async () => {
    vi.useFakeTimers()
    let release!: (ok: boolean) => void
    const target = endpoint()
    target.paired.checkConnection = vi.fn(() => new Promise<boolean>(resolve => { release = resolve }))
    target.paired.setPageVisible = vi.fn()
    const connect = vi.fn(async () => target.paired)
    const lifecycle = createConnectionLifecycle({ invitationFragment: '', connect, isVisible: () => true, onReady: vi.fn(), onReconnecting: vi.fn(), onFailure: vi.fn() })
    lifecycle.start(); await vi.advanceTimersByTimeAsync(0)
    lifecycle.background(); lifecycle.foreground(); lifecycle.background(); lifecycle.foreground()
    release(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(target.paired.checkConnection).toHaveBeenCalledTimes(1)
    expect(target.paired.setPageVisible).toHaveBeenLastCalledWith(true)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(target.paired.close).not.toHaveBeenCalled()
    lifecycle.stop()
  })
  it('replaces a half-open channel after a bounded authenticated foreground probe', async () => {
    vi.useFakeTimers()
    const first = endpoint(); const second = endpoint()
    first.read.mockImplementation(() => new Promise(() => {}))
    const connect = vi.fn().mockResolvedValueOnce(first.paired).mockResolvedValue(second.paired)
    const lifecycle = createConnectionLifecycle({ invitationFragment: '', connect, isVisible: () => true, onReady: vi.fn(), onReconnecting: vi.fn(), onFailure: vi.fn() })
    lifecycle.start(); await vi.advanceTimersByTimeAsync(0)
    lifecycle.foreground(); await vi.advanceTimersByTimeAsync(4_300)
    expect(first.paired.close).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(2)
    lifecycle.stop()
  })
})
