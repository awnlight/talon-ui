import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { Transcript } from '../src/ui/transcript/transcript.ts'
import { UserMessageCell } from '../src/ui/transcript/cells.ts'

describe('performance floors (spec D7.3, D10)', () => {
  it(
    'mount-capped transcript render stays under 10ms per frame after 100k events',
    async () => {
      const t = new Transcript(createPalette(true), { mountCapLines: 5000 })
      for (let i = 0; i < 100_000; i++) {
        if (i % 2 === 0) t.apply({ kind: 'user-message', text: `message number ${i} with some typical length text` })
        else {
          t.apply({ kind: 'stream-settle', turn: i, step: 1, content: [{ type: 'text', text: `reply ${i}` }] })
          t.apply({ kind: 'turn-end', turn: i, notice: undefined })
        }
        // Yield periodically: this ingest loop is synchronous and was
        // blocking the vitest worker's event loop for the whole run
        // (~80s), starving its onTaskUpdate heartbeat and failing the
        // suite (C1). Ceding the loop every ~5k events keeps the worker
        // responsive; the trim() O(1) fix (I3) is what keeps this fast.
        if (i % 5000 === 0) await new Promise((r) => setImmediate(r))
      }
      // Steady-state frame: all cells cached; this is the per-keystroke cost shape.
      t.container.render(120) // warm
      const start = performance.now()
      for (let i = 0; i < 20; i++) t.container.render(120)
      const perFrame = (performance.now() - start) / 20
      const mountedLines = t.mountedLines(120)
      console.log(`Measured per-frame: ${perFrame.toFixed(3)}ms`)
      console.log(`Mounted lines: ${mountedLines}`)
      expect(mountedLines).toBeLessThanOrEqual(5010)
      expect(perFrame).toBeLessThan(10)
    },
    120000
  )
  it('same-width renders allocate nothing new (cache identity at scale)', () => {
    const t = new Transcript(createPalette(true), { mountCapLines: 2000 })
    for (let i = 0; i < 5_000; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    const cell = t.container.children.find(c => c instanceof UserMessageCell)!
    const a = cell.render(100)
    expect(cell.render(100)).toBe(a)
  })
})
