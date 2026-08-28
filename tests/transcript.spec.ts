import { describe, expect, it, vi } from 'vitest'
import type { AppEvent } from '../src/backend/app-events.ts'
import { createPalette } from '../src/theme/palette.ts'
import { Transcript } from '../src/ui/transcript/transcript.ts'
import { UserMessageCell } from '../src/ui/transcript/cells.ts'
import { StreamingAssistantCell } from '../src/ui/transcript/streaming.ts'
import { ToolCardCell } from '../src/ui/transcript/tool-cards.ts'

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

describe('Transcript tool cards (keyed by callId, ruling 5)', () => {
  const cards = (t: Transcript): ToolCardCell[] => t.container.children.filter((c) => c instanceof ToolCardCell)
  const accounted = (t: Transcript): number => (t as unknown as { mountedLineCount: number }).mountedLineCount
  const registered = (t: Transcript): number => t.container.children.reduce(
    (n, c) => n + (c instanceof ToolCardCell || c instanceof UserMessageCell ? c.contentLineCount() : 1), 0)
  const call = (callId: string, name: string, args: unknown): AppEvent =>
    ({ kind: 'tool-call-card', turn: 1, step: 1, callId, name, args, rawArguments: JSON.stringify(args) })
  const result = (callId: string, over: Partial<Extract<AppEvent, { kind: 'tool-result-card' }>> = {}): AppEvent =>
    ({ kind: 'tool-result-card', callId, isError: false, errorCode: undefined, resultText: 'out', meta: undefined, ...over })

  it('appends a pending card on the call and settles the SAME cell in place on the result', () => {
    const t = new Transcript(p)
    t.apply(call('c1', 'bash', { command: 'pnpm test' }))
    const cell = cards(t)[0]!
    expect(render(t)).toContain('◇ bash · pnpm test')

    t.apply(result('c1', { resultText: '12 passed' }))
    expect(cards(t)).toEqual([cell])                       // mutated in place — no second card
    expect(render(t)).toContain('◆ bash · pnpm test')
    expect(render(t)).toContain('12 passed')
  })

  it('appends an already-settled orphan card for an unknown callId (the log is the truth)', () => {
    const t = new Transcript(p)
    t.apply(result('ghost', { resultText: 'late output', isError: true, errorCode: 'timeout' }))
    expect(cards(t).length).toBe(1)
    expect(render(t)).toContain('◆ tool')
    expect(render(t)).toContain('late output')
    expect(accounted(t)).toBe(registered(t))
  })

  it('leaves a call with no result on its ◇ head, and turn-end drops the pending reference', () => {
    const t = new Transcript(p)
    t.apply(call('c1', 'bash', { command: 'sleep 99' }))
    t.apply({ kind: 'turn-end', turn: 1, notice: undefined })
    expect(render(t)).toContain('◇ bash · sleep 99')       // still running, per the log

    t.apply(result('c1', { resultText: 'too late' }))      // the reference is gone: an orphan, not a settle
    expect(cards(t).length).toBe(2)
    expect(render(t)).toContain('◇ bash · sleep 99')
    expect(render(t)).toContain('too late')
  })

  it('keeps the mount-cap accounting honest across call → settle', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'go' })
    t.apply(call('c1', 'bash', { command: 'ls' }))
    expect(accounted(t)).toBe(registered(t))
    t.apply(result('c1', { resultText: 'a\nb\nc' }))
    expect(accounted(t)).toBe(registered(t))
    expect(accounted(t)).toBe(2 + 1 + 6)                   // user cell + spacer + (head + cwd + $ command + 3 output lines)
  })

  it('forgets a pending card the mount cap evicted, so its late result lands as an orphan', () => {
    const t = new Transcript(p, { mountCapLines: 12 })
    t.apply(call('c1', 'bash', { command: 'ls' }))
    for (let i = 0; i < 10; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    expect(cards(t).length).toBe(0)                        // trimmed away
    t.apply(result('c1', { resultText: 'orphaned' }))
    expect(cards(t).length).toBe(1)
    expect(render(t)).toContain('orphaned')
    expect(accounted(t)).toBe(registered(t))
  })
})

describe('Transcript reasoning visibility (Ctrl+R, spec §6)', () => {
  // mountedLineCount is maintained incrementally; the invariant it must always
  // satisfy is "equal to the sum of what every mounted child registered"
  // (Spacer and the trim marker are one content line each).
  const registered = (t: Transcript): number =>
    t.container.children.reduce((n, c) => n + (c instanceof StreamingAssistantCell ? c.lineCount() : 1), 0)
  const accounted = (t: Transcript): number => (t as unknown as { mountedLineCount: number }).mountedLineCount

  const withReasoning = (t: Transcript): void => {
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'reasoning', text: 'why a\nwhy b' }, { type: 'text', text: 'settled answer' }] })
    t.apply({ kind: 'stream-delta', turn: 2, step: 1, index: 0, block: 'reasoning', text: 'still thinking' })
    t.apply({ kind: 'stream-delta', turn: 2, step: 1, index: 1, block: 'text', text: 'live answer' })
  }

  it('hides reasoning in settled AND live cells, then restores the identical rows', () => {
    const t = new Transcript(p)
    withReasoning(t)
    const shown = render(t)
    const shownRows = t.mountedLines(80)

    t.setShowReasoning(false)
    const hidden = render(t)
    expect(hidden).not.toContain('why a')
    expect(hidden).not.toContain('still thinking')
    expect(hidden).toContain('settled answer')          // both cells keep their text
    expect(hidden).toContain('live answer')
    expect(t.mountedLines(80)).toBe(shownRows - 3)      // 2 settled reasoning rows + 1 live one

    t.setShowReasoning(true)
    expect(render(t)).toBe(shown)
    expect(t.mountedLines(80)).toBe(shownRows)
  })

  it('keeps the mount-cap accounting honest across toggles', () => {
    const t = new Transcript(p)
    withReasoning(t)
    const before = accounted(t)
    expect(before).toBe(registered(t))

    t.setShowReasoning(false)
    expect(accounted(t)).toBe(before - 3)
    expect(accounted(t)).toBe(registered(t))

    t.setShowReasoning(true)
    expect(accounted(t)).toBe(before)
    expect(accounted(t)).toBe(registered(t))
  })

  it('cells opened while reasoning is hidden inherit the state', () => {
    const t = new Transcript(p)
    t.setShowReasoning(false)
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'reasoning', text: 'live thought' })
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'reasoning', text: 'first thought' }, { type: 'text', text: 'first' }] })
    // a second settle of the same key opens a FRESH cell — it inherits too
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'reasoning', text: 'second thought' }, { type: 'text', text: 'second' }] })
    const out = render(t)
    expect(out).not.toContain('thought')
    expect(out).toContain('first')
    expect(out).toContain('second')
  })

  it('restoring reasoning re-trims when the cap is exceeded again', () => {
    const t = new Transcript(p, { mountCapLines: 12 })
    t.setShowReasoning(false)
    for (let i = 0; i < 3; i++) {
      t.apply({ kind: 'stream-settle', turn: i + 1, step: 1, content: [{ type: 'reasoning', text: `r${i}a\nr${i}b\nr${i}c` }, { type: 'text', text: `answer ${i}` }] })
    }
    expect(accounted(t)).toBe(8)                        // 3 × (header + text line) + 2 spacers: under the cap
    expect(render(t)).toContain('answer 0')

    t.setShowReasoning(true)                            // 17 content lines: back over the cap
    expect(render(t)).toContain('earlier history not shown')
    expect(render(t)).not.toContain('answer 0')
    expect(accounted(t)).toBeLessThanOrEqual(12)
    expect(accounted(t)).toBe(registered(t))
  })
})

describe('Transcript Ctrl+O card visibility (spec §4.2, ephemeral per §3.10)', () => {
  const accounted = (t: Transcript): number => (t as unknown as { mountedLineCount: number }).mountedLineCount
  const rows = (t: Transcript): string[] => t.container.render(80)
  const call = (callId: string, name: string, args: unknown): AppEvent =>
    ({ kind: 'tool-call-card', turn: 1, step: 1, callId, name, args, rawArguments: JSON.stringify(args) })
  const result = (callId: string, over: Partial<Extract<AppEvent, { kind: 'tool-result-card' }>> = {}): AppEvent =>
    ({ kind: 'tool-result-card', callId, isError: false, errorCode: undefined, resultText: 'out', meta: undefined, ...over })

  /** A turn whose steps interleave text and a tool call — the shape the
   * hidden-mode fold exists for. */
  const codingTurn = (t: Transcript): void => {
    t.apply({ kind: 'user-message', text: 'go' })
    t.apply({ kind: 'turn-start', turn: 1 })
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'Looking at the file.' }] })
    t.apply(call('c1', 'mcp__x', { q: 'a' }))
    t.apply(result('c1', { resultText: 'a\nb\nc' }))
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'Done — renamed.' }] })
  }

  it('starts collapsed and reports the mode the controller cycles', () => {
    const t = new Transcript(p)
    expect(t.cardsShown()).toBe('collapsed')
    t.setCardVisibility('expanded')
    expect(t.cardsShown()).toBe('expanded')
  })

  it('hides every card AND the blank row it brought with it', () => {
    const t = new Transcript(p)
    codingTurn(t)
    t.setCardVisibility('hidden')
    const out = rows(t)
    expect(out.join('\n')).not.toContain('mcp__x')
    expect(out.some((row, i) => row === '' && out[i + 1] === '')).toBe(false)  // no run of orphaned spacers
    expect(accounted(t)).toBe(out.length)
  })

  it('folds a multi-step turn under ONE assistant header in hidden mode, and restores both on the way back', () => {
    const t = new Transcript(p)
    codingTurn(t)
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(2)

    t.setCardVisibility('hidden')
    const folded = rows(t)
    expect(folded.filter((row) => row.includes('talon')).length).toBe(1)
    expect(folded.join('\n')).toContain('Looking at the file.')
    expect(folded.join('\n')).toContain('Done — renamed.')

    t.setCardVisibility('collapsed')
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(2)
  })

  it('renders a tool-only step as nothing at all in hidden mode', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'turn-start', turn: 1 })
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'tool-call', text: undefined }] })
    t.apply(call('c1', 'mcp__x', { q: 'a' }))
    t.apply(result('c1'))
    t.setCardVisibility('hidden')
    expect(rows(t)).toEqual([])
    expect(accounted(t)).toBe(0)

    // …and the NEXT step of that turn still gets its header: nothing printed one.
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'Done.' }] })
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(1)
  })

  it('a visible cell between two steps ends the fold run — the header comes back', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'first' }] })
    t.apply({ kind: 'notice', notice: { text: 'Turn cancelled.', tone: 'warning' } })
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'second' }] })
    t.setCardVisibility('hidden')
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(2)
  })

  it('a failed card stays visible in hidden mode and ends the fold run', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'first' }] })
    t.apply(call('c1', 'mcp__x', { q: 'a' }))
    t.apply(result('c1', { isError: true, errorCode: 'boom', resultText: 'it failed' }))
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'second' }] })
    t.setCardVisibility('hidden')
    const out = rows(t).join('\n')
    expect(out).toContain('it failed')
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(2)
  })

  it('cards appended while hidden come in hidden, and adopt the mode when it changes', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'go' })
    t.setCardVisibility('hidden')
    t.apply(call('c1', 'mcp__x', { q: 'a' }))
    t.apply(result('c1'))
    expect(rows(t).join('\n')).not.toContain('mcp__x')
    expect(accounted(t)).toBe(rows(t).length)

    t.setCardVisibility('expanded')
    expect(rows(t).join('\n')).toContain('mcp__x')
    expect(accounted(t)).toBe(rows(t).length)
  })

  it('carries context cards through the cycle (T2 carryover 11)', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'context-card', label: 'skill-catalog', summary: undefined, text: 'writing-plans\nexecuting-plans' })
    expect(rows(t)).toEqual(['◇ context · skill-catalog · 2 lines'])
    t.setCardVisibility('expanded')
    expect(rows(t)).toEqual(['◇ context · skill-catalog · 2 lines', 'writing-plans', 'executing-plans'])
    t.setCardVisibility('hidden')
    expect(rows(t)).toEqual([])
  })

  it('keeps the mount-cap accounting exact through every mode, and keeps trimming', () => {
    const t = new Transcript(p)
    codingTurn(t)
    for (const mode of ['expanded', 'hidden', 'collapsed'] as const) {
      t.setCardVisibility(mode)
      expect(accounted(t), mode).toBe(rows(t).length)
    }
    const capped = new Transcript(p, { mountCapLines: 12 })
    for (let i = 0; i < 10; i++) capped.apply({ kind: 'user-message', text: `msg ${i}` })
    capped.setCardVisibility('expanded')
    expect(accounted(capped)).toBeLessThanOrEqual(12 + 2)
    expect(rows(capped)[0]).toContain('earlier history not shown')
  })
})

describe('Transcript Ctrl+O, the remaining shapes', () => {
  const accounted = (t: Transcript): number => (t as unknown as { mountedLineCount: number }).mountedLineCount
  const rows = (t: Transcript): string[] => t.container.render(80)

  it('counts an approval audit line through a reflow', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'approval-asked', id: 'a1', toolName: 'bash' })
    t.apply({ kind: 'approval-decided', id: 'a1', outcome: 'allowed-once' })
    t.setCardVisibility('hidden')
    expect(rows(t)).toEqual(['◆ approval · bash · allowed once'])
    expect(accounted(t)).toBe(1)
  })

  it('re-deciding the header on every delta leaves the owning cell alone', () => {
    const t = new Transcript(p)
    t.setCardVisibility('hidden')
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'one ' })
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'two' })
    const out = rows(t)
    expect(out.filter((row) => row.includes('talon')).length).toBe(1)   // not dropped by its own re-check
    expect(out.join('\n')).toContain('one two')
    expect(accounted(t)).toBe(out.length)
  })

  it('forgets the header owner the mount cap evicted, so the next step prints one', () => {
    const t = new Transcript(p, { mountCapLines: 8 })
    t.setCardVisibility('hidden')
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'first' }] })
    for (let i = 0; i < 6; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    expect(rows(t).join('\n')).not.toContain('first')                 // the owner is gone
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'second' }] })
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(1)
  })

  it('a reasoning-only step counts as body while Ctrl+R shows reasoning, and stops when it does not', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'reasoning', text: 'weighing it' }] })
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'answer' }] })
    t.setCardVisibility('hidden')
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(1)   // step 1 owns the header
    expect(rows(t).join('\n')).toContain('weighing it')

    t.setShowReasoning(false)
    t.setCardVisibility('hidden')                                           // re-derive with reasoning gone
    const out = rows(t)
    expect(out.join('\n')).not.toContain('weighing it')
    expect(out.filter((row) => row.includes('talon')).length).toBe(1)       // now step 2 owns it
    expect(accounted(t)).toBe(out.length)
  })
})

describe('Transcript compaction marker (spec §4.1)', () => {
  it('renders one permanent dim bookmark, leaving the shadowed history above it', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'earlier question' })
    t.apply({ kind: 'compaction-marker' })
    t.apply({ kind: 'user-message', text: 'later question' })
    const out = t.container.render(80)
    expect(out).toContain('… earlier context was compacted …')
    expect(out.join('\n')).toContain('earlier question')          // a bookmark, never an erasure
    expect(out.indexOf('… earlier context was compacted …')).toBeGreaterThan(out.indexOf('earlier question'))
  })
  it('renders the marker identically whether the event arrives live or on replay', () => {
    const live = new Transcript(p)
    const replay = new Transcript(p)
    for (const t of [live, replay]) t.apply({ kind: 'compaction-marker' })
    expect(live.container.render(80)).toEqual(replay.container.render(80))
  })
  it('never renders anything for the live indicator', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'compaction-live', phase: 'start' })
    t.apply({ kind: 'compaction-live', phase: 'end' })
    expect(t.container.render(80)).toEqual([])
  })
})

describe('Transcript retry withdrawal (spec §4.1/§5.3, ruling 8)', () => {
  const accounted = (t: Transcript): number => (t as unknown as { mountedLineCount: number }).mountedLineCount
  const rows = (t: Transcript): string[] => t.container.render(80)
  const retry = (over: Partial<Extract<AppEvent, { kind: 'retry-notice' }>> = {}): AppEvent =>
    ({ kind: 'retry-notice', turn: 1, step: 1, retry: 2, limit: 5, delayMs: 750, message: 'connection reset', ...over })

  it('takes the partial stream away — with its blank row — and says why', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'go' })
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'half an ans' })
    expect(rows(t).join('\n')).toContain('half an ans')

    t.apply(retry())
    const out = rows(t)
    expect(out.join('\n')).not.toContain('half an ans')
    expect(out.join('\n')).not.toContain('talon')
    expect(out).toContain('Retrying model request (2/5) in 750ms: connection reset')
    expect(out.some((row, i) => row === '' && out[i + 1] === '')).toBe(false)   // no gap where the text was
    expect(accounted(t)).toBe(out.length)
  })

  it('re-streams into a clean cell, so the recovered turn shows exactly one message', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'half an ans' })
    t.apply(retry())
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'the whole answer' }] })
    const out = rows(t)
    expect(out.filter((row) => row.includes('talon')).length).toBe(1)
    expect(out.join('\n')).toContain('the whole answer')
    expect(accounted(t)).toBe(out.length)
  })

  it('never withdraws a SETTLED cell, nor another step, nor when nothing is live', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'real content' }] })
    t.apply(retry())                                     // settled: that content is real
    expect(rows(t).join('\n')).toContain('real content')

    const other = new Transcript(p)
    other.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'step one' })
    other.apply(retry({ step: 2 }))                      // a different step's failure
    expect(rows(other).join('\n')).toContain('step one')

    const empty = new Transcript(p)
    empty.apply(retry())                                 // nothing live at all
    expect(rows(empty)).toEqual(['Retrying model request (2/5) in 750ms: connection reset'])
    expect(accounted(empty)).toBe(1)
  })

  it('withdraws the FIRST cell cleanly, with no spacer to take with it', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'half' })
    t.apply(retry())
    expect(rows(t)).toEqual(['Retrying model request (2/5) in 750ms: connection reset'])
    expect(accounted(t)).toBe(1)
  })

  it('forgets a withdrawn header owner, so the next step of the turn prints one', () => {
    const t = new Transcript(p)
    t.setCardVisibility('hidden')
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'half' })
    t.apply(retry())
    t.apply({ kind: 'stream-settle', turn: 1, step: 2, content: [{ type: 'text', text: 'recovered' }] })
    expect(rows(t).filter((row) => row.includes('talon')).length).toBe(1)
  })
})

describe('Transcript workflow cards (spec §3.9)', () => {
  const accounted = (t: Transcript): number => (t as unknown as { mountedLineCount: number }).mountedLineCount
  const rows = (t: Transcript): string[] => t.container.render(80)

  it('opens a card per run and mutates it in place through the record', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'workflow-run-start', runId: 'r1', name: 'review-changes' })
    t.apply({ kind: 'workflow-agent-start', runId: 'r1', seq: 1, label: 'review:bugs', phase: 'Review' })
    t.apply({ kind: 'workflow-agent-end', runId: 'r1', seq: 1, outcome: 'completed' })
    t.apply({ kind: 'workflow-run-end', runId: 'r1', stopReason: 'completed' })
    expect(rows(t)).toEqual([
      '◆ workflow · review-changes',
      '  ◆ review:bugs · Review · completed',
      '└ 1 member · completed',
    ])
    expect(accounted(t)).toBe(rows(t).length)
  })

  it('keeps two concurrent runs apart', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'workflow-run-start', runId: 'r1', name: 'first' })
    t.apply({ kind: 'workflow-run-start', runId: 'r2', name: 'second' })
    t.apply({ kind: 'workflow-agent-start', runId: 'r2', seq: 1, label: 'only in second', phase: undefined })
    const out = rows(t).join('\n')
    expect(out).toContain('◇ workflow · first')
    expect(out).toContain('only in second')
    expect(rows(t).filter((row) => row.includes('only in second'))).toHaveLength(1)
    expect(accounted(t)).toBe(rows(t).length)
  })

  it('drops a record whose run-start never landed — the run is not on screen either', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'workflow-agent-start', runId: 'gone', seq: 1, label: 'x', phase: undefined })
    t.apply({ kind: 'workflow-agent-end', runId: 'gone', seq: 1, outcome: 'completed' })
    t.apply({ kind: 'workflow-run-end', runId: 'gone', stopReason: 'completed' })
    expect(rows(t)).toEqual([])
    expect(accounted(t)).toBe(0)
  })

  it('forgets a card the mount cap evicted, so a later record cannot resurrect it', () => {
    const t = new Transcript(p, { mountCapLines: 10 })
    t.apply({ kind: 'workflow-run-start', runId: 'r1', name: 'review' })
    for (let i = 0; i < 8; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    expect(rows(t).join('\n')).not.toContain('review')
    t.apply({ kind: 'workflow-agent-start', runId: 'r1', seq: 1, label: 'late', phase: undefined })
    expect(rows(t).join('\n')).not.toContain('late')
    expect(accounted(t)).toBeLessThanOrEqual(12)
  })

  it('renders identically live and on replay', () => {
    const events: AppEvent[] = [
      { kind: 'workflow-run-start', runId: 'r1', name: 'review' },
      { kind: 'workflow-agent-start', runId: 'r1', seq: 1, label: 'a', phase: undefined },
      { kind: 'workflow-run-end', runId: 'r1', stopReason: 'cancelled' },
    ]
    const live = new Transcript(p)
    const replay = new Transcript(p)
    for (const event of events) live.apply(event)
    for (const event of events) replay.apply(event)
    expect(live.container.render(80)).toEqual(replay.container.render(80))
  })
})
