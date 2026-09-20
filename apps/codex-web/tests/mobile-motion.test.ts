import { afterEach, expect, it, vi } from 'vitest'
import { createFrameBatch, MOBILE_FRAME_MS } from '../src/mobile-motion.ts'

afterEach(() => vi.unstubAllGlobals())

function frames() {
  let next = 0
  const pending = new Map<number, FrameRequestCallback>()
  const page = { visibilityState: 'visible' }
  vi.stubGlobal('document', page)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { pending.set(++next, callback); return next })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id))
  return { pending, page, run(time: number) { const jobs = [...pending.values()]; pending.clear(); for (const job of jobs) job(time) } }
}

it('coalesces resize bursts and does not leave an idle rAF loop', () => {
  const clock = frames(), work = vi.fn(), batch = createFrameBatch(work)
  batch.request(); batch.request(); batch.request()
  expect(clock.pending.size).toBe(1)
  clock.run(0)
  expect(work).toHaveBeenCalledTimes(1)
  expect(clock.pending.size).toBe(0)
})

it('uses the 60 fps deadline on higher refresh frames', () => {
  const clock = frames(), work = vi.fn(), batch = createFrameBatch(work)
  expect(MOBILE_FRAME_MS).toBeCloseTo(16.6667, 3)
  batch.request(); clock.run(0)
  batch.request(); clock.run(8.33)
  expect(work).toHaveBeenCalledTimes(1)
  clock.run(16.67)
  expect(work).toHaveBeenCalledTimes(2)
  expect(clock.pending.size).toBe(0)
})

it('cancels when hidden or disposed, and can resume after visibility returns', () => {
  const clock = frames(), work = vi.fn(), batch = createFrameBatch(work)
  batch.request(); batch.cancel(); clock.run(0)
  expect(work).not.toHaveBeenCalled()
  clock.page.visibilityState = 'hidden'; batch.request()
  expect(clock.pending.size).toBe(0)
  clock.page.visibilityState = 'visible'; batch.request(); clock.run(20)
  expect(work).toHaveBeenCalledTimes(1)
  batch.request(); batch.dispose(); clock.run(40); batch.request()
  expect(work).toHaveBeenCalledTimes(1)
  expect(clock.pending.size).toBe(0)
})
