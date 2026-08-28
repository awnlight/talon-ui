/** The left gutter and the rule about what breaks out of it (see gutter.ts). */
import { describe, expect, it, vi } from 'vitest'
import { visibleWidth, type Component } from '@earendil-works/pi-tui'
import { GUTTER, Gutter } from '../src/ui/gutter.ts'

const stub = (rows: string[], invalidate?: () => void): Component => ({
  render: () => rows,
  ...(invalidate === undefined ? {} : { invalidate }),
})
const widthSpy = (): Component & { seen: number[] } => {
  const seen: number[] = []
  return { seen, render: (w: number) => { seen.push(w); return ['x'] }, invalidate: () => {} } as never
}

describe('Gutter', () => {
  it('matches the composer prompt column, so the whole UI aligns on one column', () => {
    expect(GUTTER).toBe(2)
  })

  it('indents every non-empty row', () => {
    expect(new Gutter(stub(['a', 'bb'])).render(20)).toEqual(['  a', '  bb'])
  })

  it('leaves a blank row blank — trailing whitespace is invisible and pollutes a copy', () => {
    expect(new Gutter(stub(['a', '', 'b'])).render(20)).toEqual(['  a', '', '  b'])
  })

  it('preserves the width contract: the child renders narrower by exactly the gutter', () => {
    const child = widthSpy()
    new Gutter(child).render(40)
    expect(child.seen).toEqual([38])
  })

  it('a row that filled the narrower width still exactly fills the terminal', () => {
    const row = new Gutter(stub(['x'.repeat(38)])).render(40)[0]!
    expect(visibleWidth(row)).toBe(40)
  })

  it('never asks the child for a non-positive width, however narrow the terminal', () => {
    const child = widthSpy()
    for (const width of [0, 1, 2, 3]) new Gutter(child).render(width)
    expect(child.seen.every((w) => w >= 1)).toBe(true)
  })

  it('cascades invalidate, and tolerates a child that declares none', () => {
    const invalidate = vi.fn()
    new Gutter(stub(['a'], invalidate)).invalidate()
    expect(invalidate).toHaveBeenCalledOnce()
    expect(() => new Gutter(stub(['a'])).invalidate()).not.toThrow()
  })

  it('takes a custom width', () => {
    expect(new Gutter(stub(['a']), 4).render(20)).toEqual(['    a'])
  })
})
