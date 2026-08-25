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

describe('streaming Markdown live path (D11, Task 3)', () => {
  const colored = createPalette(true)
  const spec = paletteSpec('dark')
  const open = (code: string) => `\x1b[${code}m`
  const visible = (row: string) => row.replace(/\x1b\[[0-9;]*m/g, '')

  it('live markdown renders styled BEFORE settle: heading from the first deltas', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.update({ index: 0, block: 'text', text: '# Li' })
    cell.update({ index: 0, block: 'text', text: 've\n\nbody' })
    const rows = cell.render(80)
    expect(cell.isSettled()).toBe(false)
    const heading = rows.find((r) => r.includes('Live'))!
    expect(heading).toContain(open(spec.attributes.bold.open))
    expect(heading).toContain(open(spec.attributes.underline.open))
  })

  it('an open fence renders its body highlighted while still streaming', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.update({ index: 0, block: 'text', text: '```ts\n' })
    cell.update({ index: 0, block: 'text', text: 'const n = 1 // count' })
    const rows = cell.render(80)
    // fence border dim, body per ruling-13 roles — mid-stream, fence unclosed
    expect(rows.find((r) => visible(r).startsWith('```ts'))).toContain(open(spec.colors.dim.open))
    const body = rows.find((r) => r.includes('const'))!
    expect(body).toContain(`${open(spec.colors.code.open)}const`)
    expect(body).toContain(`${open(spec.colors.warning.open)}1`)
    expect(body).toContain(`${open(spec.colors.dim.open)}// count`)
  })

  it('rows stay stable inside an open fence: no shrink, no hr-run flicker, partial closer trimmed', () => {
    const cell = new StreamingAssistantCell(colored)
    const deltas = ['Intro\n\n```ts\n', 'const a = 1\n', '---\n', 'const b = 2\n', '``', '`']
    const frames: string[][] = []
    for (const text of deltas) {
      cell.update({ index: 0, block: 'text', text })
      frames.push(cell.render(80))
    }
    // monotonic: between consecutive deltas inside the fence the row count never shrinks
    for (let i = 1; i < frames.length; i++) expect(frames[i].length).toBeGreaterThanOrEqual(frames[i - 1].length)
    // '---' inside the open fence stays code body — never an hr run, at no frame
    for (const frame of frames) for (const row of frame) expect(visible(row)).not.toMatch(/─{3,}/)
    // the fence body renders as code (not a plain paragraph) while open
    expect(frames[3].find((r) => visible(r).includes('const a = 1'))).toContain(open(spec.colors.code.open))
    // the partial closing fence '``' is trimmed: no row shows it, row count unchanged
    expect(frames[4].length).toBe(frames[3].length)
    for (const row of frames[4]) expect(visible(row).trim()).not.toBe('``')
    // completing the closer keeps the same shape (the trim behavior end-to-end)
    expect(frames[5].length).toBe(frames[4].length)
  })

  it('settle still replaces the live markdown wholesale with authoritative content', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.update({ index: 0, block: 'text', text: '# Draft\n\n```ts\nlet x' })
    cell.settle([{ type: 'text', text: '# Final\n\nok' }])
    const rows = cell.render(80)
    const joined = rows.join('\n')
    expect(joined).toContain('Final')
    expect(joined).not.toContain('Draft')
    expect(joined).not.toContain('let x')
    expect(rows.find((r) => r.includes('Final'))).toContain(open(spec.attributes.bold.open))
  })

  it('live and settled sources agree: multiple live text blocks join with \\n\\n', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.update({ index: 0, block: 'text', text: 'first' })
    cell.update({ index: 2, block: 'text', text: 'second' })
    const live = cell.render(80)
    const joined = live.join('\n')
    expect(joined.indexOf('second')).toBeGreaterThan(joined.indexOf('first'))
    expect(live.filter((r) => r.includes('talon')).length).toBe(1)
    // settling with the same blocks renders the identical rows (same joined source)
    cell.settle([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])
    expect(cell.render(80)).toEqual(live)
  })

  it('lineCount stays the incremental logical-source-line law while streaming markdown', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.update({ index: 0, block: 'text', text: '# Title line\n\n' })
    cell.update({ index: 0, block: 'text', text: '```ts\nconst n = 1 // a comment that wraps at narrow width\n' })
    cell.update({ index: 0, block: 'text', text: '```' })
    // header + 5 accumulated source lines — width-free, never rendered rows
    expect(cell.lineCount()).toBe(6)
    const narrow = cell.render(24)
    cell.render(120)
    expect(cell.lineCount()).toBe(6)
    expect(narrow.length).not.toBe(cell.lineCount())
  })

  it('reasoning deltas never touch the markdown path (plain dim+italic, Ruling 16)', () => {
    const cell = new StreamingAssistantCell(colored)
    cell.update({ index: 0, block: 'reasoning', text: '## not markdown' })
    cell.update({ index: 1, block: 'text', text: 'ok' })
    const rows = cell.render(80)
    expect(rows[1]).toBe(colored.dim(colored.italic('## not markdown')))
    expect(rows.slice(2).join('\n')).toContain('ok')
    // a reasoning-only live cell renders without ever constructing markdown
    const only = new StreamingAssistantCell(colored)
    only.update({ index: 0, block: 'reasoning', text: 'thinking' })
    expect(only.render(80)[1]).toBe(colored.dim(colored.italic('thinking')))
  })
})
