import { describe, expect, it } from 'vitest'
import { DEFAULT_TITLE, MAX_TITLE_LENGTH, TerminalTitle, sanitizeTitle } from '../src/ui/terminal-title.ts'

describe('sanitizeTitle (spec §8 T4 — the title is model output)', () => {
  it('neutralizes controls and BIDI, exactly as a rendered row does', () => {
    expect(sanitizeTitle('fix\x1b]0;evil\x07 login')).toBe('fix\\x1b]0;evil\\x07 login')
    expect(sanitizeTitle('a‮b')).toBe('a\\u202eb')
  })
  it('flattens to ONE line and collapses runs of whitespace', () => {
    expect(sanitizeTitle('two\nlines')).toBe('two lines')
    expect(sanitizeTitle('  padded   out  ')).toBe('padded out')
  })
  it('bounds the length, because a long title pushes the real one out of view', () => {
    const long = sanitizeTitle('x'.repeat(500))
    expect(long).toHaveLength(MAX_TITLE_LENGTH)
    expect(long.endsWith('…')).toBe(true)
    expect(sanitizeTitle('x'.repeat(MAX_TITLE_LENGTH))).toHaveLength(MAX_TITLE_LENGTH)   // exactly at the cap: untouched
  })
  it('answers the default rather than blanking the bar', () => {
    for (const empty of ['', '   ', '\n\n']) expect(sanitizeTitle(empty)).toBe(DEFAULT_TITLE)
  })
  it('leaves ordinary text alone, including CJK and emoji', () => {
    expect(sanitizeTitle('修复登录流程 🙂')).toBe('修复登录流程 🙂')
  })
})

describe('TerminalTitle', () => {
  const spy = () => { const titles: string[] = []; return { titles, setTitle: (t: string) => titles.push(t) } }

  it('writes the sanitized title, and never repaints an unchanged one', () => {
    const terminal = spy()
    const title = new TerminalTitle(terminal)
    title.set('Fix the login flow')
    title.set('Fix the login flow')
    title.set('Fix   the\nlogin flow')            // sanitizes to the same string
    expect(terminal.titles).toEqual(['Fix the login flow'])
  })
  it('resets to the default, and that too is written only when it changes', () => {
    const terminal = spy()
    const title = new TerminalTitle(terminal)
    title.reset()
    title.set('Ship the webhook')
    title.reset()
    expect(terminal.titles).toEqual([DEFAULT_TITLE, 'Ship the webhook', DEFAULT_TITLE])
  })
})
