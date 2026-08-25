import { describe, expect, it } from 'vitest'
import { createPalette, paletteSpec } from '../src/theme/palette.ts'
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
  it('settle: a content block with text undefined renders header only (b.text ?? \'\' → Markdown collapses empty source)', () => {
    const cell = new StreamingAssistantCell(p)
    cell.settle([{ type: 'text' }])
    const lines = cell.render(80)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('talon')
  })
  it('invalidate() drops the settled cache, forcing a re-render', () => {
    const cell = new StreamingAssistantCell(p)
    cell.settle([{ type: 'text', text: 'final' }])
    const a = cell.render(80)
    cell.invalidate()
    const b = cell.render(80)
    expect(b).not.toBe(a) // cache was dropped: a fresh array
    expect(b).toEqual(a) // same content though
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

describe('width wrapping', () => {
  it('wraps long streamed lines so no row exceeds the width', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui')
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'x'.repeat(500) })
    for (const row of cell.render(60)) expect(visibleWidth(row)).toBeLessThanOrEqual(60)
    cell.settle([{ type: 'text', text: 'y'.repeat(500) }])
    for (const row of cell.render(60)) expect(visibleWidth(row)).toBeLessThanOrEqual(60)
  })
})

describe('settled Markdown rendering (D11/spec §4, Task 2)', () => {
  const colored = createPalette(true)
  const spec = paletteSpec('dark')
  const open = (code: string) => `\x1b[${code}m`
  const MD_SOURCE = '# Title\n```ts\nconst n = 1 // count\n```\n- one\n- **two**'

  it('settled markdown renders heading bold+underline, highlighted fence, bullet rows', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.settle([{ type: 'text', text: MD_SOURCE }])
    const rows = cell.render(80)
    const heading = rows.find((r) => r.includes('Title'))!
    expect(heading).toContain(open(spec.attributes.bold.open))
    expect(heading).toContain(open(spec.attributes.underline.open))
    // fence body: keyword→code, number→warning, comment→dim (ruling 13 roles,
    // asserted from paletteSpec opens — never raw literals)
    const fence = rows.find((r) => r.includes('const'))!
    expect(fence).toContain(`${open(spec.colors.code.open)}const`)
    expect(fence).toContain(`${open(spec.colors.warning.open)}1`)
    expect(fence).toContain(`${open(spec.colors.dim.open)}// count`)
    // fence borders wear the dim codeBlockBorder role
    expect(rows.find((r) => r.includes('```ts'))).toContain(open(spec.colors.dim.open))
    // bullet rows: dim '- ' marker, bold inline emphasis
    expect(rows.find((r) => r.includes('one'))).toContain(colored.dim('- '))
    expect(rows.find((r) => r.includes('two'))).toContain(colored.bold('two'))
  })

  it('serves the same array reference across repeated same-width renders after settle (.toBe pin)', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.settle([{ type: 'text', text: MD_SOURCE }])
    const a = cell.render(80)
    expect(cell.render(80)).toBe(a)
    expect(cell.render(80)).toBe(a)
  })

  it('lineCount stays the width-free logical-source-line law, not rendered rows', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.settle([{ type: 'text', text: MD_SOURCE }])
    // header + the 6 source lines — pinned counting rule for settled markdown
    // cells: derived from source text lines, NEVER width-dependent rendered rows.
    expect(cell.lineCount()).toBe(7)
    const narrow = cell.render(24)
    const wide = cell.render(120)
    expect(cell.lineCount()).toBe(7)
    // markdown adds structural rows (fence borders, heading spacing): proves
    // the count is not derived from rendered rows at either width
    expect(narrow.length).not.toBe(cell.lineCount())
    expect(wide.length).not.toBe(cell.lineCount())
  })

  it('hostile control chars in markdown text render escaped (displayText BEFORE the parser)', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.settle([{ type: 'text', text: '# T\x1b]0;pwn\x07itle\n\nbody \x9bhere' }])
    const out = cell.render(80).join('\n')
    expect(out).toContain('T\\x1b]0;pwn\\x07itle')
    expect(out).toContain('body \\x9bhere')
    expect(out).not.toContain('\x1b]') // no raw OSC survives into the rows
  })

  it('reasoning blocks stay plain dim+italic above the markdown text (Ruling 16)', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.settle([{ type: 'reasoning', text: '## not markdown' }, { type: 'text', text: 'ok' }])
    const rows = cell.render(80)
    // rendered verbatim through the plain path: no heading styling, exact dim+italic wrap
    expect(rows[1]).toBe(colored.dim(colored.italic('## not markdown')))
    expect(rows.slice(2).join('\n')).toContain('ok')
  })

  it('multiple text blocks join into ONE markdown stream at the first text position', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.settle([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])
    const out = cell.render(80)
    const joined = out.join('\n')
    expect(joined.indexOf('first')).toBeGreaterThan(-1)
    expect(joined.indexOf('second')).toBeGreaterThan(joined.indexOf('first'))
    // joined as separate paragraphs, not re-rendered per block: exactly one header row
    expect(out.filter((r) => r.includes('talon')).length).toBe(1)
  })
})
