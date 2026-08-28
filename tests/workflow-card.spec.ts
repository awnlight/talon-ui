import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { WorkflowCardCell } from '../src/ui/transcript/workflow-card.ts'

const p = createPalette(false)
const colored = createPalette(true)
const card = (palette = p) => new WorkflowCardCell('run-1', 'review-changes', palette)

describe('WorkflowCardCell (spec §3.9)', () => {
  it('opens running, fills with members, and settles in place', () => {
    const cell = card()
    expect(cell.render(72)).toEqual(['◇ workflow · review-changes', '└ 0 members'])
    expect(cell.isSettled()).toBe(false)

    cell.startMember(1, 'review:bugs', 'Review')
    cell.startMember(2, 'verify:a', 'Verify')
    expect(cell.render(72)).toEqual([
      '◇ workflow · review-changes',
      '  ◇ review:bugs · Review',
      '  ◇ verify:a · Verify',
      '└ 2 members',
    ])

    cell.endMember(1, 'completed')
    cell.endMember(2, 'failed')
    cell.settle('error')
    expect(cell.isSettled()).toBe(true)
    expect(cell.render(72)).toEqual([
      '◆ workflow · review-changes',
      '  ◆ review:bugs · Review · completed',
      '  ◆ verify:a · Verify · failed',
      '└ 2 members · error',
    ])
  })

  it('tones the head by state and each member by its own outcome', () => {
    const cell = card(colored)
    expect(cell.render(72)[0]).toBe(colored.warning('◇ workflow · review-changes'))
    cell.startMember(1, 'a', undefined)
    expect(cell.render(72)[1]).toContain(colored.warning('◇ a'))
    cell.endMember(1, 'cancelled')
    expect(cell.render(72)[1]).toContain(colored.error('◆ a'))
    cell.settle('completed')
    expect(cell.render(72)[0]).toBe(colored.success('◆ workflow · review-changes'))
  })

  it('orders members by seq however they arrive, and REPLACES a repeated seq', () => {
    const cell = card()
    cell.startMember(3, 'third', undefined)
    cell.startMember(1, 'first', undefined)
    cell.startMember(1, 'first again', undefined)      // a replay must not double-count
    expect(cell.render(72).slice(1, 3)).toEqual(['  ◇ first again', '  ◇ third'])
    expect(cell.render(72).at(-1)).toBe('└ 2 members')
  })

  it('keeps an end whose start never arrived — the outcome is the fact', () => {
    const cell = card()
    cell.endMember(7, 'failed')
    expect(cell.render(72)[1]).toBe('  ◆ member 7 · failed')
  })

  it('leaves a run whose end never arrived open, because that is what the log says', () => {
    const cell = card()
    cell.startMember(1, 'a', undefined)
    expect(cell.render(72)[0]!.startsWith('◇')).toBe(true)
    expect(cell.render(72).at(-1)).toBe('└ 1 member')
  })

  it('folds a long member list into a count', () => {
    const cell = card()
    for (let seq = 1; seq <= 12; seq++) cell.startMember(seq, `member ${seq}`, undefined)
    const rows = cell.render(72)
    expect(rows).toContain('  … 4 more members …')
    expect(rows.at(-1)).toBe('└ 12 members')
  })

  it('is uncached while running and width-cached once settled, and counts lines width-free', () => {
    const cell = card()
    cell.startMember(1, 'a', undefined)
    expect(cell.render(72)).not.toBe(cell.render(72))
    cell.settle('completed')
    const rows = cell.render(72)
    expect(cell.render(72)).toBe(rows)
    expect(cell.render(60)).not.toBe(rows)
    cell.invalidate()
    expect(cell.render(60)).not.toBe(rows)
    expect(cell.contentLineCount()).toBe(3)
    cell.render(12)
    expect(cell.contentLineCount()).toBe(3)              // wrapping never moves the count
  })

  it('escapes hostile names, labels and phases, and never renders an over-wide row', () => {
    const cell = new WorkflowCardCell('r', 'a\x1b]0;evil\x07', p)
    cell.startMember(1, 'b‮c', 'p\x1bq')
    const rows = cell.render(120)
    expect(rows[0]).toContain('a\\x1b]0;evil\\x07')
    expect(rows[1]).toContain('b\\u202ec')
    expect(rows[1]).toContain('p\\x1bq')
    for (const width of [1, 8, 40]) for (const row of cell.render(width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
  })
})
