/** Ordered committed cells + the one live streaming tail. Mount cap (spec
 * D10): when total rendered lines exceed the cap, oldest cells unmount and
 * one dim marker takes their place — bounds full-redraw cost and initial
 * layout; the session log stays complete. */
import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { AppEvent } from '../../backend/app-events.ts'
import type { Palette } from '../../theme/palette.ts'
import { NoticeCell, UserMessageCell } from './cells.js'
import { StreamingAssistantCell } from './streaming.js'

const TRIM_MARKER = '… earlier history not shown …'

export class Transcript {
  readonly container = new Container()
  private live: { key: string; cell: StreamingAssistantCell } | undefined
  private readonly cap: number
  private marker: Text | undefined

  constructor(private readonly palette: Palette, options?: { mountCapLines?: number }) {
    this.cap = options?.mountCapLines ?? 5000
  }

  mountedLines(width: number): number { return this.container.render(width).length }

  apply(event: AppEvent): void {
    switch (event.kind) {
      case 'user-message':
        if (this.container.children.length > 0) this.container.addChild(new Spacer(1))
        this.container.addChild(new UserMessageCell(event.text, this.palette))
        break
      case 'stream-delta': {
        this.cell(`${event.turn}:${event.step}`).update(event)
        break
      }
      case 'stream-settle': {
        const key = `${event.turn}:${event.step}`
        const cell = this.cell(key)
        if (cell.isSettled()) {
          // A settled cell never re-absorbs a later message (replay-parity fix): new cell.
          if (this.container.children.length > 0) this.container.addChild(new Spacer(1))
          const fresh = new StreamingAssistantCell(this.palette)
          fresh.settle(event.content)
          this.container.addChild(fresh)
          this.live = { key, cell: fresh }
        } else {
          cell.settle(event.content)
        }
        break
      }
      case 'turn-end':
        if (event.notice) {
          if (this.container.children.length > 0) this.container.addChild(new Spacer(1))
          this.container.addChild(new NoticeCell(event.notice, this.palette))
        }
        this.live = undefined
        break
      case 'turn-start': case 'step-start': case 'step-end':
        break
    }
    this.trim()
  }

  private cell(key: string): StreamingAssistantCell {
    if (this.live?.key !== key) {
      if (this.container.children.length > 0) this.container.addChild(new Spacer(1))
      const cell = new StreamingAssistantCell(this.palette)
      this.container.addChild(cell)
      this.live = { key, cell }
    }
    return this.live.cell
  }

  private trim(): void {
    // Cheap check first: count only when children are numerous.
    const width = 200 // conservative width for line counting; cached renders make this cheap
    while (this.container.children.length > 2 && this.mountedLines(width) > this.cap) {
      const first = this.container.children.find((c) => c !== this.marker)
      if (!first) break
      this.container.removeChild(first)
      if (!this.marker) {
        this.marker = new Text(this.palette.dim(TRIM_MARKER), 0, 0)
        this.container.children.unshift(this.marker)
      }
    }
  }
}
