/** The boot banner (spec D6: 启动 wordmark 渐变) — the brand entry that never
 * existed until now: `brandGradient` shipped in T3 and was wired to nothing
 * but its own unit test, so `dsh --profile talon` opened on a bare rule. */
import { describe, expect, it } from 'vitest'
import { Text, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { BannerCell, MARK, type BannerView } from '../src/ui/banner.ts'
import { brandGrid, createPalette } from '../src/theme/palette.ts'

const view = (over: Partial<BannerView> = {}): BannerView => ({
  version: '0.1.0', model: 'deepseek-v4-pro', cwd: '~/proj/app', ...over,
})
const render = (over: Partial<BannerView> = {}, width = 90, palette = createPalette(false)): string[] =>
  new BannerCell(view(over), palette).render(width)

describe('BannerCell (spec D6)', () => {
  it('sets the mark beside three facts, every text row on ONE column', () => {
    const rows = render()
    expect(rows).toHaveLength(MARK.length)
    const markWidth = Math.max(...MARK.map((row) => visibleWidth(row)))
    // Rows 1-3 carry text; the mark's own rows differ in width, so the pad is
    // what proves the text block is a block rather than a ragged edge.
    for (const i of [1, 2, 3]) expect(rows[i]!.indexOf(rows[i]!.trimStart().slice(-1))).toBeGreaterThan(markWidth)
    expect(rows[1]).toContain('talon')
    expect(rows[1]).toContain('v0.1.0')
    expect(rows[2]).toContain('deepseek-v4-pro')
    expect(rows[3]).toContain('~/proj/app')
    expect(rows[0]!.trimEnd()).toBe(MARK[0])          // no text on the first mark row
    expect(rows[4]!.trimEnd()).toBe(MARK[4])          // nor the last
  })

  it('is the ONE place the full working directory is spelled out', () => {
    expect(render({ cwd: '~/Dev/proj/for-private/agents/deepseek-harness' })[3])
      .toContain('~/Dev/proj/for-private/agents/deepseek-harness')
  })

  it('drops an absent value together with its line, exactly as the footer does', () => {
    // No model declared yet: the line vanishes and the cwd moves up into it,
    // rather than leaving a blank row where a fact was going to be.
    expect(render({ model: undefined })[2]).toContain('~/proj/app')
    expect(render({ model: undefined })[3]!.trimEnd()).toBe(MARK[3])
  })

  it('drops the version rather than inventing one when package.json is unreadable', () => {
    const rows = render({ version: undefined })
    expect(rows[1]).toContain('talon')
    expect(rows[1]).not.toContain('v')                 // no `v0.0.0` asserting a version that is not true
  })

  it('gives the mark away when the terminal cannot hold both — the facts win', () => {
    const narrow = render({}, 30)
    expect(narrow.some((row) => row.includes('█'))).toBe(false)
    expect(narrow[0]).toContain('talon')
    for (const row of narrow) expect(visibleWidth(row)).toBeLessThanOrEqual(30)
  })

  it('never emits a row wider than the terminal, at any width', () => {
    for (const width of [1, 4, 17, 29, 30, 45, 200]) {
      for (const row of render({ cwd: '~/a/very/long/path/that/keeps/on/going/forever' }, width)) {
        expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('renders boot notices under the banner, toned, one row each', () => {
    const p = createPalette(true)
    const rows = new BannerCell(view({
      notes: [
        { text: 'skills failed to load', tone: 'warning' },
        { text: 'no attachment store', tone: 'error' },
        { text: 'resumed from a previous session', tone: 'info' },
      ],
    }), p).render(90)
    expect(rows).toHaveLength(MARK.length + 3)
    expect(rows[5]).toBe(p.warning('⚠ skills failed to load'))
    expect(rows[6]).toBe(p.error('⚠ no attachment store'))
    expect(rows[7]).toBe(p.dim('· resumed from a previous session'))
  })

  it('counts its own content lines for the mount cap, notes included', () => {
    expect(new BannerCell(view(), createPalette(false)).contentLineCount()).toBe(MARK.length)
    expect(new BannerCell(view({ notes: [{ text: 'x', tone: 'info' }] }), createPalette(false)).contentLineCount()).toBe(MARK.length + 1)
  })

  it('neutralizes terminal controls in every field it prints (D7.8)', () => {
    const rows = render({ model: 'a\x1b]0;evil\x07', cwd: 'b\x1b[2J', version: '9\x07', notes: [{ text: 'c\x1b[H', tone: 'warning' }] }, 120)
    const all = rows.join('\n')
    expect(all).toContain('a\\x1b]0;evil\\x07')
    expect(all).toContain('b\\x1b[2J')
    expect(all).toContain('9\\x07')
    expect(all).toContain('c\\x1b[H')
  })
})

describe('the banner and the theme gate (spec §7.1)', () => {
  /** The gate's ONE exemption is an rgb foreground on the brand ramp. The
   * committed snapshots all run `createPalette(true)` — trueColor `false` —
   * so without this test the gradient the banner actually SHIPS would never
   * meet `themeViolations()` at all. */
  const paint = async (trueColor: boolean): Promise<HeadlessTerminal> => {
    const p = createPalette(true, 'dark', trueColor)
    const term = new HeadlessTerminal(90, 12)
    const tui = new TuiMainScreen(term)
    for (const row of new BannerCell(view(), p).render(90)) tui.addChild(new Text(row, 0, 0))
    tui.start()
    await term.waitForFrame(0)
    tui.stop()
    return term
  }

  it('paints the whole mark ON the brand ramp under truecolor', async () => {
    expect((await paint(true)).themeViolations()).toEqual([])
  })

  it('degrades to the ANSI-16 brand role without truecolor', async () => {
    expect((await paint(false)).themeViolations()).toEqual([])
  })
})

describe('brandGrid', () => {
  it('sweeps the ramp diagonally, so the mark reads as one light source', () => {
    const p = createPalette(true, 'dark', true)
    const [first, second] = brandGrid(['##', '##'], p)
    // Row 1 starts where row 0's second column already was: the sweep is on
    // (x + y), not on x alone, or every row would restart at the same stop.
    expect(first!.match(/38;2;\d+;\d+;\d+/g)![1]).toBe(second!.match(/38;2;\d+;\d+;\d+/g)![0])
  })
  it('leaves blanks unpainted and answers an empty row with an empty string', () => {
    const p = createPalette(true, 'dark', true)
    expect(brandGrid([''], p)).toEqual([''])
    expect(brandGrid([' '], p)).toEqual([' \x1b[39m'])
  })
  it('falls back to the ANSI-16 brand role, and to plain text under NO_COLOR', () => {
    expect(brandGrid(['ab'], createPalette(true, 'dark', false))).toEqual([createPalette(true).brand('ab')])
    expect(brandGrid(['ab'], createPalette(false, 'dark', true))).toEqual(['ab'])
  })
})
