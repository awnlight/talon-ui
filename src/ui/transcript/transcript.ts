/** Ordered committed cells + the one live streaming tail. Mount cap (spec
 * D10): when total rendered lines exceed the cap, oldest cells unmount and
 * one dim marker takes their place — bounds full-redraw cost and initial
 * layout; the session log stays complete. */
import { Container, Spacer, Text, type Component } from '@earendil-works/pi-tui'
import type { AppEvent } from '../../backend/app-events.js'
import type { Palette } from '../../theme/palette.js'
import { NoticeCell, UserMessageCell } from './cells.js'
import { StreamingAssistantCell } from './streaming.js'

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

  constructor(private readonly palette: Palette, options?: { mountCapLines?: number }) {
    this.cap = options?.mountCapLines ?? 5000
  }

  mountedLines(width: number): number { return this.container.render(width).length }

  apply(event: AppEvent): void {
    switch (event.kind) {
      case 'user-message':
        this.spaceBeforeNewCell()
        { const c = new UserMessageCell(event.text, this.palette); this.addChild(c, c.contentLineCount()) }
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
          const fresh = new StreamingAssistantCell(this.palette)
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
        break
      case 'turn-start': case 'step-start': case 'step-end':
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
      const cell = new StreamingAssistantCell(this.palette)
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
    if (c instanceof UserMessageCell || c instanceof NoticeCell) return c.contentLineCount()
    return SPACER_LINES // the only remaining child type trim() ever removes
  }
}
