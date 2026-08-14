/** The live streaming tail: accumulates deltas in a Map keyed by block
 * index; assistant/message settles it with authoritative content (never
 * trusting the accumulated buffer). Settled cells stay mounted (spec §5.3).
 * Perf law: once settled, content is immutable (update() is ignored — see
 * below), so render(width) serves a width-keyed cache exactly like
 * CachedCell (cells.ts); invalidate() drops it. While live, content changes
 * every chunk so render() is never cached (spec I4). */
import type { Component } from '@earendil-works/pi-tui'
import type { ContentBlockLike } from '../../backend/app-events.js'
import { displayText, type Palette } from '../../theme/palette.js'
import { messageHeader, wrapPlain } from './cells.js'

interface StreamingBlock { block: 'text' | 'reasoning'; text: string }

export class StreamingAssistantCell implements Component {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settled: ContentBlockLike[] | undefined
  private cache: { width: number; lines: string[] } | undefined
  // Mirrors renderLines().length without rendering (I3): the header line
  // plus one count per block's current text. Kept incrementally in update()
  // (cheap: proportional to the new delta only, never the whole history)
  // and recomputed exactly once from the authoritative content in settle().
  // Transcript's mount-cap trim reads this so apply() never has to render
  // the container just to count lines.
  private lines = 1

  constructor(private readonly palette: Palette) {}

  update(delta: { index: number; block: 'text' | 'reasoning'; text: string }): void {
    if (this.settled) return
    const existing = this.blocks.get(delta.index)
    const newlines = (delta.text.match(/\n/g) ?? []).length
    if (existing) {
      existing.text += delta.text
      this.lines += newlines
    } else {
      this.blocks.set(delta.index, { block: delta.block, text: delta.text })
      this.lines += newlines + 1
    }
  }

  settle(content: ContentBlockLike[]): void {
    this.settled = content
    // Content-line recount from the authoritative blocks (width-free: the
    // mount-cap accounting counts logical lines, not wrapped rows).
    this.lines = 1 + this.presentedParts().reduce((n, p) => n + p.text.split('\n').length, 0)
  }
  isSettled(): boolean { return this.settled !== undefined }

  /** Current mounted line count, kept in sync with render()'s output shape
   * without rendering (I3's O(1) mount-cap accounting). */
  lineCount(): number { return this.lines }

  invalidate(): void { this.cache = undefined }

  render(width: number): string[] {
    if (!this.settled) return this.renderLines(width)
    if (this.cache?.width !== width) this.cache = { width, lines: this.renderLines(width) }
    return this.cache.lines
  }

  private presentedParts(): { block: string; text: string }[] {
    return this.settled
      ? this.settled.filter((b) => b.type === 'text' || b.type === 'reasoning').map((b) => ({ block: b.type, text: b.text ?? '' }))
      : [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
  }

  private renderLines(width: number): string[] {
    const lines: string[] = [messageHeader('talon', this.palette.accent, this.palette)]
    for (const part of this.presentedParts()) {
      const rows = wrapPlain(displayText(part.text), width)
      if (part.block === 'reasoning') lines.push(...rows.map((l) => this.palette.dim(this.palette.italic(l))))
      else lines.push(...rows)
    }
    return lines
  }
}
