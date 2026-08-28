/** The left gutter, and the rule about what is allowed to break out of it.
 *
 * Column 0 is the most conspicuous position on the screen. Spending it on
 * everything — the banner, every role header, every card, the hint, the
 * footer — spends it on nothing: when all of it is flush left, being flush
 * left says nothing at all.
 *
 * So column 0 is reserved for the two things whose job is to DIVIDE:
 *
 *   - the composer's state rule, the one line separating the conversation
 *     from the input, which has to span the full width to divide anything; and
 *   - the `❯` prompt (and the phase glyph that replaces it), the anchor that
 *     says where the caret is.
 *
 * Everything else is content and sits in this gutter. Its width is not a
 * matter of taste: `FramelessEditor` already indents the input's continuation
 * rows by `PROMPT_WIDTH`, so matching it puts the whole UI — transcript,
 * panels, hint, footer and the text you are typing — on ONE column, with only
 * the divider and the caret breaking out to the left of it.
 *
 * The width contract is preserved exactly: the child renders `GUTTER` columns
 * narrower and every row is shifted back by the same amount, so a row that
 * filled the terminal still fills it and TuiMainScreen never sees an over-wide
 * row. A blank row stays blank rather than becoming two spaces — trailing
 * whitespace on an empty line is invisible and pollutes a drag-select.
 */
import type { Component } from '@earendil-works/pi-tui'

/** Matches `PROMPT_WIDTH` in composer.ts — see the module comment. */
export const GUTTER = 2

export class Gutter implements Component {
  private readonly pad: string

  constructor(private readonly child: Component, private readonly width: number = GUTTER) {
    this.pad = ' '.repeat(this.width)
  }

  invalidate(): void { this.child.invalidate?.() }

  render(width: number): string[] {
    return this.child
      .render(Math.max(1, width - this.width))
      .map((row) => (row === '' ? '' : this.pad + row))
  }
}
