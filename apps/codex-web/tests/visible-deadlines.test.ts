import { afterEach, describe, expect, it, vi } from 'vitest'
import { VisibleDeadlines } from '../src/visible-deadlines.ts'

afterEach(() => vi.useRealTimers())
describe('visible operational deadlines', () => {
  it('suspends outstanding deadlines and rearms them with time to process queued responses', () => {
    vi.useFakeTimers()
    const deadlines = new VisibleDeadlines()
    const timeout = vi.fn()
    deadlines.after(1_000, timeout)
    vi.advanceTimersByTime(900)
    deadlines.setActive(false)
    vi.advanceTimersByTime(60_000)
    expect(timeout).not.toHaveBeenCalled()
    deadlines.setActive(true)
    vi.advanceTimersByTime(999)
    expect(timeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timeout).toHaveBeenCalledTimes(1)
  })
  it('cancels a received response while hidden without resurrecting its timeout', () => {
    vi.useFakeTimers()
    const deadlines = new VisibleDeadlines()
    deadlines.setActive(false)
    const timeout = vi.fn()
    deadlines.after(1_000, timeout).cancel()
    deadlines.setActive(true)
    vi.advanceTimersByTime(60_000)
    expect(timeout).not.toHaveBeenCalled()
  })
})
