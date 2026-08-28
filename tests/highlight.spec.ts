import hljs from 'highlight.js'
import { describe, expect, it } from 'vitest'
import { highlightToAnsi } from '../src/theme/highlight.ts'
import { createPalette, displayText, paletteSpec, type ColorRole } from '../src/theme/palette.ts'

const palette = createPalette(true, 'dark')
const spec = paletteSpec('dark')
/** Expected SGR built from the paletteSpec table, never from raw literals. */
const wrap = (role: ColorRole, s: string) => `\x1b[${spec.colors[role].open}m${s}\x1b[${spec.colors[role].close}m`
const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

describe('highlightToAnsi role mapping (ruling 13)', () => {
  it('maps keyword/string/comment/number/literal/title scopes to their palette roles', () => {
    const code = '// note\nconst ok = true\nconst n = 42\nfunction greet(name) {\n  return "hi"\n}'
    const lines = highlightToAnsi(code, 'typescript', palette)
    expect(lines).toEqual([
      wrap('dim', '// note'),
      `${wrap('code', 'const')} ok = ${wrap('warning', 'true')}`,
      `${wrap('code', 'const')} n = ${wrap('warning', '42')}`,
      `${wrap('code', 'function')} ${wrap('accent', 'greet')}(name) {`,
      `  ${wrap('code', 'return')} ${wrap('success', '"hi"')}`,
      '}',
    ])
  })

  it('re-opens a multi-line scope on every line (no SGR spans a line break)', () => {
    expect(highlightToAnsi('/* a\nb */', 'typescript', palette)).toEqual([
      wrap('dim', '/* a'),
      wrap('dim', 'b */'),
    ])
  })
})

describe('highlightToAnsi fallback', () => {
  it('renders every line in the code role when the lang is unknown', () => {
    expect(highlightToAnsi('alpha\n\nbeta', 'nope-lang', palette)).toEqual([
      wrap('code', 'alpha'),
      '',
      wrap('code', 'beta'),
    ])
  })

  it('renders every line in the code role when the lang is absent', () => {
    expect(highlightToAnsi('x = 1', undefined, palette)).toEqual([wrap('code', 'x = 1')])
  })

  it('falls back whole-block when a grammar crashes under hljs SAFE_MODE (partial tree)', () => {
    hljs.registerLanguage('boom', () => ({
      name: 'boom',
      contains: [{ scope: 'keyword', begin: /x/, 'on:begin': () => { throw new Error('kaboom') } }],
    }))
    expect(highlightToAnsi('a\nx b\nc', 'boom', palette)).toEqual([
      wrap('code', 'a'),
      wrap('code', 'x b'),
      wrap('code', 'c'),
    ])
  })
})

describe('highlightToAnsi safety properties', () => {
  // Fence bodies arrive already displayText-escaped (D7.8); the raw-control
  // entries below go through displayText exactly like production callers.
  const corpus = [
    displayText('\x1b[38;2;255;0;0mred\x1b[0m fg injection'),
    displayText('\x1b]0;evil title\x07 osc'),
    displayText('\x9b48;5;99m bare C1 CSI'),
    'const s = "\\x1b[48;2;9;9;9m"; // printable truecolor lookalike',
    '# 38;2;0;0;0 bare digits\nprint("\\x1b[38;5;196m")',
    '{"esc": "\\u001b[48;5;1m", "n": 42}',
  ]
  const langs = ['typescript', 'python', 'json', 'nope-lang', undefined]

  it('emits only paletteSpec sequences — no truecolor/extended — and never un-escapes', () => {
    const allowed = new Set<string>()
    for (const role of Object.values(spec.colors)) {
      if (role.open === '') continue
      allowed.add(`\x1b[${role.open}m`)
      allowed.add(`\x1b[${role.close}m`)
    }
    for (const body of corpus) {
      for (const lang of langs) {
        const lines = highlightToAnsi(body, lang, palette)
        // 1:1 line mapping, and stripping our own SGR restores the input
        // verbatim — the pre-escaped \x1b fragments stay printable text.
        expect(lines.map(stripSgr)).toEqual(body.split('\n'))
        const joined = lines.join('\n')
        expect(joined).not.toMatch(/\x1b\[[0-9;]*[34]8;/)
        for (const esc of joined.match(/\x1b\[[0-9;]*m/g) ?? []) expect(allowed.has(esc)).toBe(true)
      }
    }
  })

  it('is deterministic across repeated calls', () => {
    const code = 'const x = { a: [1, "two"] } // trailing'
    expect(highlightToAnsi(code, 'typescript', palette)).toEqual(highlightToAnsi(code, 'typescript', palette))
  })

  it('maps lines 1:1 including leading/trailing/blank lines', () => {
    const code = '\nconst a = 1\n\n// end\n'
    const lines = highlightToAnsi(code, 'typescript', palette)
    expect(lines).toHaveLength(5)
    expect(lines.map(stripSgr)).toEqual(code.split('\n'))
  })

  it('returns the input verbatim under a disabled palette (identity roles)', () => {
    const disabled = createPalette(false, 'dark')
    expect(highlightToAnsi('// c\nconst n = 42', 'typescript', disabled)).toEqual(['// c', 'const n = 42'])
    expect(highlightToAnsi('// c\nconst n = 42', 'nope-lang', disabled)).toEqual(['// c', 'const n = 42'])
  })
})
