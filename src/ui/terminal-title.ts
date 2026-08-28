/** The terminal's title bar (spec §8 T4, archaeology §E1).
 *
 * A title is written straight through the `Terminal` seam as OSC 0 — it is a
 * side effect on the terminal, never a rendered row, so no cell can depend on
 * it and a snapshot observes it as a header field.
 *
 * Sanitization is not optional here. The session title is DERIVED FROM MODEL
 * OUTPUT, and a title bar interprets escape sequences exactly like the screen
 * does, so it takes the same `displayText` neutralization every rendered
 * string takes (controls and BIDI alike), then collapses to one line and gets
 * cut to a bounded length. A title bar is small; an unbounded one is a way to
 * hide the rest of it. */
import { displayText } from '../theme/palette.js'

/** What the window says with no session title to show. */
export const DEFAULT_TITLE = 'talon'
/** Titles longer than this are cut: no title bar shows more, and a long one
 * is a way to push the real title out of view. */
export const MAX_TITLE_LENGTH = 96
const ELLIPSIS = '…'

/** Neutralize, flatten and bound one untrusted title. An empty or
 * whitespace-only title answers the default rather than blanking the bar. */
export function sanitizeTitle(text: string): string {
  const flattened = displayText(text).replace(/\n+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (flattened === '') return DEFAULT_TITLE
  return flattened.length <= MAX_TITLE_LENGTH ? flattened : `${flattened.slice(0, MAX_TITLE_LENGTH - 1)}${ELLIPSIS}`
}

/** Owns the terminal's title for the life of the UI: sets it, keeps it
 * current, and puts the default back on teardown so a terminal reused after
 * talon exits does not keep advertising a session that ended. */
export class TerminalTitle {
  private shown: string | undefined

  constructor(private readonly terminal: { setTitle(title: string): void }) {}

  set(text: string): void {
    const title = sanitizeTitle(text)
    if (title === this.shown) return          // never repaint an unchanged title
    this.shown = title
    this.terminal.setTitle(title)
  }

  /** Back to the default — the teardown path, and a fresh session's reset. */
  reset(): void { this.set(DEFAULT_TITLE) }
}
