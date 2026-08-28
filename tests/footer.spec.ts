import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { Footer, type FooterView } from '../src/ui/composer/footer.ts'

const p = createPalette(false)
const view = (over: Partial<FooterView> = {}): FooterView => ({
  project: 'app', branch: 'main', model: 'deepseek-chat', cachePercent: 87, contextPercent: 62, queued: 0, agents: 0, ...over,
})
const render = (over: Partial<FooterView> = {}, width = 72): string => {
  const footer = new Footer(p)
  footer.set(view(over))
  return footer.render(width)[0]!
}

describe('Footer (spec §4.3)', () => {
  it('renders the full template left-aligned', () => {
    expect(render()).toBe('app · main · deepseek-chat · cache 87% · 62% ctx')
  })

  it('drops an absent value TOGETHER WITH its separator — never a stray dot or a zero', () => {
    expect(render({ branch: undefined, cachePercent: undefined })).toBe('app · deepseek-chat · 62% ctx')
    expect(render({ project: undefined, branch: undefined, model: undefined, cachePercent: undefined, contextPercent: undefined })).toBe('')
    expect(render({ branch: '' })).toBe('app · deepseek-chat · cache 87% · 62% ctx')
  })

  it('right-aligns the queued badge, and shows it only when something is waiting', () => {
    const row = render({ queued: 2 })
    expect(row.endsWith('⏳ 2 queued')).toBe(true)
    expect(row.startsWith('app')).toBe(true)
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
    expect(render({ queued: 9 }, 6)).not.toContain('app')
  })

  it('truncates a long left side with no badge, and neutralizes controls (D7.8)', () => {
    expect(visibleWidth(render({ project: 'a-very-long-project-name-that-keeps-going' }, 20))).toBeLessThanOrEqual(20)
    expect(render({ project: 'a\x1b]0;evil\x07' })).toContain('a\\x1b]0;evil\\x07')
  })

  it('tones by RANK, not one flat dim row: identity plain, model brand, reference dim', () => {
    const c = createPalette(true)
    const footer = new Footer(c)
    footer.set(view({ queued: 0 }))
    const row = footer.render(72)[0]!
    expect(row.startsWith('app')).toBe(true)                 // identity: the terminal's own foreground
    expect(row).toContain(c.brand('deepseek-chat'))          // the model is the consequential setting
    expect(row).toContain(c.dim('cache 87%'))                // reference values stay quiet
    expect(() => footer.invalidate()).not.toThrow()
  })

  it('escalates context occupancy by threshold — the one number that becomes a problem', () => {
    const c = createPalette(true)
    const tone = (percent: number): string => {
      const footer = new Footer(c)
      footer.set(view({ contextPercent: percent }))
      return footer.render(72)[0]!
    }
    expect(tone(62)).toContain(c.dim('62% ctx'))
    expect(tone(74)).toContain(c.dim('74% ctx'))
    expect(tone(75)).toContain(c.warning('75% ctx'))
    expect(tone(89)).toContain(c.warning('89% ctx'))
    expect(tone(90)).toContain(c.error('90% ctx'))
    expect(tone(100)).toContain(c.error('100% ctx'))
  })

  it('tones the live badges apart — running agents accent, a waiting queue warning', () => {
    const c = createPalette(true)
    const footer = new Footer(c)
    footer.set(view({ agents: 2, queued: 3 }))
    const row = footer.render(90)[0]!
    expect(row).toContain(c.accent('⚙ 2 agents'))
    expect(row).toContain(c.warning('⏳ 3 queued'))
  })
})

describe('Footer subagent badge (spec §3.9)', () => {
  it('shows running subagents beside the queue, and only while some are running', () => {
    expect(render({ agents: 2 })).toContain('⚙ 2 agents')
    expect(render({ agents: 1 })).toContain('⚙ 1 agent')
    expect(render({ agents: 0 })).not.toContain('agent')
    const both = render({ agents: 3, queued: 2 })
    expect(both).toContain('⚙ 3 agents · ⏳ 2 queued')
    expect(visibleWidth(both)).toBe(72)
  })
})
