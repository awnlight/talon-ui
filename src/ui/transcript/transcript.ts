/** Ordered committed cells + the one live streaming tail. Mount cap (spec
 * D10): when total rendered lines exceed the cap, oldest cells unmount and
 * one dim marker takes their place — bounds full-redraw cost and initial
 * layout; the session log stays complete. */
import { Container, Text, type Component } from '@earendil-works/pi-tui'
import type { AppEvent } from '../../backend/app-events.js'
import type { Palette } from '../../theme/palette.js'
import { ApprovalAuditCell, ContextCardCell, NoticeCell, SpacerCell, UserMessageCell } from './cells.js'
import { StreamingAssistantCell } from './streaming.js'
import { ORPHAN_CARD_NAME, ToolCardCell, type CardVisibility } from './tool-cards.js'

const TRIM_MARKER = '… earlier history not shown …'
/** The permanent compaction bookmark (spec §4.1). The shadowed history stays
 * ABOVE it — a position marker, never an erasure — and it renders byte-identically
 * on the live and replay paths because both reach it through the same event. */
const COMPACTION_MARKER = '… earlier context was compacted …'
/** What a failed model request says in the transcript (spec §4.1). */
const RETRY_NOTICE = (e: { retry: number; limit: number | '∞'; delayMs: number; message: string }): string =>
  `Retrying model request (${e.retry}/${e.limit}) in ${e.delayMs}ms: ${e.message}`

// O(1) mount-cap accounting (I3 fix): the cap is measured in CONTENT lines
// (logical lines before width-wrapping). Cells report their own count via
// contentLineCount()/lineCount(); Spacer(1) is always one line. Wrapping
// multiplies visual rows by a modest factor at render time, so the cap
// bounds O(total) as D10 intends without trim() ever rendering anything.

export class Transcript {
  readonly container = new Container()
  private live: { key: string; cell: StreamingAssistantCell } | undefined
  private readonly cap: number
  private marker: Text | undefined
  // The running total mirrors CONTENT lines (logical, pre-wrap); visual rows may
  // exceed it by the wrap factor — bounded, by design (D10). The trim marker is
  // one content line. This accounting is maintained incrementally so apply() never
  // renders the container just to check the cap. mountedLines(width) still does a
  // real render, but only when an external caller asks for a specific width.
  private mountedLineCount = 0
  // Ctrl+R's transcript-wide reasoning visibility (spec §6). Ephemeral UI
  // state: never persisted, never logged, never part of an AppEvent (§3.10).
  private showReasoning = true
  // Ctrl+O's transcript-wide card visibility (spec §4.2), ephemeral like
  // Ctrl+R's. `headerTurn`/`headerOwner` carry the hidden-mode fold: which
  // turn has already printed an assistant header, and which cell owns it.
  private cardVisibility: CardVisibility = 'collapsed'
  private headerTurn: number | undefined
  private headerOwner: StreamingAssistantCell | undefined
  // approval-asked carries no audit text of its own — it only tells the
  // matching approval-decided which tool it was asked about (spec D9's
  // replay-safe id correlation; the pair need not be contiguous).
  private readonly askedTools = new Map<string, string>()
  // Pending tool cards by callId (ruling 5): a result settles its card in
  // place. A callId leaves the map when it settles, when its turn ends, or
  // when the mount cap evicts its card — any later result then appends an
  // orphan card rather than settling something unmounted.
  private readonly pendingCards = new Map<string, ToolCardCell>()

  constructor(private readonly palette: Palette, options?: { mountCapLines?: number }) {
    this.cap = options?.mountCapLines ?? 5000
  }

  mountedLines(width: number): number { return this.container.render(width).length }

  /** What Ctrl+R flips (read by the controller's key handler). */
  reasoningShown(): boolean { return this.showReasoning }

  /** What Ctrl+O cycles (read by the controller's key handler). */
  cardsShown(): CardVisibility { return this.cardVisibility }

  /** Ctrl+O: apply the mode to every card, then re-derive the whole layout in
   * ONE ordered pass — hidden-mode header folding, spacer suppression and the
   * mount-cap total all depend on what the cells around each cell now show. */
  setCardVisibility(mode: CardVisibility): void {
    this.cardVisibility = mode
    for (const child of this.container.children) {
      if (child instanceof ToolCardCell || child instanceof ContextCardCell) child.setVisibility(mode)
    }
    this.reflow()
  }

  private reflow(): void {
    this.headerTurn = undefined
    this.headerOwner = undefined
    this.mountedLineCount = this.marker === undefined ? 0 : 1
    let spacer: SpacerCell | undefined
    let shownSomething = false
    for (const child of this.container.children) {
      if (child === this.marker) continue
      if (child instanceof SpacerCell) { spacer = child; continue }
      if (child instanceof StreamingAssistantCell) this.applyHeader(child)
      const lines = this.lineCountOf(child)
      if (lines > 0 && !(child instanceof StreamingAssistantCell)) this.headerTurn = undefined
      // A blank row is earned only BETWEEN two visible cells: an invisible
      // cell takes its spacer with it, or hidden mode would be a blank screen.
      const keep = lines > 0 && shownSomething
      spacer?.setHidden(!keep)
      this.mountedLineCount += (keep ? 1 : 0) + lines
      shownSomething ||= lines > 0
      spacer = undefined
    }
    this.trim()
  }

  /** Hidden mode folds a multi-step turn under ONE assistant header and drops
   * a step that produced no text at all (spec §4.2, the old TUI's fold fix).
   * O(1), so the live path can call it on every delta. */
  private applyHeader(cell: StreamingAssistantCell): void {
    if (this.cardVisibility !== 'hidden') { cell.setHeaderVisible(true); return }
    if (this.headerOwner === cell) return          // already owns this turn's header
    const show = cell.hasBody() && this.headerTurn !== cell.turn
    cell.setHeaderVisible(show)
    if (show) { this.headerTurn = cell.turn; this.headerOwner = cell }
  }

  /** Propagates the toggle to every mounted streaming cell as a mutator, and
   * re-registers each cell's line-count delta — hidden reasoning rows are not
   * rendered, so mountedLineCount stays equal to the sum of the registered
   * counts and the mount cap keeps bounding (D10). */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    for (const child of this.container.children) {
      if (!(child instanceof StreamingAssistantCell)) continue
      const before = child.lineCount()
      child.setShowReasoning(show)
      this.mountedLineCount += child.lineCount() - before
    }
    this.trim() // restoring reasoning can put the transcript back over the cap
  }

  apply(event: AppEvent): void {
    switch (event.kind) {
      case 'user-message':
        { const c = new UserMessageCell(event.text, this.palette); this.appendCell(c, c.contentLineCount()) }
        break
      case 'compaction-marker':
        { const c = new NoticeCell({ text: COMPACTION_MARKER, tone: 'info' }, this.palette); this.appendCell(c, c.contentLineCount()) }
        break
      case 'compaction-live':
      case 'session-title':
        break            // controller-owned live state: never a cell
      case 'retry-notice': {
        // The request failed, so the text it had begun to deliver never
        // happened: withdraw it, then say why (spec §4.1).
        this.withdraw(`${event.turn}:${event.step}`)
        const notice = { text: RETRY_NOTICE(event), tone: 'warning' as const }
        const c = new NoticeCell(notice, this.palette)
        this.appendCell(c, c.contentLineCount())
        break
      }
      case 'context-card':
        {
          const c = new ContextCardCell(event.label, event.summary, event.text, this.palette)
          c.setVisibility(this.cardVisibility)
          this.appendCell(c, c.contentLineCount())
        }
        break
      case 'stream-delta': {
        const cell = this.cell(`${event.turn}:${event.step}`, event.turn)
        const before = cell.lineCount()
        cell.update(event)
        this.applyHeader(cell)          // content just arrived: the fold may change
        this.mountedLineCount += cell.lineCount() - before
        break
      }
      case 'stream-settle': {
        const key = `${event.turn}:${event.step}`
        const cell = this.cell(key, event.turn)
        if (cell.isSettled()) {
          // A settled cell never re-absorbs a later message (replay-parity fix): new cell.
          const fresh = new StreamingAssistantCell(this.palette, this.showReasoning, event.turn)
          fresh.settle(event.content)
          this.applyHeader(fresh)
          this.appendCell(fresh, fresh.lineCount())
          this.live = { key, cell: fresh }
        } else {
          const before = cell.lineCount()
          cell.settle(event.content)
          this.applyHeader(cell)
          this.mountedLineCount += cell.lineCount() - before
        }
        break
      }
      case 'turn-end':
        if (event.notice) {
          const c = new NoticeCell(event.notice, this.palette); this.appendCell(c, c.contentLineCount())
        }
        this.live = undefined
        this.pendingCards.clear() // a call with no result keeps its ◇ head: that is what the log says happened
        break
      case 'turn-start': case 'step-start': case 'step-end':
        break
      case 'tool-call-card': {
        const c = new ToolCardCell({ callId: event.callId, name: event.name, args: event.args, rawArguments: event.rawArguments }, this.palette)
        c.setVisibility(this.cardVisibility)
        this.appendCell(c, c.contentLineCount())
        this.pendingCards.set(event.callId, c)
        break
      }
      case 'tool-result-card': {
        const result = { isError: event.isError, errorCode: event.errorCode, resultText: event.resultText, meta: event.meta }
        const card = this.pendingCards.get(event.callId)
        if (card) {
          this.pendingCards.delete(event.callId)
          const before = card.contentLineCount()
          card.settle(result)
          this.mountedLineCount += card.contentLineCount() - before
        } else {
          // No mounted call to settle — render the result on its own settled
          // card rather than dropping it (the log is the truth).
          const orphan = new ToolCardCell({ callId: event.callId, name: ORPHAN_CARD_NAME, args: undefined, rawArguments: '' }, this.palette)
          orphan.setVisibility(this.cardVisibility)
          orphan.settle(result)
          this.appendCell(orphan, orphan.contentLineCount())
        }
        break
      }
      case 'approval-asked':
        this.askedTools.set(event.id, event.toolName)
        break
      case 'approval-decided': {
        const tool = this.askedTools.get(event.id) ?? '(unknown tool)'
        this.askedTools.delete(event.id)
        const c = new ApprovalAuditCell(tool, event.outcome, this.palette)
        this.appendCell(c, c.contentLineCount())
        break
      }
      case 'command-run': {
        const c = new NoticeCell({ text: `/${event.name}${event.args === undefined ? '' : ` ${event.args}`}`, tone: 'info' }, this.palette)
        this.appendCell(c, c.contentLineCount())
        break
      }
      case 'command-done':
        if (event.text !== undefined && event.text !== '') {
          const c = new NoticeCell({ text: event.text, tone: event.result === 'error' ? 'error' : 'info' }, this.palette)
          this.appendCell(c, c.contentLineCount())
        }
        break
      case 'notice':
        { const c = new NoticeCell(event.notice, this.palette); this.appendCell(c, c.contentLineCount()) }
        break
    }
    this.trim()
  }

  private addChild(component: Component, lines: number): void {
    this.container.addChild(component)
    this.mountedLineCount += lines
  }

  /** One rule, every call site: a new cell is preceded by a one-line spacer
   * unless it is the first child, or unless one of the two cells the spacer
   * would separate is invisible (hidden mode, spec §4.1 spacing). The spacer
   * is mounted either way — a later Ctrl+O reflow can bring it back. */
  /** The ONE sanctioned removal of a mounted component (spec §5.3): a model
   * request that failed part-way through never happened, so the partial text
   * leaves the transcript — together with the blank row that introduced it, or
   * the withdrawal would leave a gap where the text used to be. A cell that
   * already SETTLED is never withdrawn: that content is real. */
  private withdraw(key: string): void {
    if (this.live?.key !== key || this.live.cell.isSettled()) return
    const cell = this.live.cell
    const index = this.container.children.indexOf(cell)
    const spacer = index > 0 ? this.container.children[index - 1] : undefined
    this.mountedLineCount -= this.lineCountOf(cell)
    this.container.removeChild(cell)
    if (spacer instanceof SpacerCell) {
      this.mountedLineCount -= spacer.contentLineCount()
      this.container.removeChild(spacer)
    }
    this.live = undefined
    if (cell === this.headerOwner) { this.headerOwner = undefined; this.headerTurn = undefined }
  }

  private appendCell(cell: Component, lines: number): void {
    if (this.container.children.length > 0) {
      const spacer = new SpacerCell()
      spacer.setHidden(lines === 0 || this.mountedLineCount === 0)
      this.addChild(spacer, spacer.contentLineCount())
    }
    if (lines > 0 && !(cell instanceof StreamingAssistantCell)) this.headerTurn = undefined
    this.addChild(cell, lines)
  }

  private cell(key: string, turn: number): StreamingAssistantCell {
    if (this.live?.key !== key) {
      const cell = new StreamingAssistantCell(this.palette, this.showReasoning, turn)
      this.applyHeader(cell)
      this.appendCell(cell, cell.lineCount())
      this.live = { key, cell }
    }
    return this.live.cell
  }

  private trim(): void {
    while (this.container.children.length > 2 && this.mountedLineCount > this.cap) {
      const first = this.container.children.find((c) => c !== this.marker)
      /* v8 ignore next -- defensive: unreachable given the while-guard above. `this.marker` is at most one instance, so children.length > 2 always leaves at least one non-marker child for find() to return. */
      if (!first) break
      this.container.removeChild(first)
      if (first instanceof ToolCardCell) this.pendingCards.delete(first.callId)
      if (first === this.headerOwner) { this.headerOwner = undefined; this.headerTurn = undefined }
      this.mountedLineCount -= this.lineCountOf(first)
      if (!this.marker) {
        this.marker = new Text(this.palette.dim(TRIM_MARKER), 0, 0)
        this.container.children.unshift(this.marker)
        this.mountedLineCount += 1
      }
    }
  }

  private lineCountOf(c: Component): number {
    if (c instanceof StreamingAssistantCell) return c.lineCount()
    if (c instanceof ToolCardCell || c instanceof ContextCardCell) return c.contentLineCount()
    if (c instanceof UserMessageCell || c instanceof NoticeCell) return c.contentLineCount()
    if (c instanceof SpacerCell) return c.contentLineCount()
    return 1 // ApprovalAuditCell and the trim marker are one line each
  }
}
