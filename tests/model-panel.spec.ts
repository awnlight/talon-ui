import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import type { ModelChoice } from '../src/backend/models.ts'
import { ModelPanel, type ModelPick } from '../src/ui/panels/model-panel.ts'

const p = createPalette(false)
const choice = (over: Partial<ModelChoice> = {}): ModelChoice => ({
  provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', name: 'Chat',
  description: undefined, contextWindow: 64_000, efforts: [], defaultEffort: undefined, current: false, ...over,
})
const REASONER = choice({
  model: 'deepseek-reasoner', name: 'Reasoner', current: true, contextWindow: 128_000,
  efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low',
})

/** `'loading'` mounts the panel WITHOUT a catalog — a default parameter cannot
 * express that, since passing `undefined` would just take the default. */
function panel(choices: ModelChoice[] | 'loading' = [choice(), REASONER]) {
  const picks: (ModelPick | undefined)[] = []
  const view = new ModelPanel((picked) => picks.push(picked), p)
  if (choices !== 'loading') view.setChoices(choices)
  return { view, picks, rows: (width = 72) => view.render(width) }
}

describe('ModelPanel (spec §3.7/§4.4)', () => {
  it('shows a loading state before the catalog answers, and refuses Enter until it does', () => {
    const { view, picks, rows } = panel('loading')
    expect(rows().join('\n')).toContain('Loading models…')
    view.handleInput('\r')
    expect(picks).toEqual([])
    expect(rows().join('\n')).toContain('Models are still loading.')
  })

  it('lists every route with its provider and window, marking the current one', () => {
    const text = panel().rows().join('\n')
    expect(text).toContain('Chat')
    expect(text).toContain('● Reasoner')            // the current route wears the mark
    expect(text).toContain('64k ctx')
    expect(text).toContain('effort low')            // the current route shows the effort it is running

    // A route with efforts that is NOT current advertises how many it has.
    expect(panel([choice({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] })]).rows().join('\n')).toContain('2 efforts')
  })

  it('cycles the highlighted route through ITS OWN efforts, wrapping, and leaves others alone', () => {
    const { view, rows } = panel([REASONER, choice()])
    expect(rows().join('\n')).toContain('effort low')  // the current route lands on what it is running
    view.handleInput('\x1b[Z')                          // shift+tab
    expect(rows().join('\n')).toContain('effort high')
    view.handleInput('\x1b[Z')
    expect(rows().join('\n')).toContain('effort low')   // wraps

    view.handleInput('\x1b[B')                          // down: a route with no efforts
    const before = rows().join('\n')
    view.handleInput('\x1b[Z')
    expect(rows().join('\n')).toBe(before)              // nothing to cycle, nothing changes
  })

  it('keeps the highlight on the route whose effort was cycled', () => {
    // The row label carries the effort, so cycling rebuilds the list — and a
    // rebuild that moved the highlight would select a DIFFERENT model on Enter.
    const { view, picks } = panel([choice(), REASONER])
    view.handleInput('\x1b[B')                          // down to the reasoner
    view.handleInput('\x1b[Z')                          // cycle its effort: rebuilds
    view.handleInput('\r')
    expect(picks).toEqual([{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }])
  })

  it('a new filter re-lands on the top row, as a filtered list should', () => {
    const { view, picks } = panel([choice(), REASONER])
    view.handleInput('\x1b[B')                          // highlight the reasoner…
    for (const key of 'chat') view.handleInput(key)     // …then filter it away
    view.handleInput('\r')
    expect(picks).toEqual([{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: undefined }])
  })

  it('answers with the route and the effort chosen for it', () => {
    const { view, picks } = panel([REASONER])
    view.handleInput('\x1b[Z')
    view.handleInput('\r')
    expect(picks).toEqual([{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }])
  })

  it('answers with no effort for a route that has none', () => {
    const { view, picks } = panel([choice()])
    view.handleInput('\r')
    expect(picks).toEqual([{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: undefined }])
  })

  it('filters, says so when nothing matches, and refuses Enter there', () => {
    const { view, picks, rows } = panel()
    for (const key of 'reason') view.handleInput(key)
    expect(rows().join('\n')).toContain('Reasoner')
    expect(rows().join('\n')).not.toContain('● Reasoner\nChat')
    for (const key of 'zzz') view.handleInput(key)
    expect(rows().join('\n')).toContain('No matching models.')
    view.handleInput('\r')
    expect(picks).toEqual([])
    expect(rows().join('\n')).toContain('No model matches this search.')
  })

  it('esc clears the filter first and only then cancels (the resume-selector rule)', () => {
    const { view, picks, rows } = panel()
    view.handleInput('x')
    view.handleInput('\x1b')
    expect(picks).toEqual([])
    expect(rows().join('\n')).toContain('type to filter')
    view.handleInput('\x1b')
    expect(picks).toEqual([undefined])
  })

  it('is focusable through its filter input, and inert to invalidate', () => {
    const { view } = panel()
    view.focused = true
    expect(view.focused).toBe(true)
    expect(() => view.invalidate()).not.toThrow()
  })

  it('escapes hostile catalog text and never renders an over-wide row', () => {
    const { rows } = panel([choice({ name: 'Chat\x1b]0;evil\x07', description: 'x'.repeat(300) })])
    expect(rows(120).join('\n')).toContain('Chat\\x1b]0;evil\\x07')
    for (const width of [1, 8, 40, 120]) for (const row of panel().rows(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
  })
})
