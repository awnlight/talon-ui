/** The live streaming tail: accumulates deltas in a Map keyed by block
 * index; assistant/message settles it with authoritative content (never
 * trusting the accumulated buffer). Settled cells stay mounted (spec §5.3).
 * Text blocks render through ONE pi-tui Markdown in BOTH paths (D11): live,
 * every text delta rebuilds the joined source via setText (no throttle —
 * pi-tui's trimPartialClosingFences keeps an unclosed fence from
 * flickering); settle replaces the instance wholesale from the
 * authoritative blocks. Reasoning blocks stay plain dim+italic in both
 * paths (T3 ruling 16).
 * Perf law: once settled, content is immutable (update() is ignored — see
 * below), so render(width) serves a width-keyed cache exactly like
 * CachedCell (cells.ts); invalidate() drops it. While live, content changes
 * every chunk so render() is never cached (spec I4). */
import { Markdown, type Component } from '@earendil-works/pi-tui'
import type { ContentBlockLike } from '../../backend/app-events.js'
import { markdownTheme } from '../../theme/markdown-theme.js'
import { displayText, type Palette } from '../../theme/palette.js'
import { messageHeader, wrapPlain } from './cells.js'

interface StreamingBlock { block: 'text' | 'reasoning'; text: string }

export class StreamingAssistantCell implements Component {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settled: ContentBlockLike[] | undefined
  // The one Markdown per cell state (§5.1: never constructed inside render).
  // Live: built lazily on the first text delta, then mutated only via
  // setText. Settle: replaced by a fresh instance holding the authoritative
  // joined text blocks; its own text+width cache preserves row identity
  // beneath the cell's width-keyed cache.
  private md: Markdown | undefined
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
    // Live D11 path: every text delta rebuilds the joined source on the ONE
    // live Markdown (no throttle — the cell is uncached while live, so the
    // next render re-renders it). Reasoning deltas never touch markdown.
    if (delta.block === 'text') {
      if (this.md === undefined) this.md = new Markdown(this.textSource(), 0, 0, markdownTheme(this.palette))
      else this.md.setText(this.textSource())
    }
  }

  settle(content: ContentBlockLike[]): void {
    this.settled = content
    // Content-line recount from the authoritative blocks (width-free: the
    // mount-cap accounting counts logical SOURCE lines, not rendered rows —
    // markdown adds structural rows like fence borders by a modest bounded
    // factor at render time, exactly as wrapping does).
    this.lines = 1 + this.presentedParts().reduce((n, p) => n + p.text.split('\n').length, 0)
    // Wholesale replacement: a fresh Markdown from the authoritative blocks
    // (never trust the accumulation buffer, §5.3).
    this.md = new Markdown(this.textSource(), 0, 0, markdownTheme(this.palette))
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

  /** The one markdown source, live or settled: every text block joined
   * paragraph-separated, escaped BEFORE the parser ever sees it (D7.8
   * order). Shared by update() and settle() so both paths agree. */
  private textSource(): string {
    return displayText(this.presentedParts().filter((p) => p.block === 'text').map((p) => p.text).join('\n\n'))
  }

  private renderLines(width: number): string[] {
    const lines: string[] = [messageHeader('talon', this.palette.accent, this.palette)]
    let mdRows: string[] | undefined
    for (const part of this.presentedParts()) {
      if (part.block === 'reasoning') {
        // Reasoning stays plain dim+italic in both paths (ruling 16).
        const rows = wrapPlain(displayText(part.text), width)
        lines.push(...rows.map((l) => this.palette.dim(this.palette.italic(l))))
      } else if (mdRows === undefined) {
        // Text, live or settled: the ONE Markdown holds every text block
        // joined, emitted at the first text part's position (a text part
        // implies md exists — update()/settle() constructed it). It wraps
        // and pads its own rows to `width` — never re-wrap them
        // (width-crash law).
        mdRows = this.md!.render(width)
        lines.push(...mdRows)
      }
    }
    return lines
  }
}
