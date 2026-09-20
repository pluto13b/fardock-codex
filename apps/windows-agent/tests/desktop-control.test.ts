import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { runDesktopControl } from '../src/desktop-control.ts'

describe('desktop private process control', () => {
  it('accepts one local pairing request after start and ignores repeated clicks while busy', async () => {
    const pipe = new PassThrough()
    let complete!: () => void
    const pair = vi.fn(() => new Promise<void>(resolve => { complete = resolve }))
    const done = runDesktopControl(pipe, signal => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())), pair)
    pipe.write('start\npair\npair\n')
    expect(pair).toHaveBeenCalledOnce()
    complete()
    await new Promise(resolve => setImmediate(resolve))
    pipe.write('pair\n')
    expect(pair).toHaveBeenCalledTimes(2)
    complete()
    pipe.write('stop\n')
    await done
    pipe.write('pair\n')
    expect(pair).toHaveBeenCalledTimes(2)
  })
  it('does not start until the Job owner releases the gate and stops gracefully', async () => {
    const pipe = new PassThrough()
    let aborted = false
    const run = vi.fn((signal: AbortSignal) => new Promise<void>(resolve => {
      signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
    }))
    const done = runDesktopControl(pipe, run)
    expect(run).not.toHaveBeenCalled()
    pipe.write('sta'); expect(run).not.toHaveBeenCalled()
    pipe.write('rt\r\n'); expect(run).toHaveBeenCalledOnce()
    pipe.write('stop\n'); await done
    expect(aborted).toBe(true)
  })
  it('stops on pipe loss without keeping an orphan backend alive', async () => {
    const pipe = new PassThrough()
    const run = vi.fn((signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())))
    const done = runDesktopControl(pipe, run)
    pipe.write('start\n'); pipe.end()
    await done
    expect(run).toHaveBeenCalledOnce()
  })
  it('rejects unbounded or unknown control without starting anything', async () => {
    for (const line of ['run-anything\n', 'pair\n', 'x'.repeat(65)]) {
      const pipe = new PassThrough()
      const run = vi.fn(async () => {})
      const done = runDesktopControl(pipe, run)
      pipe.write(line)
      await expect(done).rejects.toThrow('invalid-control')
      expect(run).not.toHaveBeenCalled()
    }
  })
  it('allows stop before start and never starts again on the closed pipe', async () => {
    const pipe = new PassThrough()
    const run = vi.fn(async () => {})
    const done = runDesktopControl(pipe, run)
    pipe.write('stop\n'); await done
    pipe.write('start\n')
    expect(run).not.toHaveBeenCalled()
  })
})
