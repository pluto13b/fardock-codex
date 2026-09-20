import { afterEach, expect, it, vi } from 'vitest'
import { createTaskRefresh } from '../src/task-refresh.ts'

afterEach(() => vi.useRealTimers())
it('subtracts request time from the polling interval without burst catch-up', async () => {
  vi.useFakeTimers()
  const read = vi.fn(() => new Promise<void>(done => { setTimeout(done, 800) }))
  const refresh = createTaskRefresh({ isVisible: () => true, read, intervalMs: () => 500, onError: vi.fn() })
  refresh.refresh()
  await vi.advanceTimersByTimeAsync(899)
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(read).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(899)
  expect(read).toHaveBeenCalledTimes(2)
  refresh.stop()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(read).toHaveBeenCalledTimes(2)
})

it('does not overlap reads or poll while hidden, then refreshes immediately on return', async () => {
  vi.useFakeTimers()
  let visible = true
  let resolve!: () => void
  const read = vi.fn(() => new Promise<void>(done => { resolve = done }))
  const refresh = createTaskRefresh({ isVisible: () => visible, read, intervalMs: () => 500, onError: vi.fn() })
  refresh.refresh(); refresh.refresh(); await vi.advanceTimersByTimeAsync(5_000)
  expect(read).toHaveBeenCalledTimes(1)
  visible = false; resolve(); await vi.advanceTimersByTimeAsync(30_000)
  expect(read).toHaveBeenCalledTimes(1)
  visible = true; refresh.refresh()
  expect(read).toHaveBeenCalledTimes(2)
  refresh.stop(); resolve()
})

it('backs off repeated failures instead of a 500ms failure storm', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => { throw new Error('unavailable') })
  const onError = vi.fn()
  const refresh = createTaskRefresh({ isVisible: () => true, read, intervalMs: () => 500, onError })
  refresh.refresh(); await vi.advanceTimersByTimeAsync(3_000)
  expect(read).toHaveBeenCalledTimes(3)
  expect(onError).toHaveBeenLastCalledWith(3)
  refresh.stop()
})
