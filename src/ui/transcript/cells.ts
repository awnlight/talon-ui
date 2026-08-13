/** Committed transcript cells. Copy-friendly: bold+underline role headers,
 * zero gutter decoration, so drag-select copies exact message text (spec §4.1).
 * Perf law: render(width) serves a width-keyed cache; recompute only via
 * renderLines(); every mutator calls dropLines() (spec §5.1). */
import type { Component } from '@earendil-works/pi-tui'
import type { Notice } from '../../backend/app-events.ts'
import { displayText, type Palette } from '../../theme/palette.ts'

export function messageHeader(label: string, color: (s: string) => string, palette: Palette): string {
  return palette.bold(palette.underline(color(displayText(label))))
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
  protected renderLines(_width: number): string[] {
    return [messageHeader(this.label, this.palette.text, this.palette), displayText(this.text)]
  }
}

export class NoticeCell extends CachedCell {
  constructor(private readonly notice: Notice, private readonly palette: Palette) { super() }
  protected renderLines(_width: number): string[] {
    const tone = this.notice.tone === 'error' ? this.palette.error : this.notice.tone === 'warning' ? this.palette.warning : this.palette.dim
    return [tone(displayText(this.notice.text))]
  }
}
