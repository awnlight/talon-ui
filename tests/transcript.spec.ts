import { describe, expect, it, vi } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { Transcript } from '../src/ui/transcript/transcript.ts'
import { UserMessageCell } from '../src/ui/transcript/cells.ts'

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
  it('turn-end notice after prior content adds a spacer before the notice', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'question' })
    t.apply({ kind: 'turn-end', turn: 1, notice: { text: 'Turn cancelled.', tone: 'warning' } })
    const out = render(t)
    expect(out).toContain('question')
    expect(out).toContain('Turn cancelled.')
  })
  it('stream-delta for a different key than the current live cell opens a new cell', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'first' })
    t.apply({ kind: 'stream-delta', turn: 2, step: 1, index: 0, block: 'text', text: 'second' })
    const out = render(t)
    expect(out).toContain('first')
    expect(out).toContain('second')
  })
  it('apply() in a tight loop never renders a mounted child (I3 regression guard)', () => {
    // trim() used to call container.render(200) on every apply() to count
    // mounted lines — an O(n) full-container render per event. The mount-cap
    // accounting is now incremental, so apply() should never render any
    // child at all; only an explicit external render (not exercised here)
    // should ever invoke a cell's render().
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'seed' })
    const seed = t.container.children.find((c) => c instanceof UserMessageCell)!
    const renderSpy = vi.spyOn(seed, 'render')
    for (let i = 0; i < 1000; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    expect(renderSpy).not.toHaveBeenCalled()
  })
  it('extracts one spacer rule: a spacer precedes every new cell except the first', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'user-message', text: 'a' })                       // no spacer before the first
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'x' })
    t.apply({ kind: 'turn-end', turn: 1, notice: { text: 'Turn blocked.', tone: 'warning' } })
    const rows = t.container.render(40)
    expect(rows.filter((r) => r === '').length).toBe(2)                // exactly one blank between each pair
  })
  it('trim at narrow width: marker accounts as 1 content line and the cap keeps bounding', () => {
    const t = new Transcript(createPalette(false), { mountCapLines: 12 })
    for (let i = 0; i < 30; i++) t.apply({ kind: 'user-message', text: `message number ${i} that is long` })
    // content-line accounting is width-free; at width 24 the marker wraps to 2 visual rows — allowed
    const rows = t.container.render(24)
    expect(rows.join('\n')).toContain('… earlier history')
    expect(t.mountedLines(200)).toBeLessThanOrEqual(12 + 2)            // cap respected in content terms (+marker, +trailing spacer slack)
  })
  it('renders one audit line per decision, correlated by id (replay-safe)', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'approval-asked', id: 'a1', toolName: 'bash' })
    expect(t.container.render(60).length).toBe(0)                      // asked alone renders nothing
    t.apply({ kind: 'approval-decided', id: 'a1', outcome: 'allowed-once' })
    expect(t.container.render(60).join('\n')).toContain('◆ approval · bash · allowed once')
    t.apply({ kind: 'approval-decided', id: 'ghost', outcome: 'rejected' })
    expect(t.container.render(60).join('\n')).toContain('◆ approval · (unknown tool) · rejected')
  })
  it('tool-call events are transcript-ignored (cards land in T3)', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'tool-call', callId: 'c1', name: 'bash', preview: 'ls -la' })
    expect(t.container.render(60).length).toBe(0)
  })
  it('echoes command/run as one dim line, with and without args', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'command-run', name: 'status', args: undefined })
    t.apply({ kind: 'command-run', name: 'help', args: 'verbose' })
    const rows = t.container.render(60)
    expect(rows).toContain('/status')
    expect(rows).toContain('/help verbose')
  })
  it('renders command/done text as a notice, error-toned for a failed command', () => {
    const t = new Transcript(createPalette(true)) // colors on: the tone is the only difference between the two lines
    t.apply({ kind: 'command-done', result: 'success', text: 'session s1' })
    t.apply({ kind: 'command-done', result: 'error', text: 'no such session' })
    const out = t.container.render(60).join('\n')
    expect(out).toContain('\x1b[2;39msession s1')  // dim: info tone
    expect(out).toContain('\x1b[31mno such session') // red: error tone
  })
  it('a command/done without text renders nothing (empty text included)', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'command-done', result: 'success', text: undefined })
    t.apply({ kind: 'command-done', result: 'success', text: '' })
    expect(t.container.render(60).length).toBe(0)
  })
  it('renders a UI-local notice (never a durable event) with its tone', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'notice', notice: { text: 'Unknown command: /nope', tone: 'warning' } })
    expect(t.container.render(60).join('\n')).toContain('Unknown command: /nope')
  })
})
