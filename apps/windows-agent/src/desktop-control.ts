import type { Readable } from 'node:stream'

/** Private inherited stdin, never a network endpoint. No work before the owner
 * has assigned this process to its Job and sends the start gate. */
export async function runDesktopControl(
  input: Readable,
  run: (signal: AbortSignal) => Promise<void>,
  pair?: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  let started = false
  let settled = false
  let pairing = false
  let buffer = ''
  let resolveDone!: () => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject })
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    clearTimeout(gateTimer)
    controller.abort()
    if (error === undefined) resolveDone(); else rejectDone(error)
  }
  const stop = () => { controller.abort(); if (!started) finish() }
  const gateTimer = setTimeout(() => finish(new Error('desktop:start-timeout')), 10_000)
  const data = (chunk: Buffer | string) => {
    if (settled) return
    buffer += chunk.toString()
    if (buffer.length > 64) { finish(new Error('desktop:invalid-control')); return }
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const command = buffer.slice(0, end).replace(/\r$/u, '')
      buffer = buffer.slice(end + 1)
      if (command === 'start' && !started && !controller.signal.aborted) {
        started = true
        clearTimeout(gateTimer)
        void run(controller.signal).then(() => finish(), () => finish(new Error('desktop:backend-failed')))
      } else if (command === 'pair' && started && !controller.signal.aborted && pair !== undefined) {
        if (!pairing) {
          pairing = true
          void pair().catch(() => finish(new Error('desktop:pairing-handler-failed'))).finally(() => { pairing = false })
        }
      } else if (command === 'stop') stop()
      else { finish(new Error('desktop:invalid-control')); return }
    }
  }
  input.on('data', data)
  input.on('end', stop)
  input.on('error', stop)
  try { await done }
  finally { input.off('data', data); input.off('end', stop); input.off('error', stop); input.pause() }
}
