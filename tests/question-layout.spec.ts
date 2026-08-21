// tests/question-layout.spec.ts
import { describe, expect, it } from 'vitest'
import { IDLE_PAGE, compactHeader, windowBlocks } from '../src/ui/panels/question-layout.ts'

const block = (label: string, lines: number) => Array.from({ length: lines }, (_, i) => `${label}${i}`)

describe('windowBlocks', () => {
  it('shows everything when it fits', () => {
    const r = windowBlocks([block('a', 2), block('b', 2)], 0, 10, 8, IDLE_PAGE)
    expect(r.visible.length).toBe(2)
    expect(r.hiddenBefore).toBe(0)
    expect(r.hiddenAfter).toBe(0)
  })
  it('grows forward from the selection first, then backward, reserving marker rows', () => {
    const blocks = [block('a', 3), block('b', 3), block('c', 3), block('d', 3)]
    const r = windowBlocks(blocks, 1, 8, 8, IDLE_PAGE)
    expect(r.visible).toContainEqual(block('b', 3))
    expect(r.visible).toContainEqual(block('c', 3))          // forward-first
    expect(r.hiddenBefore + r.hiddenAfter).toBeGreaterThan(0)
  })
  it('caps the window at maxVisible blocks', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`x${i}-`, 1))
    const r = windowBlocks(blocks, 6, 100, 8, IDLE_PAGE)
    expect(r.visible.length).toBe(8)
  })
  it('pages within an individually oversized selected block', () => {
    const r1 = windowBlocks([block('big', 30)], 0, 10, 8, IDLE_PAGE)
    expect(r1.visible[0]!.length).toBeLessThanOrEqual(10)
    expect(r1.page.maxOffset).toBeGreaterThan(0)
    const r2 = windowBlocks([block('big', 30)], 0, 10, 8, { ...r1.page, offset: r1.page.size })
    expect(r2.visible[0]![0]).not.toBe(r1.visible[0]![0])    // advanced into the block
  })
})

describe('compactHeader', () => {
  it('passes short headers through untouched with an idle page', () => {
    const r = compactHeader(block('h', 3), 10, IDLE_PAGE)
    expect(r.rows).toEqual(block('h', 3))
    expect(r.page).toEqual(IDLE_PAGE)
  })
  it('windows tall headers and appends the pager status row', () => {
    const r = compactHeader(block('h', 40), 6, IDLE_PAGE)
    expect(r.rows.length).toBeLessThanOrEqual(6)
    expect(r.rows.at(-1)).toMatch(/lines 1-\d+\/40 • PgUp\/PgDn/)
    expect(r.page.maxOffset).toBeGreaterThan(0)
  })
  it('honors a forwarded offset', () => {
    const first = compactHeader(block('h', 40), 6, IDLE_PAGE)
    const second = compactHeader(block('h', 40), 6, { ...first.page, offset: first.page.size })
    expect(second.rows[0]).not.toBe(first.rows[0])
  })
})
