import { describe, expect, it } from 'vitest'
import { Text, type Component } from '@earendil-works/pi-tui'
import { PanelManager } from '../src/ui/panels/panel-manager.ts'
import { panelRule } from '../src/ui/panels/panel-rule.ts'
import { createPalette } from '../src/theme/palette.ts'

function host() {
  const home = new Text('', 0, 0)
  const focus: (Component | null)[] = []
  const activeChanges: boolean[] = []
  return {
    home, focus, activeChanges,
    api: {
      setFocus: (c: Component | null) => focus.push(c),
      focusHome: () => home,
      requestRender: () => {},
      onActiveChange: (a: boolean) => activeChanges.push(a),
    },
  }
}
const textPanel = (label: string) => (finish: (o: string) => void): Component =>
  new (class extends Text { handleInput(data: string): void { finish(`${label}:${data}`) } })(label, 0, 0)

describe('PanelManager', () => {
  it('FIFO: second panel activates only after the first finishes; focus returns home at the end', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const first = pm.enqueue({ create: textPanel('a'), forced: () => ({ outcome: 'forced-a' }) })
    const second = pm.enqueue({ create: textPanel('b'), forced: () => ({ outcome: 'forced-b' }) })
    expect(pm.container.render(20).join('\n')).toContain('a')
    expect(pm.container.render(20).join('\n')).not.toContain('b')
    pm.active!.handleInput!('x')
    expect(await first).toBe('a:x')
    expect(pm.container.render(20).join('\n')).toContain('b')
    pm.active!.handleInput!('y')
    expect(await second).toBe('b:y')
    expect(pm.active).toBeUndefined()
    expect(h.focus.at(-1)).toBe(h.home)                       // never null
    expect(h.focus).not.toContain(null)
    expect(h.activeChanges).toEqual([true, false])            // one active window spanning both panels
  })
  it('a crashing panel settles as rejected and the queue continues (guarded law)', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const bad = pm.enqueue<string>({
      create: () => new (class extends Text { render(): string[] { throw new Error('panel boom') } })('x', 0, 0),
      forced: () => ({ outcome: 'never' }),
    })
    const good = pm.enqueue({ create: textPanel('ok'), forced: () => ({ outcome: 'forced' }) })
    expect(pm.container.render(20).join('\n')).toContain('ok') // crash happened during this render; queue advanced
    await expect(bad).rejects.toThrow('panel boom')
    pm.active!.handleInput!('z')
    expect(await good).toBe('ok:z')
  })
  it('signal abort settles active and queued panels with forced("aborted")', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const ctl = new AbortController()
    const active = pm.enqueue({ create: textPanel('a'), forced: (r) => ({ outcome: `a-${r}` }) }, { signal: ctl.signal })
    const queued = pm.enqueue({ create: textPanel('b'), forced: (r) => ({ outcome: `b-${r}` }) }, { signal: ctl.signal })
    ctl.abort()
    expect(await active).toBe('a-aborted')
    expect(await queued).toBe('b-aborted')
    expect(pm.active).toBeUndefined()
  })
  it('pre-aborted signal settles immediately without mounting', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const ctl = new AbortController(); ctl.abort()
    expect(await pm.enqueue({ create: textPanel('a'), forced: (r) => ({ outcome: r }) }, { signal: ctl.signal })).toBe('aborted')
    expect(pm.active).toBeUndefined()
  })
  it('disposeAll settles with owner-disposed, supporting error results', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const p = pm.enqueue<string>({ create: textPanel('a'), forced: () => ({ error: new Error('torn down') }) })
    pm.disposeAll()
    await expect(p).rejects.toThrow('torn down')
  })
  it('finish is idempotent — a second call is ignored', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    let close!: (o: string) => void
    const p = pm.enqueue<string>({ create: (finish) => { close = finish; return new Text('a', 0, 0) }, forced: () => ({ outcome: 'f' }) })
    close('one'); close('two')
    expect(await p).toBe('one')
    expect(pm.active).toBeUndefined()
  })
  it('panelRule renders a width-exact dim rule with the title', () => {
    const line = panelRule('approval', 30, createPalette(false))
    expect(line).toBe('─ approval ' + '─'.repeat(19))
  })

  // Review round 1 regression pin: the FIFO test above only ever checks
  // `pm.container.render(...)` after an `await` (which flushes microtasks),
  // so it could not see this. A normal (non-crash) handleInput finish must
  // remove the old panel SYNCHRONOUSLY — deferring it (as an earlier
  // version of settleAndAdvance did, unconditionally, for any advance to a
  // next panel) leaves a stale duplicate frame in production: pi-tui
  // repaints after keyboard input via process.nextTick, which Node drains
  // BEFORE microtasks, so a real terminal would paint BOTH panels stacked
  // for one frame with nothing left to schedule a follow-up repaint (the
  // crash path self-heals only because its own requestRender fires
  // mid-render, queuing a follow-up; a handleInput-time finish has no such
  // in-flight render to piggyback on).
  it('finishing via handleInput with a queued panel removes the old one synchronously (no stale duplicate frame)', () => {
    const h = host()
    const pm = new PanelManager(h.api)
    pm.enqueue({ create: textPanel('a'), forced: () => ({ outcome: 'forced-a' }) })
    pm.enqueue({ create: textPanel('b'), forced: () => ({ outcome: 'forced-b' }) })
    pm.active!.handleInput!('x') // finishes 'a'; no await anywhere in this test
    const rendered = pm.container.render(20)

    const reference = host()
    const pmB = new PanelManager(reference.api)
    pmB.enqueue({ create: textPanel('b'), forced: () => ({ outcome: 'forced-b' }) })
    expect(rendered).toEqual(pmB.container.render(20)) // exactly the single next panel, nothing stacked on top
  })

  // The tests below go beyond the brief's pinned Step-1 list to close out
  // per-file 100% coverage (vitest.config.ts): GuardedPanel's focused
  // forwarding, handleInput's missing-method and crash paths, invalidate's
  // forward/swallow paths, disposeAll's idle-manager path, forceClose's
  // still-queued-entry path (the pinned abort test only ever aborts entries
  // that have already become `current` by the time their own listener
  // fires, in registration order), and a same-tick double-render of an
  // already-crashed panel (exercises the "already settled" branch of the
  // render-crash callback).

  it('focused forwards get/set to a Focusable inner component, and is a harmless read/no-op otherwise', () => {
    const h = host()
    const pm = new PanelManager(h.api)
    class FocusableText extends Text { focused = false }
    let inner!: FocusableText
    pm.enqueue({
      create: () => { inner = new FocusableText('f', 0, 0); return inner },
      forced: () => ({ outcome: 'x' }),
    })
    const guardedFocusable = pm.active as unknown as { focused: boolean }
    expect(guardedFocusable.focused).toBe(false)
    guardedFocusable.focused = true
    expect(inner.focused).toBe(true)
    expect(guardedFocusable.focused).toBe(true)

    const h2 = host()
    const pm2 = new PanelManager(h2.api)
    pm2.enqueue({ create: textPanel('p'), forced: () => ({ outcome: 'x' }) })
    const guardedPlain = pm2.active as unknown as { focused: boolean }
    expect(guardedPlain.focused).toBe(false) // inner has no `focused` -> falls back
    guardedPlain.focused = true               // inner has no `focused` -> silently ignored
    expect(guardedPlain.focused).toBe(false)  // still false; nothing to forward to
  })

  it('handleInput is a safe no-op when the inner panel has none, and settles as rejected when it throws', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    pm.enqueue({ create: () => new Text('no-input', 0, 0), forced: () => ({ outcome: 'x' }) })
    expect(() => pm.active!.handleInput!('a')).not.toThrow() // Text has no handleInput; optional chaining no-ops

    const h2 = host()
    const pm2 = new PanelManager(h2.api)
    const bad = pm2.enqueue<string>({
      create: () => new (class extends Text { handleInput(): void { throw new Error('input boom') } })('x', 0, 0),
      forced: () => ({ outcome: 'never' }),
    })
    pm2.active!.handleInput!('a')
    await expect(bad).rejects.toThrow('input boom')
  })

  it('invalidate forwards to the inner panel and swallows a crash (surfaces on next render)', () => {
    const h = host()
    const pm = new PanelManager(h.api)
    let calls = 0
    pm.enqueue({
      create: () => new (class extends Text { invalidate(): void { calls++ } })('a', 0, 0),
      forced: () => ({ outcome: 'x' }),
    })
    pm.container.invalidate()
    expect(calls).toBe(1)

    const h2 = host()
    const pm2 = new PanelManager(h2.api)
    pm2.enqueue({
      create: () => new (class extends Text { invalidate(): void { throw new Error('invalidate boom') } })('a', 0, 0),
      forced: () => ({ outcome: 'x' }),
    })
    expect(() => pm2.container.invalidate()).not.toThrow()
  })

  it('disposeAll on an idle manager (nothing active or queued) is a no-op', () => {
    const h = host()
    const pm = new PanelManager(h.api)
    expect(() => pm.disposeAll()).not.toThrow()
    expect(pm.active).toBeUndefined()
  })

  it('aborting a still-queued entry removes it without disturbing the active panel', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const ctl = new AbortController()
    const activeP = pm.enqueue({ create: textPanel('a'), forced: () => ({ outcome: 'never' }) })
    const queuedP = pm.enqueue({ create: textPanel('b'), forced: (r) => ({ outcome: `b-${r}` }) }, { signal: ctl.signal })
    ctl.abort()
    expect(await queuedP).toBe('b-aborted')
    expect(pm.container.render(20).join('\n')).toContain('a') // active panel undisturbed
    pm.active!.handleInput!('z')
    expect(await activeP).toBe('a:z')
  })

  it('a second render before cleanup does not double-settle an already-crashed panel', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const bad = pm.enqueue<string>({
      create: () => new (class extends Text { render(): string[] { throw new Error('boom') } })('x', 0, 0),
      forced: () => ({ outcome: 'never' }),
    })
    pm.enqueue({ create: textPanel('ok'), forced: () => ({ outcome: 'forced' }) })
    pm.container.render(20)
    expect(() => pm.container.render(20)).not.toThrow()
    await expect(bad).rejects.toThrow('boom')
  })
})
