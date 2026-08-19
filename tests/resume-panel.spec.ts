// tests/resume-panel.spec.ts
import { describe, expect, it } from 'vitest'
import { ResumePanel } from '../src/ui/panels/resume-panel.ts'
import { createPalette } from '../src/theme/palette.ts'
import type { ResumeCandidate } from '../src/backend/sessions.ts'

const cand = (id: string, over: Partial<ResumeCandidate> = {}): ResumeCandidate => ({
  id, title: `Session ${id}`, lastActivityAt: 1_755_100_000_000, cwd: '/w',
  live: false, persisted: true, currentWorkspace: true, ...over,
})
function mount(candidates?: ResumeCandidate[]) {
  const picks: (ResumeCandidate | undefined)[] = []
  const panel = new ResumePanel((p) => picks.push(p), createPalette(false), (cwd) => cwd ?? 'cwd unset')
  if (candidates) panel.setCandidates(candidates)
  return { panel, picks }
}

describe('ResumePanel', () => {
  it('shows the loading state until candidates arrive', () => {
    const { panel } = mount()
    expect(panel.render(60).join('\n')).toContain('Loading sessions')
    panel.handleInput!('\r')
    expect(panel.render(60).join('\n')).toContain('Sessions are still loading.')
  })
  it('lists current-workspace candidates by default; tab reveals all-workspaces rows', () => {
    const { panel } = mount([cand('a'), cand('b', { currentWorkspace: false, cwd: '/elsewhere', title: 'Foreign' })])
    const text = panel.render(80).join('\n')
    expect(text).toContain('Session a')
    expect(text).not.toContain('Foreign')
    panel.handleInput!('\t')
    const all = panel.render(80).join('\n')
    expect(all).toContain('Foreign')
    expect(all).toContain('/elsewhere')
  })
  it('enter picks the selected enabled candidate', () => {
    const { panel, picks } = mount([cand('a'), cand('b', { title: 'Second' })])
    panel.handleInput!('\x1b[B')
    panel.handleInput!('\r')
    expect(picks).toEqual([expect.objectContaining({ id: 'b' })])
  })
  it('enter on a disabled row surfaces the reason instead of picking', () => {
    const { panel, picks } = mount([cand('a', { disabledReason: 'session is already live in this runtime' })])
    panel.handleInput!('\r')
    expect(picks).toEqual([])
    expect(panel.render(80).join('\n')).toContain('session is already live in this runtime')
  })
  it('typing filters fuzzily; esc clears the query first, then cancels', () => {
    const { panel, picks } = mount([cand('a', { title: 'Fix login' }), cand('b', { title: 'Write docs' })])
    for (const ch of 'docs') panel.handleInput!(ch)
    const text = panel.render(80).join('\n')
    expect(text).toContain('Write docs')
    expect(text).not.toContain('Fix login')
    panel.handleInput!('\x1b')
    expect(panel.render(80).join('\n')).toContain('Fix login')   // query cleared, list restored
    expect(picks).toEqual([])
    panel.handleInput!('\x1b')
    expect(picks).toEqual([undefined])                            // second esc cancels
  })
  it('filter matches the workspace label only in the all scope', () => {
    const { panel } = mount([cand('a'), cand('b', { currentWorkspace: false, cwd: '/elsewhere', title: 'Foreign' })])
    panel.handleInput!('\t')
    for (const ch of 'elsewhere') panel.handleInput!(ch)
    const text = panel.render(80).join('\n')
    expect(text).toContain('Foreign')
    expect(text).not.toContain('Session a')
  })
  it('every row stays within width', () => {
    const { panel } = mount([cand('a', { title: 'x'.repeat(200), disabledReason: 'session has no recorded workspace' })])
    for (const row of panel.render(40)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40)
  })
  it('neutralizes hostile titles (D7.8)', () => {
    const { panel } = mount([cand('a', { title: 'evil\x1b]2;t\x07' })])
    expect(panel.render(80).join('\n')).toContain('evil\\x1b]2;t\\x07')
  })
})

describe('ResumePanel — scope round trip, meta line, empty states', () => {
  it('a second tab returns to the workspace scope', () => {
    const { panel } = mount([cand('a'), cand('b', { currentWorkspace: false, cwd: '/elsewhere', title: 'Foreign' })])
    panel.handleInput!('\t')
    panel.handleInput!('\t')
    expect(panel.render(80).join('\n')).not.toContain('Foreign')
  })
  it('the meta line carries the ISO timestamp and only the flags that are set', () => {
    const { panel } = mount([cand('a', { title: 'Live one', live: true, persisted: false })])
    expect(panel.render(100).join('\n')).toContain('2025-08-13T15:46:40.000Z · live · a')
  })
  it('an unmatched query says so, and enter has nothing to pick', () => {
    const { panel, picks } = mount([cand('a')])
    for (const ch of 'zzz') panel.handleInput!(ch)
    expect(panel.render(60).join('\n')).toContain('No matching sessions.')
    panel.handleInput!('\r')
    expect(picks).toEqual([])
    expect(panel.render(60).join('\n')).toContain('No session matches this search.')
  })
  it('forwards focus to the filter Input, whose caret only rides the query row', () => {
    const { panel } = mount([cand('a')])
    expect(panel.focused).toBe(false)
    panel.handleInput!('a')
    const unfocused = panel.render(60)[2]
    panel.focused = true
    expect(panel.focused).toBe(true)
    expect(panel.render(60)[2]).not.toBe(unfocused)   // the zero-width cursor marker joined the row
  })
  it('truncates every row at a narrow width with colors on (styled rows, ANSI-aware)', () => {
    // Colors enabled: the scope row is two independently-styled segments and
    // the filter row carries the Input's reverse-video caret, so truncation
    // runs over real SGR rather than the plain-ASCII fast path.
    const panel = new ResumePanel(() => {}, createPalette(true), (cwd) => cwd ?? 'cwd unset')
    panel.setCandidates([cand('a', { title: 'A very long session title', disabledReason: 'session has no recorded workspace' })])
    panel.handleInput!('t')    // a query: the filter row renders the Input, not the placeholder
    panel.handleInput!('\r')   // disabled row: paints the error line
    const rows = panel.render(14)
    for (const row of rows) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(14)
    expect(rows.join('\n')).toContain('…')
  })
  it('invalidate is a safe no-op (nothing is cached across renders)', () => {
    const { panel } = mount([cand('a')])
    const before = panel.render(60)
    panel.invalidate()
    expect(panel.render(60)).toEqual(before)
  })
})
