/** Committed transcript cells. Copy-friendly: bold+underline role headers,
 * zero gutter decoration, so drag-select copies exact message text (spec §4.1).
 * Perf law: render(width) serves a width-keyed cache; recompute only via
 * renderLines(); every mutator calls dropLines() (spec §5.1). */
import { truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui'
import type { Notice } from '../../backend/app-events.js'
import { displayText, type Palette } from '../../theme/palette.js'

export function messageHeader(label: string, color: (s: string) => string, palette: Palette): string {
  return palette.bold(palette.underline(color(displayText(label))))
}

/** Split on newlines, then wrap each logical line to the terminal width.
 * TuiMainScreen rejects any rendered row wider than the terminal, so every
 * cell body MUST pass through this before returning from render. */
export function wrapPlain(text: string, width: number): string[] {
  const safe = Math.max(1, width)
  return text.split('\n').flatMap((line) => (line === '' ? [''] : wrapTextWithAnsi(line, safe)))
}

export abstract class CachedCell implements Component {
  private cached: { width: number; lines: string[] } | undefined
  protected abstract renderLines(width: number): string[]
  protected dropLines(): void { this.cached = undefined }
  invalidate(): void { this.cached = undefined }
  render(width: number): string[] {
    if (this.cached?.width !== width) this.cached = { width, lines: this.renderLines(width) }
    return this.cached.lines
  }
}

export class UserMessageCell extends CachedCell {
  constructor(private readonly text: string, private readonly palette: Palette, private readonly label = 'You') { super() }
  /** Content-line count (header + unwrapped body lines) for the mount-cap
   * accounting — wrapping multiplies visual rows but never changes this. */
  contentLineCount(): number { return 1 + displayText(this.text).split('\n').length }
  protected renderLines(width: number): string[] {
    return [messageHeader(this.label, this.palette.text, this.palette), ...wrapPlain(displayText(this.text), width)]
  }
}

export class NoticeCell extends CachedCell {
  constructor(private readonly notice: Notice, private readonly palette: Palette) { super() }
  /** Content-line count for the mount-cap accounting. */
  contentLineCount(): number { return displayText(this.notice.text).split('\n').length }
  protected renderLines(width: number): string[] {
    const tone = this.notice.tone === 'error' ? this.palette.error : this.notice.tone === 'warning' ? this.palette.warning : this.palette.dim
    return wrapPlain(displayText(this.notice.text), width).map((row) => tone(row))
  }
}

const OUTCOME_WORDS: Record<string, string> = { 'allowed-once': 'allowed once', rejected: 'rejected', cancelled: 'cancelled', unavailable: 'unavailable' }

/** One dim audit line per approval decision (spec D9): `◆ approval · <tool> ·
 * <outcome word>`, base text dim, only the outcome word toned. Committed and
 * immutable once rendered (a CachedCell), matching every other audit/notice
 * cell in the transcript. */
export class ApprovalAuditCell extends CachedCell {
  constructor(private readonly tool: string, private readonly outcome: string, private readonly palette: Palette) { super() }
  contentLineCount(): number { return 1 }
  protected renderLines(width: number): string[] {
    const word = OUTCOME_WORDS[this.outcome] ?? this.outcome
    const tone = this.outcome === 'allowed-once' ? this.palette.success : this.outcome === 'cancelled' ? this.palette.warning : this.palette.error
    const line = `${this.palette.dim(`◆ approval · ${displayText(this.tool)} · `)}${tone(displayText(word))}`
    return [truncateToWidth(line, Math.max(1, width), '…')]
  }
}

/** One dim line per injected context message (carryover 11): `◇ context ·
 * <label>[ · <summary>] · <n> lines`. Collapsed presentation — the body stays
 * in the log and expansion arrives with T3's visibility cycling. */
export class ContextCardCell extends CachedCell {
  constructor(private readonly label: string, private readonly summary: string | undefined, private readonly lines: number, private readonly palette: Palette) { super() }
  contentLineCount(): number { return 1 }
  protected renderLines(width: number): string[] {
    const summary = this.summary === undefined ? '' : ` · ${displayText(this.summary)}`
    const line = this.palette.dim(`◇ context · ${displayText(this.label)}${summary} · ${this.lines} lines`)
    return [truncateToWidth(line, Math.max(1, width), '…')]
  }
}
