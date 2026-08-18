import { describe, expect, it } from 'vitest'
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { QuestionPanel } from '../src/ui/panels/question-panel.ts'
import { createPalette } from '../src/theme/palette.ts'

export function mountQuestions(questions: unknown[], overrides: Partial<{ maxHeight: number; colors: boolean }> = {}) {
  const answers: unknown[] = []
  let cancelled = 0
  const panel = new QuestionPanel(
    { questions: questions as never },
    (a) => answers.push(a),
    () => { cancelled += 1 },
    createPalette(overrides.colors ?? false),
    () => overrides.maxHeight ?? 18,
  )
  return { panel, answers, cancelled: () => cancelled }
}
const q = (over: Record<string, unknown> = {}) => ({
  id: 'q1', question: 'Which mode should we use?',
  options: [{ label: 'Fast', description: 'builds without checks' }, { label: 'Careful' }], ...over,
})

describe('QuestionPanel core', () => {
  it('renders counter, question, options, descriptions, and hints', () => {
    const { panel } = mountQuestions([q({ header: 'Mode' }), q({ id: 'q2' })])
    const text = panel.render(52).join('\n')
    expect(text).toContain('─ question ')
    expect(text).toContain('Question 1/2 (2 unanswered) · Mode')
    expect(text).toContain('Which mode should we use?')
    expect(text).toContain('› 1. Fast')
    expect(text).toContain('builds without checks')
    expect(text).toContain('  2. Careful')
    expect(text).toContain('Enter submit')
  })
  it('arrow keys wrap; digits jump; enter answers and advances to the next question', () => {
    const { panel, answers } = mountQuestions([q(), q({ id: 'q2', question: 'Second?' })])
    panel.handleInput!('\x1b[B')                    // down → Careful
    panel.handleInput!('\x1b[B')                    // wraps → Fast
    panel.handleInput!('2')                         // digit jump → Careful
    panel.handleInput!('\r')
    expect(answers).toEqual([])                     // not finished yet — question 2 is showing
    expect(panel.render(52).join('\n')).toContain('Question 2/2 (1 unanswered)')
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Careful'] }, { id: 'q2', selected: ['Fast'] }] }])
  })
  it('escape cancels the whole request', () => {
    const { panel, answers, cancelled } = mountQuestions([q()])
    panel.handleInput!('\x1b')
    expect(cancelled()).toBe(1)
    expect(answers).toEqual([])
  })
  it('neutralizes hostile question metadata (D7.8)', () => {
    const { panel } = mountQuestions([q({ question: 'evil\x1b]0;t\x07?', header: 'h\x1bx', options: [{ label: 'ok\x07' }] })])
    const text = panel.render(60).join('\n')
    expect(text).toContain('evil\\x1b]0;t\\x07?')
    expect(text).toContain('h\\x1bx')
    expect(text).toContain('ok\\x07')
  })
  it('every row stays within width', () => {
    const { panel } = mountQuestions([q({ question: 'long '.repeat(40), options: [{ label: 'x'.repeat(120) }] })])
    for (const row of panel.render(30)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(30)
  })
  // Coverage-closing additions beyond the brief's 5 pinned tests above (none
  // of which exercise: invalidate(), the 'up' branch, an out-of-range digit,
  // or a set `detail` — see task-8-report.md).
  it('invalidate is a safe no-op (no cached render state)', () => {
    const { panel } = mountQuestions([q()])
    expect(() => panel.invalidate()).not.toThrow()
  })
  it('up arrow wraps the cursor backward independently of down', () => {
    const { panel, answers } = mountQuestions([q()])
    panel.handleInput!('\x1b[A')                    // up from cursor 0 → wraps to the last option
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Careful'] }] }])
  })
  it('a digit greater than the option count is ignored', () => {
    const { panel, answers } = mountQuestions([q()])
    panel.handleInput!('\x1b[B')                    // cursor → Careful (index 1)
    panel.handleInput!('9')                         // out of range for 2 options → ignored
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Careful'] }] }])
  })
  it('renders question detail when present', () => {
    const { panel } = mountQuestions([q({ detail: 'Extra context here.' })])
    expect(panel.render(52).join('\n')).toContain('Extra context here.')
  })
})

const mq = (over: Record<string, unknown> = {}) => q({ multiSelect: true, ...over })

describe('QuestionPanel multiSelect + custom', () => {
  it('space toggles marks; enter submits checked labels in option order', () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!('\x1b[B')      // cursor → Careful
    panel.handleInput!(' ')           // check Careful
    panel.handleInput!('\x1b[A')      // cursor → Fast
    panel.handleInput!(' ')           // check Fast
    expect(panel.render(52).join('\n')).toContain('[x] Fast')
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Fast', 'Careful'] }] }])  // option order, not click order
  })
  it('empty submit shows the validation error and stays open', () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!('\r')
    expect(panel.render(52).join('\n')).toContain('Select at least one option')
    expect(answers).toEqual([])
  })
  it('tab enters custom mode; typed text submits as custom', () => {
    const { panel, answers } = mountQuestions([q()])
    panel.handleInput!('\t')
    for (const ch of 'my own way') panel.handleInput!(ch)
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: [], custom: 'my own way' }] }])
  })
  it("bare 'c' also enters custom mode; esc returns to options and keeps the draft", () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!('c')
    for (const ch of 'keep this') panel.handleInput!(ch)
    panel.handleInput!('\x1b')                    // back to options, draft retained
    panel.handleInput!(' ')                       // check Fast
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Fast'], custom: 'keep this' }] }])  // old-TUI merge law
  })
  it('custom-mode empty submit errors', () => {
    const { panel } = mountQuestions([q()])
    panel.handleInput!('\t')
    panel.handleInput!('\r')
    expect(panel.render(52).join('\n')).toContain('Enter an answer before submitting.')
  })
  it('a question with no options starts in custom mode and esc cancels the request', () => {
    const { panel, cancelled } = mountQuestions([q({ options: undefined })])
    expect(panel.render(52).join('\n')).toContain('Esc cancel')
    panel.handleInput!('\x1b')
    expect(cancelled()).toBe(1)
  })
  it('single-select ignores space', () => {
    const { panel } = mountQuestions([q()])
    panel.handleInput!(' ')
    expect(panel.render(52).join('\n')).not.toContain('[x]')
  })
  // Coverage-closing additions beyond the 7 pinned tests above (none of which
  // exercise: submitCustom's multiSelect merge, the custom hint's counter,
  // un-checking a mark, the per-question reset, or Focusable forwarding).
  it('custom-mode submit merges the checked labels; the hint counts them', () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!(' ')                       // check Fast
    panel.handleInput!('\x1b[B')                  // cursor → Careful
    panel.handleInput!(' ')                       // check Careful
    panel.handleInput!('\t')
    expect(panel.render(52).join('\n')).toContain('2 selected • Enter submit • Esc options')
    for (const ch of 'plus a note') panel.handleInput!(ch)
    // The Input row pads itself to the full width — pin the no-crash invariant.
    for (const row of panel.render(30)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(30)
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Fast', 'Careful'], custom: 'plus a note' }] }])
  })
  it('space on an already-checked option clears the mark', () => {
    const { panel } = mountQuestions([mq()])
    panel.handleInput!(' ')
    expect(panel.render(52).join('\n')).toContain('[x] Fast')
    panel.handleInput!(' ')
    expect(panel.render(52).join('\n')).toContain('[ ] Fast')
  })
  it('advancing resets per-question state: marks, draft, and mode', () => {
    const { panel, answers } = mountQuestions([mq(), mq({ id: 'q2', question: 'Anything else?' }), q({ id: 'q3', question: 'Last word?', options: undefined })])
    panel.handleInput!(' ')                       // check Fast
    panel.handleInput!('\t')
    for (const ch of 'first') panel.handleInput!(ch)
    panel.handleInput!('\r')                      // answers q1, advances to q2
    const second = panel.render(52).join('\n')
    expect(second).toContain('Question 2/3 (2 unanswered)')
    expect(second).toContain('[ ] Fast')          // marks cleared, back in options mode
    expect(second).not.toContain('[x]')
    panel.handleInput!('\x1b[B')                  // cursor → Careful
    panel.handleInput!(' ')
    panel.handleInput!('\r')                      // answers q2, advances to q3 (no options → custom)
    const third = panel.render(52).join('\n')
    expect(third).toContain('Esc cancel')
    expect(third).not.toContain('first')          // the draft was cleared too
    for (const ch of 'last') panel.handleInput!(ch)
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [
      { id: 'q1', selected: ['Fast'], custom: 'first' },
      { id: 'q2', selected: ['Careful'] },
      { id: 'q3', selected: [], custom: 'last' },
    ] }])
  })
  it('forwards focus to the custom Input so its caret marker renders', () => {
    const { panel } = mountQuestions([q()])
    panel.focused = true
    expect(panel.focused).toBe(true)
    expect(panel.render(52).join('\n')).not.toContain(CURSOR_MARKER)   // options mode renders no Input
    panel.handleInput!('\t')
    expect(panel.render(52).join('\n')).toContain(CURSOR_MARKER)
  })
})

describe('QuestionPanel pagination (two-level rule, spec §4.4)', () => {
  const tall = () => mountQuestions([q({ detail: Array.from({ length: 40 }, (_, i) => `detail line ${i}`).join('\n') })], { maxHeight: 14 })
  it('PgDn pages the header first', () => {
    const { panel } = tall()
    const before = panel.render(60).join('\n')
    expect(before).toContain('detail line 0')
    panel.handleInput!('\x1b[6~')                    // PgDn
    const after = panel.render(60).join('\n')
    expect(after).not.toContain('detail line 0')
    expect(after).toMatch(/lines \d+-\d+\/\d+/)
  })
  it('PgUp rewinds the header after PgDn', () => {
    const { panel } = tall()
    panel.handleInput!('\x1b[6~')
    panel.handleInput!('\x1b[5~')                    // PgUp
    expect(panel.render(60).join('\n')).toContain('detail line 0')
  })
  it('renders hidden-block markers and the position line for many options', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i}` }))
    const { panel } = mountQuestions([q({ options })], { maxHeight: 12 })
    const text = panel.render(60).join('\n')
    expect(text).toMatch(/↓ \d+ more/)
    expect(text).toContain('1/12')
  })
  it('arrow movement resets selected-block paging', () => {
    const options = [{ label: 'x'.repeat(400) }, { label: 'small' }]
    const { panel } = mountQuestions([q({ options })], { maxHeight: 10 })
    panel.handleInput!('\x1b[6~')                    // page into the oversized selected block (header is short → falls through)
    panel.handleInput!('\x1b[B')                     // move → reset
    const text = panel.render(40).join('\n')
    expect(text).toContain('small')
  })
  // Coverage-closing addition beyond the brief's 4 pinned tests above: none of
  // them press PgUp while paged INTO an oversized block — the block-first half
  // of the spec's two-level rule (and the only uncovered branch left).
  it('PgUp rewinds the oversized selected block before the header', () => {
    const { panel } = mountQuestions([q({ options: [{ label: 'x'.repeat(400) }, { label: 'small' }] })], { maxHeight: 10 })
    expect(panel.render(40).join('\n')).toContain('› 1. x')
    panel.handleInput!('\x1b[6~')                    // PgDn → into the block (the header fits, so it falls through)
    expect(panel.render(40).join('\n')).toContain('… ↑ 2 lines hidden')
    panel.handleInput!('\x1b[5~')                    // PgUp → rewinds the block, not the header
    expect(panel.render(40).join('\n')).toContain('› 1. x')
  })
  // Regression (review round 1): the status row used to be identified by an
  // out-of-range `header[end]` lookup, which only reads `undefined` on the LAST
  // page — so on every earlier page (the FIRST render included) the row came out
  // raw: undimmed, and untruncated, which TuiMainScreen turns into a crash.
  it('dims the pager status row on the first page, not only the last (review round 1)', () => {
    const { panel } = mountQuestions([q({ detail: Array.from({ length: 40 }, (_, i) => `detail line ${i}`).join('\n') })], { maxHeight: 14, colors: true })
    const status = panel.render(60).find((row) => row.includes('PgUp/PgDn'))!
    expect(status).toMatch(/^\x1b\[2;39m… lines 1-\d+\/\d+ • PgUp\/PgDn\x1b\[22;39m$/)
  })
  it('keeps every row inside the width with the header compacted, first page and paged forward (review round 1)', () => {
    const { panel } = mountQuestions([q({ detail: Array.from({ length: 40 }, (_, i) => `detail line ${i}`).join('\n') })], { maxHeight: 14, colors: true })
    for (const row of panel.render(20)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(20)
    panel.handleInput!('\x1b[6~')                    // PgDn → a mid-header page, where the status row is widest
    for (const row of panel.render(20)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(20)
  })
})
