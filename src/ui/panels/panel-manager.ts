/** Inline bottom-anchored panel system (spec §4.4): ONE active panel, FIFO
 * queue, guarded execution (a crashing panel closes only itself), focus held
 * for the panel's lifetime and returned to focusHome() — never to null (the
 * pi-tui overlay-restore landmine). Panels own 100% of the keyboard while
 * active (spec D5): the controller's global listener checks `active`. */
import { Container, type Component } from '@earendil-works/pi-tui'

export type PanelForcedReason = 'owner-disposed' | 'aborted'
export interface PanelSpec<T> {
  /** Build the panel; call finish(outcome) exactly once to close it. */
  create(finish: (outcome: T) => void): Component
  /** Outcome/error to settle with when the MANAGER closes the panel (teardown, signal abort). */
  forced(reason: PanelForcedReason): { outcome: T } | { error: unknown }
}
interface Entry<T> {
  spec: PanelSpec<T>
  resolve(v: T): void
  reject(e: unknown): void
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  settled: boolean
}

/** Crash barrier: any throw from the wrapped panel settles its entry and the
 * queue continues (spec §4.4 guarded law). Focus flag forwards so an inner
 * Input still shows its cursor. */
class GuardedPanel implements Component {
  // True for the duration of render() (including a crash's synchronous
  // onCrash callback) — lets settleAndAdvance tell a render-time settle
  // (must defer its removeChild; see there) apart from a handleInput-time
  // settle (must not).
  rendering = false
  constructor(private readonly inner: Component, private readonly onCrash: (error: unknown) => void) {}
  get focused(): boolean { return (this.inner as { focused?: boolean }).focused ?? false }
  set focused(value: boolean) { const i = this.inner as { focused?: boolean }; if ('focused' in i) i.focused = value }
  render(width: number): string[] {
    this.rendering = true
    try {
      const lines = this.inner.render(width)
      this.rendering = false
      return lines
    } catch (error) {
      // rendering stays true through onCrash(): settleAndAdvance (reached
      // synchronously from here) reads it to decide whether this settle is
      // happening mid-render — see settleAndAdvance's comment.
      this.onCrash(error)
      this.rendering = false
      return []
    }
  }
  handleInput(data: string): void {
    try { this.inner.handleInput?.(data) } catch (error) { this.onCrash(error) }
  }
  invalidate(): void {
    try { this.inner.invalidate() } catch { /* surfaces on next render */ }
  }
}

export class PanelManager {
  readonly container = new Container()
  private queue: Entry<never>[] = []
  private current: { entry: Entry<never>; guarded: GuardedPanel } | undefined
  // Tracks the true/false onActiveChange window, independent of how many
  // panels activate back-to-back inside it (FIFO test pins exactly one
  // [true, false] pair spanning both panels — see activateNext/settleAndAdvance).
  private activeWindow = false

  constructor(private readonly host: {
    setFocus(c: Component | null): void
    focusHome(): Component
    requestRender(): void
    onActiveChange?(active: boolean): void
  }) {}

  get active(): Component | undefined { return this.current?.guarded }

  enqueue<T>(spec: PanelSpec<T>, opts?: { signal?: AbortSignal }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry<T> = { spec, resolve, reject, signal: opts?.signal, onAbort: undefined, settled: false }
      if (entry.signal?.aborted) { this.settleForced(entry as Entry<never>, 'aborted'); return }
      if (entry.signal) {
        entry.onAbort = () => this.forceClose(entry as Entry<never>, 'aborted')
        entry.signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry as Entry<never>)
      this.activateNext()
    })
  }

  disposeAll(): void {
    const current = this.current
    this.current = undefined
    const drained = [...(current ? [current.entry] : []), ...this.queue.splice(0)]
    this.container.clear()
    for (const entry of drained) this.settleForced(entry, 'owner-disposed')
    // No focus restore here: teardown callers are unmounting the whole tree.
  }

  private activateNext(): void {
    if (this.current) return
    const entry = this.queue.shift()
    /* v8 ignore next -- defensive: both call sites already guarantee a non-empty queue before calling activateNext (enqueue calls it immediately after queue.push; settleAndAdvance calls it only inside its own `queue.length > 0` check), so shift() always returns a defined entry today. Kept for shift()'s T | undefined typing and as a safety net if a future caller breaks that invariant. */
    if (!entry) return
    const guarded = new GuardedPanel(
      this.buildOrCrash(entry),
      (error) => this.settleAndAdvance(entry, () => { if (!entry.settled) { entry.settled = true; entry.reject(error) } }),
    )
    this.current = { entry, guarded }
    this.container.addChild(guarded)
    this.host.setFocus(guarded)
    if (!this.activeWindow) {
      this.activeWindow = true
      this.host.onActiveChange?.(true)
    }
    this.host.requestRender()
  }

  private buildOrCrash(entry: Entry<never>): Component {
    return entry.spec.create(((outcome: never) => {
      this.settleAndAdvance(entry, () => { if (!entry.settled) { entry.settled = true; entry.resolve(outcome) } })
    }) as never)
  }

  private settleAndAdvance(entry: Entry<never>, settle: () => void): void {
    entry.signal?.removeEventListener('abort', entry.onAbort!)
    settle()
    if (this.current?.entry === entry) {
      const finished = this.current.guarded
      const settledDuringRender = finished.rendering
      this.current = undefined
      if (this.queue.length > 0) {
        if (settledDuringRender) {
          // `finished` is mid-render right now (a crashing panel's render()
          // is what reached this settle). Container.render() iterates
          // `children` with a live array iterator, so a same-tick
          // remove+add here would splice `finished` out from under that
          // iterator's cursor and the newly-added next panel would
          // silently never be visited in THIS render pass. Deferring the
          // removal to a microtask sidesteps that without delaying
          // activation of the next panel, which still mounts synchronously
          // below — but Node drains process.nextTick (what pi-tui's own
          // requestRender schedules a repaint through) BEFORE microtasks,
          // so the repaint already in flight from THIS render pass's own
          // requestRender (below, and the crash path's self-heal) can run
          // before the deferred removeChild does, painting both panels
          // stacked for one frame. Requesting another render after the
          // deferred removal closes that gap.
          queueMicrotask(() => {
            this.container.removeChild(finished)
            this.host.requestRender()
          })
        } else {
          // Not mid-render (e.g. a normal handleInput finish) — no
          // iterator to race, so remove immediately. Deferring here would
          // itself be the bug: pi-tui schedules its repaint via
          // process.nextTick, which runs BEFORE a queued microtask, so a
          // deferred removal would paint both panels stacked for one frame
          // with nothing left to request a follow-up repaint.
          this.container.removeChild(finished)
        }
        this.activateNext()
        return
      }
      this.container.removeChild(finished)
      this.host.setFocus(this.host.focusHome())
      this.activeWindow = false
      this.host.onActiveChange?.(false)
      this.host.requestRender()
    }
  }

  private forceClose(entry: Entry<never>, reason: PanelForcedReason): void {
    /* v8 ignore next -- defensive: forceClose's only caller is the abort listener registered with { once: true } in enqueue; every settle path (settleAndAdvance's first line, settleForced) removes that listener before entry.settled ever flips true, and an AbortSignal only ever fires its listeners once, so this can never observe an already-settled entry today. Kept as a safety net. */
    if (entry.settled) return
    if (this.current?.entry !== entry) {
      const i = this.queue.indexOf(entry)
      /* v8 ignore next -- defensive: reached only when entry is neither settled (guard above) nor current (this branch's condition), so by construction it is still sitting in `queue`; indexOf is always >= 0 here today. Kept as a safety net (splice(-1, 1) would otherwise remove the wrong element). */
      if (i >= 0) this.queue.splice(i, 1)
      this.settleForced(entry, reason)
      return
    }
    this.settleAndAdvance(entry, () => this.settleForced(entry, reason))
  }

  private settleForced(entry: Entry<never>, reason: PanelForcedReason): void {
    /* v8 ignore next -- defensive: all four call sites (enqueue's pre-aborted branch, forceClose's queued- and active-entry branches, disposeAll's drain loop) only ever pass an entry that has not yet settled — an invariant of construction, not something reachable at runtime today. Kept as a safety net. */
    if (entry.settled) return
    entry.settled = true
    entry.signal?.removeEventListener('abort', entry.onAbort!)
    const result = entry.spec.forced(reason)
    if ('outcome' in result) entry.resolve(result.outcome as never)
    else entry.reject(result.error)
  }
}
