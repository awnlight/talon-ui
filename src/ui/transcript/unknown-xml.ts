/** D13: an unregistered tool's output goes through a REAL parser or gets an
 * explicit refusal — never a regex. Well-formed XML renders as an indented
 * element tree; anything malformed answers `undefined` and the card falls back
 * to plain dim text.
 *
 * The tree drops closing tags: indentation already carries the structure, and
 * talon's visual language is zero decoration (spec §4). Tags are dim, content
 * is not — one dim frame around plain text, the same shape every card uses.
 *
 * The OTHER half of D13 is a rule about what never reaches here: injected
 * context (`<system-reminder>`-style wrappers) is NEVER XML-parsed. That path
 * was settled upstream in T2 — such a message becomes a ContextCard in
 * translate and never becomes a tool card at all. */
import { SaxesParser } from 'saxes'
import { displayText, type Palette } from '../../theme/palette.js'

const INDENT = '  '
/** Indentation stops growing here: a hostile document can nest arbitrarily
 * deep, and rows indented past the terminal width are unreadable either way. */
const MAX_DEPTH = 8

export function renderUnknownXml(text: string, palette: Palette): string[] | undefined {
  const lines: string[] = []
  let depth = 0
  let elements = 0
  let refused = false

  const parser = new SaxesParser({ fragment: true })
  // With a handler registered saxes reports instead of throwing, so one
  // malformed document can never take the frame down with it.
  parser.on('error', () => { refused = true })
  parser.on('opentag', (tag) => {
    elements++
    const attributes = Object.entries(tag.attributes as Record<string, string>)
      .map(([name, value]) => ` ${name}="${value}"`)
      .join('')
    lines.push(indent(depth) + palette.dim(displayText(`<${tag.name}${attributes}>`)))
    depth++
  })
  parser.on('closetag', () => { depth-- })
  parser.on('text', (chunk) => {
    // Layout whitespace between elements is structure, not content.
    if (chunk.trim() === '') return
    for (const line of displayText(chunk).split('\n')) {
      if (line.trim() !== '') lines.push(indent(depth) + line.trim())
    }
  })
  parser.write(text).close()

  // No elements means this was never a tree — plain text stays plain.
  return refused || elements === 0 ? undefined : lines
}

function indent(depth: number): string {
  return INDENT.repeat(Math.min(depth, MAX_DEPTH))
}
