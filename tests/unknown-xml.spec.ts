import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { renderUnknownXml } from '../src/ui/transcript/unknown-xml.ts'

const p = createPalette(false)
const colored = createPalette(true)

describe('renderUnknownXml (D13: a real parser or an explicit refusal, never a regex)', () => {
  it('renders a well-formed document as an indented element tree', () => {
    expect(renderUnknownXml('<result><file>a.ts</file><file>b.ts</file></result>', p)).toEqual([
      '<result>',
      '  <file>',
      '    a.ts',
      '  <file>',
      '    b.ts',
    ])
  })

  it('keeps attributes on the tag row and dims every tag, never the content', () => {
    const rows = renderUnknownXml('<page url="https://a.example/" n="2">body text</page>', colored)
    expect(rows).toEqual([colored.dim('<page url="https://a.example/" n="2">'), '  body text'])
  })

  it('accepts a fragment with several roots, and empty elements', () => {
    expect(renderUnknownXml('<a/><b>x</b>', p)).toEqual(['<a>', '<b>', '  x'])
  })

  it('splits multi-line text content into one row per line, trimmed to the child indent', () => {
    expect(renderUnknownXml('<log>\n  first\n  second\n</log>', p)).toEqual(['<log>', '  first', '  second'])
  })

  it('decodes the predefined entities rather than echoing them', () => {
    expect(renderUnknownXml('<t>a &lt; b &amp; c</t>', p)).toEqual(['<t>', '  a &lt; b &amp; c'.replace('&lt;', '<').replace('&amp;', '&')])
  })

  it('REFUSES malformed input so the caller can fall back to plain text', () => {
    for (const malformed of [
      '<a><b></a>',                       // mismatched close
      '<a>',                              // unclosed root
      '</a>',                             // stray close
      '<a>&undefined;</a>',               // undefined entity
      '<a b=unquoted>x</a>',              // unquoted attribute
      '<1bad>x</1bad>',                   // illegal name
      '<a>x</a><',                        // truncated tail
      '<a><<b></b></a>',                  // stray angle
      '<a b="1" b="2"/>',                 // duplicate attribute
      '<?xml version="9.9"?><a/>',        // impossible declaration
      '<a>]]></a>',                       // stray CDATA close
    ]) expect(renderUnknownXml(malformed, p), malformed).toBeUndefined()
  })

  it('REFUSES text that is not a tree at all, so plain output stays plain', () => {
    expect(renderUnknownXml('12 passed, 0 failed', p)).toBeUndefined()
    expect(renderUnknownXml('', p)).toBeUndefined()
    expect(renderUnknownXml('   ', p)).toBeUndefined()
  })

  it('neutralizes terminal controls on BOTH routes: the parser refuses them, displayText escapes the rest', () => {
    // A raw ESC is not a legal XML character, so the escape sequence never even
    // reaches the tree — it is refused, and the plain fallback escapes it.
    expect(renderUnknownXml('<tag a="\x1b]0;evil\x07">te\x1bxt</tag>', p)).toBeUndefined()
    expect(renderUnknownXml('<t>&#27;evil</t>', p)).toBeUndefined()      // nor through a character reference
    // TAB and CR ARE legal XML, so they survive the parser — and displayText
    // catches them on the way to the screen (D7.8).
    expect(renderUnknownXml('<t a="x&#9;y">a&#9;b</t>', p)).toEqual(['<t a="x\\x09y">', '  a\\x09b'])
  })

  it('caps runaway nesting so a hostile document cannot indent rows off the screen', () => {
    const deep = `${'<a>'.repeat(40)}x${'</a>'.repeat(40)}`
    const rows = renderUnknownXml(deep, p)!
    expect(Math.max(...rows.map((row) => row.length - row.trimStart().length))).toBeLessThanOrEqual(16)
  })

  it('keeps every row a single logical line, so the fold and the mount cap stay honest', () => {
    for (const row of renderUnknownXml('<a>one\ntwo</a>', p)!) expect(row).not.toContain('\n')
  })
})
