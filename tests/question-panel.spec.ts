import { describe, expect, it } from 'vitest'
import { QuestionPanel } from '../src/ui/panels/question-panel.ts'
import { createPalette } from '../src/theme/palette.ts'

export function mountQuestions(questions: unknown[], overrides: Partial<{ maxHeight: number }> = {}) {
  const answers: unknown[] = []
  let cancelled = 0
  const panel = new QuestionPanel(
    { questions: questions as never },
    (a) => answers.push(a),
    () => { cancelled += 1 },
    createPalette(false),
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
  // a no-options question, or a set `detail` — see task-8-report.md).
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
  it('a question with no options shows the select-at-least-one error on submit', () => {
    const { panel, answers } = mountQuestions([q({ options: undefined })])
    panel.handleInput!('\r')
    // Substring, not the full message: at width 52 truncateToWidth ellipsizes
    // it (61 chars) — matches Task 9's own pinned test for the same string.
    expect(panel.render(52).join('\n')).toContain('Select at least one option')
    expect(answers).toEqual([])
  })
  it('renders question detail when present', () => {
    const { panel } = mountQuestions([q({ detail: 'Extra context here.' })])
    expect(panel.render(52).join('\n')).toContain('Extra context here.')
  })
})
