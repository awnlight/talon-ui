import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { CachedCell, messageHeader, NoticeCell, UserMessageCell } from '../src/ui/transcript/cells.ts'

const p = createPalette(false)

describe('messageHeader', () => {
  it('is bold+underline colored label with no gutter prefix', () => {
    const colored = createPalette(true)
    expect(messageHeader('You', colored.text, colored)).toBe('\x1b[1m\x1b[4mYou\x1b[24m\x1b[22m')
  })
  it('neutralizes controls in the label', () => {
    expect(messageHeader('a\x1bb', p.text, p)).toBe('a\\x1bb')
  })
})

describe('CachedCell contract', () => {
  class Probe extends CachedCell {
    computes = 0
    protected renderLines(width: number): string[] { this.computes++; return [`w=${width}`] }
    poke(): void { this.dropLines() }
  }
  it('serves identical array reference for repeat same-width renders', () => {
    const c = new Probe()
    const a = c.render(80)
    expect(c.render(80)).toBe(a)          // reference identity — the perf law (spec §5.1)
    expect(c.computes).toBe(1)
  })
  it('recomputes on width change and on dropLines and on invalidate', () => {
    const c = new Probe()
    const a = c.render(80)
    expect(c.render(60)).not.toBe(a)
    const b = c.render(60)
    c.poke()
    expect(c.render(60)).not.toBe(b)
    const d = c.render(60)
    c.invalidate()
    expect(c.render(60)).not.toBe(d)
  })
})

describe('UserMessageCell / NoticeCell', () => {
  it('renders header + body with controls neutralized', () => {
    const cell = new UserMessageCell('hello\x07world', p)
    const lines = cell.render(80)
    expect(lines[0]).toContain('You')
    expect(lines.join('\n')).toContain('hello\\x07world')
  })
  it('notice renders single toned line', () => {
    const cell = new NoticeCell({ text: 'Turn cancelled.', tone: 'warning' }, p)
    expect(cell.render(80).join('\n')).toContain('Turn cancelled.')
  })
  it('each notice tone picks its own color role', () => {
    const colored = createPalette(true)
    expect(new NoticeCell({ text: 'x', tone: 'info' }, colored).render(80)[0]).toBe(colored.dim('x'))
    expect(new NoticeCell({ text: 'x', tone: 'warning' }, colored).render(80)[0]).toBe(colored.warning('x'))
    expect(new NoticeCell({ text: 'x', tone: 'error' }, colored).render(80)[0]).toBe(colored.error('x'))
  })
})

describe('width wrapping (TuiMainScreen row-width law)', () => {
  it('wraps long user-message bodies so no row exceeds the width', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui')
    const long = 'word '.repeat(120).trim()
    const cell = new UserMessageCell(long, p)
    const rows = cell.render(40)
    expect(rows.length).toBeGreaterThan(2)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
  })
  it('contentLineCount stays width-invariant', () => {
    const cell = new UserMessageCell('a\nb\nc', p)
    expect(cell.contentLineCount()).toBe(4)
    cell.render(10)
    cell.render(200)
    expect(cell.contentLineCount()).toBe(4)
  })
  it('renders at width 1 without throwing (extreme narrow wrap)', () => {
    const cell = new UserMessageCell('hi', p)
    expect(() => cell.render(1)).not.toThrow()
  })
  it('an embedded blank logical line renders as an empty row', () => {
    const cell = new UserMessageCell('hello\n\nworld', p)
    expect(cell.render(80)).toContain('')
  })
})
