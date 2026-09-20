/** Operational deadlines stop while browser JS is frozen; wire expiry never does. */
export class VisibleDeadlines {
  private active = true
  private readonly entries = new Set<{ ms: number; fire: () => void; timer?: ReturnType<typeof setTimeout> }>()

  after(ms: number, callback: () => void): { cancel(): void } {
    const entry = { ms, fire: () => { cancel(); callback() }, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    const cancel = () => { if (entry.timer !== undefined) clearTimeout(entry.timer); this.entries.delete(entry) }
    this.entries.add(entry)
    if (this.active) entry.timer = setTimeout(entry.fire, ms)
    return { cancel }
  }

  setActive(active: boolean) {
    if (this.active === active) return
    this.active = active
    for (const entry of this.entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      entry.timer = active ? setTimeout(entry.fire, entry.ms) : undefined
    }
  }
}
