export const REPLY_BUFFER_MS = 600
export const REPLY_FINISH_MS = 900

/** Presentation only. The authoritative message is never changed. */
export class ReplyBuffer {
  private readonly segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  private source = ''
  private ends: number[] = []
  private cursor = 0
  private credit = 0
  private visible = ''
  private readyAt = 0
  private lastFrame = 0
  private finishAt: number | undefined
  private complete = false

  receive(text: string, now: number, complete: boolean) {
    const changed = text !== this.source
    const corrected = changed && !text.startsWith(this.source)
    if (!this.source && text) { this.readyAt = now + REPLY_BUFFER_MS; this.lastFrame = this.readyAt }
    if (!this.canAdvance) this.lastFrame = Math.max(now, this.readyAt)
    this.source = text
    if (changed) {
      // An upstream chunk may end halfway through a surrogate pair.
      const safe = text.replace(/[\uD800-\uDBFF]$/, '')
      this.ends = Array.from(this.segmenter.segment(safe), part => part.index + part.segment.length)
    }
    this.complete = complete
    if (complete) this.finishAt ??= now + REPLY_FINISH_MS
    else this.finishAt = undefined
    if (corrected) this.flush()
  }

  get text() { return this.visible }
  get pending() { return this.visible !== this.source }
  // Keep the last grapheme until its boundary is known, including ZWJ emoji.
  private get available() { return this.complete ? this.ends.length : Math.max(0, this.ends.length - 1) }
  get canAdvance() { return this.cursor < this.available || (this.complete && this.pending) }
  delay(now: number) { return Math.max(0, this.readyAt - now) }

  advance(now: number) {
    if (now < this.readyAt || !this.pending) return this.visible
    if (this.finishAt !== undefined && now >= this.finishAt) return this.flush()
    const remaining = this.available - this.cursor
    const elapsed = Math.min(64, Math.max(0, now - this.lastFrame)) / 1000
    this.lastFrame = now
    // A short backlog reads gently; a burst catches up without a long tail.
    const finishSeconds = this.finishAt === undefined ? Infinity : Math.max(.016, (this.finishAt - now) / 1000)
    const speed = Math.max(32, remaining / .4, remaining / finishSeconds)
    this.credit += speed * elapsed
    const count = Math.min(remaining, Math.floor(this.credit))
    this.credit -= count; this.cursor += count
    this.visible = this.source.slice(0, this.ends[this.cursor - 1] ?? 0)
    return this.visible
  }

  flush() {
    this.cursor = this.ends.length; this.credit = 0
    this.visible = this.source
    return this.visible
  }
}
