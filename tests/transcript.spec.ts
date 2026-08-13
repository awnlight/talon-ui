import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { Transcript } from '../src/ui/transcript/transcript.ts'

const p = createPalette(false)
const render = (t: Transcript) => t.container.render(80).join('\n')

describe('Transcript', () => {
  it('appends user message, streams, settles', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'question' })
    t.apply({ kind: 'turn-start', turn: 1 })
    t.apply({ kind: 'step-start', turn: 1, step: 1 })
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'ans' })
    expect(render(t)).toContain('ans')
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'answer' }] })
    t.apply({ kind: 'turn-end', turn: 1, notice: undefined })
    const out = render(t)
    expect(out).toContain('question')
    expect(out).toContain('answer')
  })
  it('renders turn-end notices', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'turn-end', turn: 1, notice: { text: 'Turn cancelled.', tone: 'warning' } })
    expect(render(t)).toContain('Turn cancelled.')
  })
  it('second assistant/message of the same step does not re-open a settled cell', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'first' }] })
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'second' }] })
    const out = render(t)
    expect(out).toContain('first')
    expect(out).toContain('second') // becomes a NEW cell, first is preserved (replay bug fix, spec §4 archaeology)
  })
  it('head-trims past the mount cap with a marker', () => {
    const t = new Transcript(p, { mountCapLines: 50 })
    for (let i = 0; i < 40; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    const out = render(t)
    expect(out).toContain('earlier history not shown')
    expect(out).not.toContain('msg 0')
    expect(out).toContain('msg 39')
    expect(t.mountedLines(80)).toBeLessThanOrEqual(50 + 3) // cap + marker slack
  })
})
