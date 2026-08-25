/** Ordered committed cells + the one live streaming tail. Mount cap (spec
 * D10): when total rendered lines exceed the cap, oldest cells unmount and
 * one dim marker takes their place — bounds full-redraw cost and initial
 * layout; the session log stays complete. */
import { Container, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import type { AppEvent } from '../../backend/app-events.js'
import type { Palette } from '../../theme/palette.js'
import { ApprovalAuditCell, ContextCardCell, NoticeCell, UserMessageCell } from './cells.js'
import { StreamingAssistantCell } from './streaming.js'
import { ORPHAN_CARD_NAME, ToolCardCell } from './tool-cards.js'

const TRIM_MARKER = '… earlier history not shown …'

// O(1) mount-cap accounting (I3 fix): the cap is measured in CONTENT lines
// (logical lines before width-wrapping). Cells report their own count via
// contentLineCount()/lineCount(); Spacer(1) is always one line. Wrapping
// multiplies visual rows by a modest factor at render time, so the cap
// bounds O(total) as D10 intends without trim() ever rendering anything.
const SPACER_LINES = 1 // Spacer(1)

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
        this.spaceBeforeNewCell()
        { const c = new UserMessageCell(event.text, this.palette); this.addChild(c, c.contentLineCount()) }
        break
      case 'context-card':
        this.spaceBeforeNewCell()
        { const c = new ContextCardCell(event.label, event.summary, event.lines, this.palette); this.addChild(c, c.contentLineCount()) }
        break
      case 'stream-delta': {
        const cell = this.cell(`${event.turn}:${event.step}`)
        const before = cell.lineCount()
        cell.update(event)
        this.mountedLineCount += cell.lineCount() - before
        break
      }
      case 'stream-settle': {
        const key = `${event.turn}:${event.step}`
        const cell = this.cell(key)
        if (cell.isSettled()) {
          // A settled cell never re-absorbs a later message (replay-parity fix): new cell.
          this.spaceBeforeNewCell()
          const fresh = new StreamingAssistantCell(this.palette, this.showReasoning)
          fresh.settle(event.content)
          this.addChild(fresh, fresh.lineCount())
          this.live = { key, cell: fresh }
        } else {
          const before = cell.lineCount()
          cell.settle(event.content)
          this.mountedLineCount += cell.lineCount() - before
        }
        break
      }
      case 'turn-end':
        if (event.notice) {
          this.spaceBeforeNewCell()
          { const c = new NoticeCell(event.notice, this.palette); this.addChild(c, c.contentLineCount()) }
        }
        this.live = undefined
        this.pendingCards.clear() // a call with no result keeps its ◇ head: that is what the log says happened
        break
      case 'turn-start': case 'step-start': case 'step-end':
        break
      case 'tool-call-card': {
        this.spaceBeforeNewCell()
        const c = new ToolCardCell({ callId: event.callId, name: event.name, args: event.args, rawArguments: event.rawArguments }, this.palette)
        this.addChild(c, c.contentLineCount())
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
          this.spaceBeforeNewCell()
          const orphan = new ToolCardCell({ callId: event.callId, name: ORPHAN_CARD_NAME, args: undefined, rawArguments: '' }, this.palette)
          orphan.settle(result)
          this.addChild(orphan, orphan.contentLineCount())
        }
        break
      }
      case 'approval-asked':
        this.askedTools.set(event.id, event.toolName)
        break
      case 'approval-decided': {
        const tool = this.askedTools.get(event.id) ?? '(unknown tool)'
        this.askedTools.delete(event.id)
        this.spaceBeforeNewCell()
        const c = new ApprovalAuditCell(tool, event.outcome, this.palette)
        this.addChild(c, c.contentLineCount())
        break
      }
      case 'command-run': {
        this.spaceBeforeNewCell()
        const c = new NoticeCell({ text: `/${event.name}${event.args === undefined ? '' : ` ${event.args}`}`, tone: 'info' }, this.palette)
        this.addChild(c, c.contentLineCount())
        break
      }
      case 'command-done':
        if (event.text !== undefined && event.text !== '') {
          this.spaceBeforeNewCell()
          const c = new NoticeCell({ text: event.text, tone: event.result === 'error' ? 'error' : 'info' }, this.palette)
          this.addChild(c, c.contentLineCount())
        }
        break
      case 'notice':
        this.spaceBeforeNewCell()
        { const c = new NoticeCell(event.notice, this.palette); this.addChild(c, c.contentLineCount()) }
        break
    }
    this.trim()
  }

  private addChild(component: Component, lines: number): void {
    this.container.addChild(component)
    this.mountedLineCount += lines
  }

  /** One rule, four former call sites: every new cell is preceded by a
   * one-line spacer unless it is the very first child (spec §4.1 spacing). */
  private spaceBeforeNewCell(): void {
    if (this.container.children.length > 0) this.addChild(new Spacer(1), SPACER_LINES)
  }

  private cell(key: string): StreamingAssistantCell {
    if (this.live?.key !== key) {
      this.spaceBeforeNewCell()
      const cell = new StreamingAssistantCell(this.palette, this.showReasoning)
      this.addChild(cell, cell.lineCount())
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
    if (c instanceof ToolCardCell) return c.contentLineCount()
    if (c instanceof UserMessageCell || c instanceof NoticeCell) return c.contentLineCount()
    return SPACER_LINES // the only remaining child type trim() ever removes
  }
}
