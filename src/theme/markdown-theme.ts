/** pi-tui MarkdownTheme mapped to palette roles only (D11, spec D6): every
 * slot is a palette closure — no raw SGR, no backgrounds — so rendered
 * markdown survives themeViolations(). pi-tui composes structure itself
 * (markdown.js: h1 = heading(bold(underline(text))), link =
 * link(underline(text)), quote = quote(italic(text))), so each slot maps to
 * a single role and the composition yields the spec'd look: headings
 * bold(+underline for h1), links underline+accent, quotes dim italic.
 * highlightCode is the entire highlighting seam: pi-tui hands it the whole
 * fence body (already displayText-escaped upstream, D7.8) and indents+wraps
 * the returned pre-split lines. */
import type { MarkdownTheme } from '@earendil-works/pi-tui'
import { highlightToAnsi } from './highlight.js'
import type { Palette } from './palette.js'

export function markdownTheme(palette: Palette): MarkdownTheme {
  return {
    heading: palette.bold,
    link: palette.accent,
    linkUrl: palette.dim,
    code: palette.code,
    codeBlock: palette.code,
    codeBlockBorder: palette.dim,
    quote: palette.dim,
    quoteBorder: palette.dim,
    hr: palette.dim,
    listBullet: palette.dim,
    bold: palette.bold,
    italic: palette.italic,
    strikethrough: palette.strike,
    underline: palette.underline,
    highlightCode: (code, lang) => highlightToAnsi(code, lang, palette),
  }
}
