/** The live streaming tail: accumulates deltas in a Map keyed by block
 * index; assistant/message settles it with authoritative content (never
 * trusting the accumulated buffer). Settled cells stay mounted (spec §5.3). */
import type { Component } from '@earendil-works/pi-tui'
import type { ContentBlockLike } from '../../backend/app-events.ts'
import { displayText, type Palette } from '../../theme/palette.js'
import { messageHeader } from './cells.js'

interface StreamingBlock { block: 'text' | 'reasoning'; text: string }

export class StreamingAssistantCell implements Component {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settled: ContentBlockLike[] | undefined

  constructor(private readonly palette: Palette) {}

  update(delta: { index: number; block: 'text' | 'reasoning'; text: string }): void {
    if (this.settled) return
    const existing = this.blocks.get(delta.index)
    if (existing) existing.text += delta.text
    else this.blocks.set(delta.index, { block: delta.block, text: delta.text })
  }

  settle(content: ContentBlockLike[]): void { this.settled = content }
  isSettled(): boolean { return this.settled !== undefined }

  invalidate(): void {}

  render(_width: number): string[] {
    const lines: string[] = [messageHeader('talon', this.palette.accent, this.palette)]
    const parts: { block: string; text: string }[] = this.settled
      ? this.settled.filter((b) => b.type === 'text' || b.type === 'reasoning').map((b) => ({ block: b.type, text: b.text ?? '' }))
      : [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
    for (const part of parts) {
      const body = displayText(part.text)
      if (part.block === 'reasoning') lines.push(...body.split('\n').map((l) => this.palette.dim(this.palette.italic(l))))
      else lines.push(...body.split('\n'))
    }
    return lines
  }
}
