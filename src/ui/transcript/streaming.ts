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
  // The reasoning share of `lines`, tracked the same incremental way, so
  // Ctrl+R's toggle costs O(1): while reasoning is hidden lineCount() simply
  // reports the difference.
  private reasoningLines = 0
  // The ONE blank row that separates a turn's reasoning from its reply (spec
  // §4.1 spacing). Reasoning and answer are different KINDS of content — one
  // is the model working, the other is the model speaking — and running them
  // together with no gap made a turn read as one undifferentiated paragraph.
  // Tracked incrementally rather than derived, because lineCount() is called
  // on every delta and the perf law (I3) makes it O(1).
  private separator = 0

  // Hidden mode folds a multi-step turn under ONE header and drops a step that
  // produced no text at all (spec §4.2, the old TUI's fold fix). The TRANSCRIPT
  // decides — the rule is about the cells AROUND this one — and sets it here.
  private headerVisible = true

  constructor(private readonly palette: Palette, private showReasoning = true, readonly turn = 0) {}

  /** Whether this cell renders any body rows at all right now (hidden
   * reasoning does not count): what makes a tool-only step render nothing. */
  hasBody(): boolean {
    return this.presentedParts().some((part) => part.block === 'text' || this.showReasoning)
  }

  /** Set by the transcript's ordered pass; ephemeral like every Ctrl+O state. */
  setHeaderVisible(show: boolean): void {
    if (this.headerVisible === show) return
    this.headerVisible = show
    this.cache = undefined
  }

  update(delta: { index: number; block: 'text' | 'reasoning'; text: string }): void {
    if (this.settled) return
    const existing = this.blocks.get(delta.index)
    const newlines = (delta.text.match(/\n/g) ?? []).length
    const added = existing ? newlines : newlines + 1
    if (existing) existing.text += delta.text
    else this.blocks.set(delta.index, { block: delta.block, text: delta.text })
    this.lines += added
    if (delta.block === 'reasoning') this.reasoningLines += added
    // Live D11 path: every text delta rebuilds the joined source on the ONE
    // live Markdown (no throttle — the cell is uncached while live, so the
    // next render re-renders it). Reasoning deltas never touch markdown.
    if (delta.block === 'text') {
      if (this.md === undefined) {
        // First text of the turn: it earns the separator only if reasoning
        // already landed above it. `reasoningLines` is updated just above.
        this.separator = this.reasoningLines > 0 ? 1 : 0
        this.md = new Markdown(this.textSource(), 0, 0, markdownTheme(this.palette))
      } else this.md.setText(this.textSource())
    }
  }

  settle(content: ContentBlockLike[]): void {
    this.settled = content
    // Content-line recount from the authoritative blocks (width-free: the
    // mount-cap accounting counts logical SOURCE lines, not rendered rows —
    // markdown adds structural rows like fence borders by a modest bounded
    // factor at render time, exactly as wrapping does).
    const parts = this.presentedParts()
    this.lines = 1 + parts.reduce((n, p) => n + p.text.split('\n').length, 0)
    this.reasoningLines = parts.reduce((n, p) => (p.block === 'reasoning' ? n + p.text.split('\n').length : n), 0)
    // Order matters, not mere presence: reasoning AFTER the reply separates
    // nothing, so only reasoning that precedes the first text block counts.
    const firstText = parts.findIndex((part) => part.block === 'text')
    this.separator = firstText > 0 && parts.slice(0, firstText).some((part) => part.block === 'reasoning') ? 1 : 0
    // Wholesale replacement: a fresh Markdown from the authoritative blocks
    // (never trust the accumulation buffer, §5.3).
    this.md = new Markdown(this.textSource(), 0, 0, markdownTheme(this.palette))
  }
  isSettled(): boolean { return this.settled !== undefined }

  /** Current mounted line count, kept in sync with render()'s output shape
   * without rendering (I3's O(1) mount-cap accounting) — hidden reasoning is
   * not rendered, so it does not count. */
  lineCount(): number {
    const body = (this.showReasoning ? this.lines + this.separator : this.lines - this.reasoningLines) - 1
    return body + (this.headerVisible ? 1 : 0)
  }

  /** Ctrl+R's transcript-wide toggle, applied as a MUTATOR rather than a
   * render argument: the flag flips, the width cache goes, and lineCount()
   * re-derives so the transcript can re-register the delta. Ephemeral UI
   * state — never persisted, never logged (spec §3.10). */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.cache = undefined
  }

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
    const lines: string[] = this.headerVisible ? [messageHeader('talon', this.palette.accent, this.palette)] : []
    let mdRows: string[] | undefined
    for (const part of this.presentedParts()) {
      if (part.block === 'reasoning') {
        if (!this.showReasoning) continue // Ctrl+R hides reasoning transcript-wide
        // Reasoning stays plain dim+italic in both paths (ruling 16).
        const rows = wrapPlain(displayText(part.text), width)
        lines.push(...rows.map((l) => this.palette.dim(this.palette.italic(l))))
      } else if (mdRows === undefined) {
        // The separator: emitted only when reasoning actually rendered above
        // this block, so Ctrl+R hiding reasoning takes the blank row with it.
        if (lines.length > (this.headerVisible ? 1 : 0)) lines.push('')
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
