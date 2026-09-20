import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ReplyBuffer } from './reply-buffer.ts'

export const MOBILE_FRAME_MS = 1000 / 60
const ease = 'cubic-bezier(.2,.75,.2,1)'

export function useReducedMotion(enabled: boolean) {
  const [reduced, setReduced] = useState(() => enabled && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (!enabled) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update(); query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [enabled])
  return reduced
}

/** A panel stays mounted for its exit, but stops taking input immediately. */
export function usePanelMotion<T extends HTMLElement = HTMLDivElement>(open: boolean, enabled: boolean, kind: 'sheet' | 'dialog' = 'sheet') {
  const [mounted, setMounted] = useState(open)
  const panel = useRef<T>(null)
  const scrim = useRef<HTMLButtonElement>(null)
  const initialized = useRef(false)
  const reduced = useReducedMotion(enabled)
  useLayoutEffect(() => { if (open) setMounted(true); else if (!enabled) setMounted(false) }, [open, enabled])
  useLayoutEffect(() => {
    if (!enabled || !mounted || !panel.current) return
    const node = panel.current, background = scrim.current
    const resting = kind === 'dialog' ? 'translateY(14px) scale(.965)' : 'translateY(22px) scale(.982)'
    const target = { opacity: open ? '1' : '0', transform: open ? 'translateY(0px) scale(1)' : resting }
    if (reduced || !node.animate) {
      Object.assign(node.style, target)
      if (background) background.style.opacity = open ? '1' : '0'
      if (!open) { initialized.current = false; setMounted(false) }
      return
    }
    const current = getComputedStyle(node)
    const fresh = !initialized.current
    const from = !fresh
      ? { opacity: current.opacity, transform: current.transform }
      : { opacity: '0', transform: resting }
    initialized.current = true
    const keyframes = fresh && open
      ? [from, { opacity: '1', transform: 'translateY(-1px) scale(1.003)', offset: .8 }, target]
      : [from, target]
    const animation = node.animate(keyframes, { duration: open ? 320 : 190, easing: ease, fill: 'both' })
    const fade = background?.animate([{ opacity: getComputedStyle(background).opacity }, { opacity: open ? 1 : 0 }], { duration: open ? 240 : 180, easing: ease, fill: 'both' })
    const children = fresh && open ? [...node.children].slice(0, 10).map((child, index) => child.animate(
      [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 200, delay: 35 + Math.min(index, 5) * 14, easing: ease, fill: 'backwards' },
    )) : []
    let cancelled = false
    void animation.finished.then(() => {
      if (cancelled) return
      Object.assign(node.style, target); animation.cancel()
      if (background) background.style.opacity = open ? '1' : '0'
      fade?.cancel()
      if (!open) { initialized.current = false; setMounted(false) }
    }).catch(() => {})
    return () => {
      cancelled = true
      const shown = getComputedStyle(node)
      node.style.opacity = shown.opacity; node.style.transform = shown.transform
      if (background) background.style.opacity = getComputedStyle(background).opacity
      animation.cancel(); fade?.cancel(); children.forEach(child => child.cancel())
    }
  }, [open, mounted, enabled, reduced, kind])
  return { mounted: enabled ? mounted : open, panel, scrim }
}

/** Local text playback: one scheduled frame, no timer per character. */
export function useBufferedReply(source: string, enabled: boolean, mode: 'streaming' | 'complete' | 'immediate') {
  const reduced = useReducedMotion(enabled)
  const model = useRef<ReplyBuffer | null>(null)
  const schedule = useRef<(() => void) | null>(null)
  const stop = useRef<(() => void) | null>(null)
  const [shown, setShown] = useState(enabled && !reduced ? '' : source)
  useLayoutEffect(() => {
    if (!enabled) return
    const buffer = model.current ??= new ReplyBuffer()
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => { clearTimeout(timer); timer = undefined; frame.cancel() }
    const request = () => {
      if (document.visibilityState === 'hidden') { cancel(); setShown(buffer.flush()); return }
      if (!buffer.canAdvance) return
      const delay = buffer.delay(performance.now())
      if (delay > 0) {
        timer ??= setTimeout(() => { timer = undefined; frame.request() }, delay)
      } else frame.request()
    }
    const frame = createFrameBatch(() => {
      setShown(buffer.advance(performance.now()))
      request()
    })
    const visibility = () => { cancel(); setShown(buffer.flush()) }
    schedule.current = request
    stop.current = cancel
    document.addEventListener('visibilitychange', visibility)
    return () => { cancel(); frame.dispose(); schedule.current = null; stop.current = null; document.removeEventListener('visibilitychange', visibility) }
  }, [enabled])
  useLayoutEffect(() => {
    const buffer = model.current
    if (!enabled || !buffer) return
    buffer.receive(source, performance.now(), mode !== 'streaming')
    if (reduced || mode === 'immediate' || document.visibilityState === 'hidden') { stop.current?.(); setShown(buffer.flush()) }
    else { setShown(buffer.text); schedule.current?.() }
  }, [source, enabled, reduced, mode])
  return { text: enabled && !reduced ? shown : source, pending: enabled && !reduced && shown !== source }
}

/** Coalesce layout/scroll writes to one browser frame. No idle animation loop. */
export function createFrameBatch(run: () => void) {
  let frame = 0, next = 0, disposed = false
  const flush = (now: number) => {
    if (disposed) return
    if (now + 1 < next) { frame = requestAnimationFrame(flush); return }
    next += Math.max(1, Math.floor((now + 1 - next) / MOBILE_FRAME_MS) + 1) * MOBILE_FRAME_MS
    frame = 0; run()
  }
  return {
    request() { if (!disposed && !frame && document.visibilityState !== 'hidden') frame = requestAnimationFrame(flush) },
    cancel() { cancelAnimationFrame(frame); frame = 0 },
    dispose() { disposed = true; cancelAnimationFrame(frame); frame = 0 },
  }
}

export function useConversationMotion(enabled: boolean, taskId: string, lastMessageId: string | undefined, lastIsUser: boolean) {
  const viewport = useRef<HTMLElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const saved = useRef(new Map<string, { top: number; follow: boolean }>())
  const follow = useRef(true)
  const currentTask = useRef(taskId)
  const batch = useRef<ReturnType<typeof createFrameBatch> | null>(null)
  const seen = useRef(new Map<string, Set<string>>())
  const activeAnimations = useRef(new Set<Animation>())
  const [away, setAway] = useState(false)
  const reduced = useReducedMotion(enabled)

  useLayoutEffect(() => {
    if (!enabled || !viewport.current || !content.current) return
    const box = viewport.current, body = content.current
    currentTask.current = taskId
    const position = saved.current.get(taskId)
    follow.current = position?.follow ?? true
    box.scrollTop = position?.top ?? box.scrollHeight
    saved.current.set(taskId, { top: box.scrollTop, follow: follow.current })
    setAway(!follow.current)
    const queue = createFrameBatch(() => {
      if (follow.current) box.scrollTop = box.scrollHeight
      saved.current.set(taskId, { top: box.scrollTop, follow: follow.current })
    })
    batch.current = queue
    const observer = new ResizeObserver(() => queue.request())
    observer.observe(body); observer.observe(box)
    const visible = () => { if (document.visibilityState === 'hidden') queue.cancel(); else queue.request() }
    document.addEventListener('visibilitychange', visible)
    const transition = reduced ? undefined : body.animate([{ opacity: .55, transform: 'translateY(7px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: ease })
    return () => {
      observer.disconnect(); queue.dispose(); transition?.cancel()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [enabled, taskId, reduced])

  useLayoutEffect(() => {
    if (!enabled || !content.current) return
    const previous = seen.current.get(taskId)
    const nodes = [...content.current.querySelectorAll<HTMLElement>('[data-message-id]')]
    seen.current.set(taskId, new Set(nodes.map(node => node.dataset.messageId!)))
    if (previous && !reduced) for (const node of nodes) {
      if (previous.has(node.dataset.messageId!)) continue
      const animation = node.animate([{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: ease })
      activeAnimations.current.add(animation)
      void animation.finished.then(() => activeAnimations.current.delete(animation)).catch(() => {})
    }
    if (previous && lastMessageId && !previous.has(lastMessageId) && lastIsUser) { follow.current = true; setAway(false) }
    batch.current?.request()
  }, [enabled, taskId, lastMessageId, lastIsUser, reduced])

  useEffect(() => {
    if (reduced) { for (const animation of activeAnimations.current) animation.cancel(); activeAnimations.current.clear() }
    return () => { for (const animation of activeAnimations.current) animation.cancel(); activeAnimations.current.clear() }
  }, [reduced])
  return {
    viewport, content, away: enabled && away,
    onScroll: enabled ? () => {
      const box = viewport.current
      if (!box) return
      follow.current = box.scrollHeight - box.clientHeight - box.scrollTop < 72
      saved.current.set(currentTask.current, { top: box.scrollTop, follow: follow.current })
      setAway(!follow.current)
    } : undefined,
    latest: () => { follow.current = true; setAway(false); batch.current?.request() },
  }
}

export function useComposerSizing(enabled: boolean, value: string) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const pending = useRef<ReturnType<typeof createFrameBatch> | null>(null)
  useLayoutEffect(() => {
    if (!enabled || !ref.current) return
    const input = ref.current
    const frame = createFrameBatch(() => {
      input.style.height = '0px'
      input.style.height = `${Math.max(48, Math.min(input.scrollHeight, Math.min(180, window.innerHeight * .25)))}px`
    })
    pending.current = frame
    frame.request()
    window.addEventListener('resize', frame.request)
    return () => { pending.current = null; frame.dispose(); window.removeEventListener('resize', frame.request) }
  }, [enabled])
  useLayoutEffect(() => { pending.current?.request() }, [value])
  return ref
}
