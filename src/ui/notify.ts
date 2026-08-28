/** Desktop notification on turn end (spec §8 T4, archaeology §E1).
 *
 * OSC 9 straight through the `Terminal` seam — a side effect, like the title,
 * never a rendered row. The text is sanitized for the same reason the title is:
 * it names the session, and that name came from the model.
 *
 * The one rule that makes this bearable rather than annoying is **notify only
 * while the terminal is UNFOCUSED**. pi-tui tracks no focus, so talon asks for
 * it: DEC 1004 on at start, `\x1b[I` / `\x1b[O` read off the input stream the
 * controller already listens to, DEC 1004 off at teardown.
 *
 * A terminal that ignores 1004 sends neither event, and talon then treats
 * itself as UNFOCUSED — notifying is the safe failure, since a redundant
 * notification is a smaller harm than a missed one. The first focus-in ever
 * received switches to real tracking and never goes back to guessing. */
import { displayText } from '../theme/palette.js'

/** DEC 1004: report focus in (`CSI I`) and focus out (`CSI O`). */
export const FOCUS_REPORTING_ON = '\x1b[?1004h'
export const FOCUS_REPORTING_OFF = '\x1b[?1004l'
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'
/** A notification line is short by nature; bound it like the title. */
const MAX_NOTIFICATION_LENGTH = 120

/** Whether one chunk of input is a focus report, and which way. */
export function focusReport(data: string): 'in' | 'out' | undefined {
  if (data === FOCUS_IN) return 'in'
  if (data === FOCUS_OUT) return 'out'
  return undefined
}

export class Notifier {
  /** Unfocused until told otherwise — see the module comment. */
  private focused = false
  private enabled = true

  constructor(private readonly terminal: { write(data: string): void }) {}

  /** Ask the terminal to report focus. Silent on terminals that ignore it. */
  start(): void { this.terminal.write(FOCUS_REPORTING_ON) }
  /** Stop asking — a terminal reused after talon exits must not keep sending. */
  stop(): void { this.terminal.write(FOCUS_REPORTING_OFF) }

  /** Feed one input chunk; answers whether it WAS a focus report (and was
   * therefore consumed rather than passed to the editor). */
  observe(data: string): boolean {
    const report = focusReport(data)
    if (report === undefined) return false
    this.focused = report === 'in'
    return true
  }

  /** The persisted preference (Task 9 wires it). */
  setEnabled(enabled: boolean): void { this.enabled = enabled }

  /** Notify unless the user is already looking at the terminal. */
  notify(text: string): void {
    if (!this.enabled || this.focused) return
    const message = displayText(text).replace(/\s+/gu, ' ').trim().slice(0, MAX_NOTIFICATION_LENGTH)
    if (message === '') return
    this.terminal.write(`\x1b]9;${message}\x07`)
  }
}
