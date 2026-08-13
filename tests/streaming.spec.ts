import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { StreamingAssistantCell } from '../src/ui/transcript/streaming.ts'

const p = createPalette(false)

describe('StreamingAssistantCell', () => {
  it('accumulates deltas per block index and renders in index order', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 1, block: 'text', text: 'wor' })
    cell.update({ index: 0, block: 'reasoning', text: 'think' })
    cell.update({ index: 1, block: 'text', text: 'ld' })
    const out = cell.render(80).join('\n')
    expect(out.indexOf('think')).toBeLessThan(out.indexOf('world'))
  })
  it('settle replaces accumulated content with authoritative blocks', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'partial gar' })
    cell.settle([{ type: 'text', text: 'authoritative final' }])
    const out = cell.render(80).join('\n')
    expect(out).toContain('authoritative final')
    expect(out).not.toContain('partial gar')
    expect(cell.isSettled()).toBe(true)
  })
  it('ignores updates after settle', () => {
    const cell = new StreamingAssistantCell(p)
    cell.settle([{ type: 'text', text: 'done' }])
    cell.update({ index: 0, block: 'text', text: 'late' })
    expect(cell.render(80).join('\n')).not.toContain('late')
  })
  it('neutralizes hostile controls in streamed text', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'x\x1b]0;pwn\x07y' })
    expect(cell.render(80).join('\n')).toContain('x\\x1b]0;pwn\\x07y')
  })
  it('caches rendered lines by width once settled (I4)', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'partial' })
    cell.settle([{ type: 'text', text: 'final' }])
    const a = cell.render(80)
    expect(cell.render(80)).toBe(a) // same reference: served from cache, not re-rendered
    const b = cell.render(80)
    expect(b).toBe(a)
  })
  it('does not cache while still live (content changes every chunk)', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'partial' })
    const a = cell.render(80)
    cell.update({ index: 0, block: 'text', text: ' more' })
    const b = cell.render(80)
    expect(b).not.toBe(a)
    expect(b.join('\n')).toContain('partial more')
  })
})
