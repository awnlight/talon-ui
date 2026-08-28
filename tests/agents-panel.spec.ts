import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { AgentsPanel, type AgentEntry } from '../src/ui/panels/agents-panel.ts'

const p = createPalette(false)
const child = (over: Partial<Extract<AgentEntry, { kind: 'child' }>> = {}): AgentEntry => ({
  kind: 'child', id: 's-1', depth: 1, activity: 'inactive', mode: 'one-shot', ...over,
})

function panel(entries?: AgentEntry[]) {
  let closed = 0
  const view = new AgentsPanel(() => { closed += 1 }, p)
  if (entries !== undefined) view.setEntries(entries)
  return { view, closed: () => closed, rows: (width = 76) => view.render(width) }
}

describe('AgentsPanel (spec §3.9)', () => {
  it('shows a loading state, then an empty one when the session has no children', () => {
    expect(panel().rows().join('\n')).toContain('Loading agents…')
    expect(panel([]).rows().join('\n')).toContain('No subagents in this session.')
  })

  it('indents by depth, with direct children flush left', () => {
    const rows = panel([
      child({ id: 's-1', depth: 1, mode: 'continuable', label: 'reviewer' }),
      child({ id: 's-2', depth: 2, label: 'grep pass' }),
      child({ id: 's-3', depth: 3 }),
    ]).rows()
    expect(rows[2]).toBe('◆ reviewer · continuable · s-1')
    expect(rows[3]).toBe('  ◆ grep pass · one-shot · s-2')
    expect(rows[4]).toBe('    ◆ s-3 · one-shot · s-3')     // no label: the id names it
  })

  it('marks a running child with the pending glyph and a settled one with the finished glyph', () => {
    const colored = createPalette(true)
    const view = new AgentsPanel(() => {}, colored)
    view.setEntries([child({ activity: 'running', label: 'live one' }), child({ id: 's-2', label: 'done one' })])
    const rows = view.render(76)
    expect(rows[2]).toContain(colored.warning('◇ live one'))
    expect(rows[3]).toContain(colored.success('◆ done one'))
  })

  it('renders a diagnostic DIM — a corrupt child is a fact about the log, not an error', () => {
    const colored = createPalette(true)
    const view = new AgentsPanel(() => {}, colored)
    view.setEntries([{ kind: 'diagnostic', id: 's-9', depth: 1, reason: 'corrupt' }])
    expect(view.render(76)[2]).toBe(colored.dim('◌ s-9 · corrupt'))
  })

  it('summarizes past a glance-sized list', () => {
    const many = Array.from({ length: 20 }, (_, i) => child({ id: `s-${i}` }))
    const rows = panel(many).rows()
    expect(rows.join('\n')).toContain('… 8 more …')
  })

  it('closes on esc or enter, and is inert to invalidate', () => {
    const { view, closed } = panel([child()])
    view.handleInput('x')
    expect(closed()).toBe(0)
    view.handleInput('\x1b')
    view.handleInput('\r')
    expect(closed()).toBe(2)
    expect(() => view.invalidate()).not.toThrow()
  })

  it('escapes hostile labels and ids, and never renders an over-wide row', () => {
    const rows = panel([child({ label: 'a\x1b]0;evil\x07', id: 'b‮c' })]).rows(120)
    expect(rows[2]).toContain('a\\x1b]0;evil\\x07')
    expect(rows[2]).toContain('b\\u202ec')
    for (const width of [1, 10, 40, 120]) for (const row of panel([child()]).rows(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
  })
})
