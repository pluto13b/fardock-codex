/** Sequential refresh with bounded error backoff; hidden pages issue no reads. */
export function createTaskRefresh(input: {
  isVisible: () => boolean
  read: () => Promise<void>
  intervalMs: () => number
  onError: (failureCount: number) => void
}) {
  let stopped = false
  let busy = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    if (stopped || busy || !input.isVisible()) return
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    busy = true
    const startedAt = Date.now()
    try { await input.read(); failures = 0 }
    catch { input.onError(++failures) }
    finally {
      busy = false
      if (!stopped && input.isVisible()) {
        const delay = failures
          ? Math.min(5_000, 500 * 2 ** Math.min(failures, 4))
          : Math.max(100, input.intervalMs() - Math.max(0, Date.now() - startedAt))
        timer = setTimeout(() => { void refresh() }, delay)
      }
    }
  }
  return {
    refresh: () => { void refresh() },
    stop() { stopped = true; if (timer !== undefined) clearTimeout(timer) },
  }
}
