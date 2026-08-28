import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { Footer, type FooterView } from '../src/ui/composer/footer.ts'

const p = createPalette(false)
const view = (over: Partial<FooterView> = {}): FooterView => ({
  cwd: '~/proj/app', branch: 'main', model: 'deepseek-chat', cachePercent: 87, contextPercent: 62, queued: 0, ...over,
})
const render = (over: Partial<FooterView> = {}, width = 72): string => {
  const footer = new Footer(p)
  footer.set(view(over))
  return footer.render(width)[0]!
}

describe('Footer (spec §4.3)', () => {
  it('renders the full template left-aligned', () => {
    expect(render()).toBe('~/proj/app · main · deepseek-chat · cache 87% · 62% ctx')
  })

  it('drops an absent value TOGETHER WITH its separator — never a stray dot or a zero', () => {
    expect(render({ branch: undefined, cachePercent: undefined })).toBe('~/proj/app · deepseek-chat · 62% ctx')
    expect(render({ cwd: undefined, branch: undefined, model: undefined, cachePercent: undefined, contextPercent: undefined })).toBe('')
    expect(render({ branch: '' })).toBe('~/proj/app · deepseek-chat · cache 87% · 62% ctx')
  })

  it('right-aligns the queued badge, and shows it only when something is waiting', () => {
    const row = render({ queued: 2 })
    expect(row.endsWith('⏳ 2 queued')).toBe(true)
    expect(row.startsWith('~/proj/app')).toBe(true)
    expect(visibleWidth(row)).toBe(72)
    expect(render({ queued: 0 })).not.toContain('queued')
  })

  it('gives the LEFT side away first when the terminal is narrow', () => {
    const narrow = render({ queued: 3 }, 24)
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(24)
    expect(narrow.endsWith('⏳ 3 queued')).toBe(true)      // the badge is never what gets cut
    expect(narrow).toContain('…')
  })

  it('keeps the badge alone when even it barely fits, and never overflows', () => {
    for (const width of [1, 5, 11, 12, 13]) {
      const row = render({ queued: 9 }, width)
      expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
    }
    expect(render({ queued: 9 }, 6)).not.toContain('proj')
  })

  it('truncates a long left side with no badge, and neutralizes controls (D7.8)', () => {
    expect(visibleWidth(render({ cwd: '~/very/long/workspace/path/that/keeps/going' }, 20))).toBeLessThanOrEqual(20)
    expect(render({ cwd: 'a\x1b]0;evil\x07' })).toContain('a\\x1b]0;evil\\x07')
  })

  it('tones the whole row dim, and invalidate is inert', () => {
    const footer = new Footer(createPalette(true))
    footer.set(view({ queued: 0 }))
    expect(footer.render(72)[0]).toBe(createPalette(true).dim('~/proj/app · main · deepseek-chat · cache 87% · 62% ctx'))
    expect(() => footer.invalidate()).not.toThrow()
  })
})
