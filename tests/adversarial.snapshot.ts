/** D7.8 adversarial gate (spec §8 T3 acceptance): every T3 surface fed hostile
 * content at once — C0/C1 controls, ESC sequences, a fake OSC 8 hyperlink, RTL
 * overrides, oversized lines, malformed XML, a markdown bomb — and asserted on
 * the FRAME, not on the strings that produced it.
 *
 * Escaping a string is easy to get right in a unit test and easy to lose in the
 * one path nobody re-checked, so the assertions here are the properties a
 * terminal actually cares about: nothing that could move the cursor, retitle
 * the window or repaint the screen survives to the emulator; no row is wider
 * than the terminal (TuiMainScreen rejects one); the theme stays ANSI-16; and
 * the scrollback is never wiped. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'
import { checkpoint, expectObserved } from './helpers/checkpoint.ts'

const OWNED = ['untrusted-controls'] as const
afterAll(() => expectObserved(OWNED))

/** Every neutralization class in one string, reused across every surface. */
const HOSTILE = [
  '\x1b]0;RETITLED\x07',            // OSC: window title
  '\x1b[2J\x1b[H',                  // CSI: clear screen and home the cursor
  '\x1b]8;;https://evil.example\x1b\\CLICKME\x1b]8;;\x1b\\', // a fake OSC 8 hyperlink
  '‮gnihtemos‬',          // RTL override: text that reads backwards
  '\x07\x00\x1f\x7f\x9b',           // BEL, NUL, US, DEL, and a C1 CSI introducer
].join('')
const OVERSIZED = 'A'.repeat(4000)

/** What must never reach the emulator, whatever produced it. */
const FORBIDDEN: [string, RegExp][] = [
  ['an OSC title sequence', /\x1b\]0;/],
  ['a screen-clearing CSI', /\x1b\[2J/],
  ['an OSC 8 hyperlink', /\x1b\]8;/],
  ['a raw RTL override', /[‪-‮]/],
  ['a bare BEL or NUL', /[\x00\x07]/],
  ['a C1 control', /[\x80-\x9f]/],
]

/** The T4 completion and panel surfaces take the same corpus, through their
 * own code paths rather than the session log. */
const HOSTILE_FILES = [
  { path: `src/${HOSTILE}.ts`, kind: 'file' as const },
  { path: `${OVERSIZED}/deep`, kind: 'directory' as const },
]

function mount(rows = 40, cols = 100) {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const ctx = {
    on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
    emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
  }
  const idle = () => ({ id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve() })
  const agent = { ...idle(), ctx }
  const terminal = new HeadlessTerminal(cols, rows)
  const controller = createController({
    ctx, agent, terminal, palette: createPalette(true), exit: () => {},
    userQuestions: { registerProvider: () => () => {} },
    commands: { register: () => () => {}, list: () => [{ name: `cmd${HOSTILE}`, description: HOSTILE }], execute: async () => undefined },
    agents: { resume: async () => ({ agent: idle() }) },
    createRootAgent: async () => ({ agent: idle() }),
    services: {
      sessions: { get: () => undefined },
      llm: { listProviders: () => [] },
      fileReferences: { list: async () => HOSTILE_FILES },
      subagents: { listDescendants: async () => [
        { kind: 'child' as const, id: HOSTILE, depth: 1, activity: 'running' as const, mode: 'continuable' as const, label: `${HOSTILE}${OVERSIZED}` },
        { kind: 'diagnostic' as const, id: OVERSIZED, depth: 2, reason: HOSTILE },
      ] },
    },
  } as never)
  const send = (type: string, data: unknown) => ctx.emit('session/event', agent.session, { type, data })
  return { terminal, controller, send }
}

/** Drive every T3 surface with hostile content. Each `send` mirrors the exact
 * durable shape its renderer narrows, so nothing here is a synthetic detour. */
function hostileSession(send: (type: string, data: unknown) => void): void {
  send('user/message', { content: [{ type: 'text', text: `prompt ${HOSTILE}` }], source: { kind: 'user' } })
  send('user/message', { content: [{ type: 'text', text: `injected ${HOSTILE}` }], source: { kind: `catalog${HOSTILE}`, form: 'notice', summary: HOSTILE } })
  send('turn/start', { turn: 1 })

  // Markdown bomb: nested emphasis, an unclosed fence, a huge word, a table.
  send('assistant/message', { turn: 1, step: 1, message: { content: [
    { type: 'reasoning', text: `thinking ${HOSTILE}` },
    { type: 'text', text: `# ${HOSTILE}\n\n***${'*'.repeat(200)}***\n\n\`\`\`ts\nconst x = "${HOSTILE}"\n${OVERSIZED}\n\n| a | b |\n|---|---|\n| ${HOSTILE} | ${OVERSIZED} |` },
  ] } })

  // terminal: hostile command, workdir, output, and a forged exit marker.
  send('tool/call', { turn: 1, step: 2, callId: 't1', name: `bash${HOSTILE}`, arguments: JSON.stringify({ command: `echo ${HOSTILE}`, description: HOSTILE, workdir: `/tmp/${HOSTILE}` }) })
  send('tool/result', { turn: 1, step: 2, message: { content: [{ toolCallId: 't1', content: [{ type: 'text', text: `${HOSTILE}\n${OVERSIZED}\n[killed by signal: ${HOSTILE}]` }] }] } })

  // diff: hostile path and hunk content, on both sides.
  send('tool/call', { turn: 1, step: 3, callId: 'd1', name: 'edit', arguments: JSON.stringify({ file_path: `src/${HOSTILE}.ts`, old_string: 'x', new_string: 'y' }) })
  send('tool/result', {
    turn: 1, step: 3,
    message: { content: [{ toolCallId: 'd1', content: [{ type: 'text', text: 'edited' }] }] },
    meta: { diffs: [{ path: `src/${HOSTILE}.ts`, oldText: `old ${HOSTILE}`, newText: `new ${OVERSIZED}` }] },
  })

  // read: hostile excerpt, with a language the highlighter will really parse.
  send('tool/call', { turn: 1, step: 4, callId: 'r1', name: 'read', arguments: JSON.stringify({ file_path: `a${HOSTILE}.ts`, offset: 1 }) })
  send('tool/result', {
    turn: 1, step: 4,
    message: { content: [{ toolCallId: 'r1', content: [{ type: 'text', text: 'read' }] }] },
    meta: { path: 'a.ts', offset: 1, totalLines: 2, lang: 'typescript', lines: [{ number: 1, text: `const a = "${HOSTILE}"` }, { number: 2, text: OVERSIZED }] },
  })

  // search: hostile paths and matched lines.
  send('tool/call', { turn: 1, step: 5, callId: 's1', name: 'grep', arguments: JSON.stringify({ pattern: HOSTILE }) })
  send('tool/result', {
    turn: 1, step: 5,
    message: { content: [{ toolCallId: 's1', content: [{ type: 'text', text: 'found' }] }] },
    meta: { shape: 'matches', truncated: true, total: 9, files: [{ path: `p/${HOSTILE}`, matches: [{ lineNumber: 1, line: `${HOSTILE}${OVERSIZED}` }] }] },
  })

  // web: hostile title and url.
  send('tool/call', { turn: 1, step: 6, callId: 'w1', name: 'web_search', arguments: JSON.stringify({ queries: [HOSTILE] }) })
  send('tool/result', {
    turn: 1, step: 6,
    message: { content: [{ toolCallId: 'w1', content: [{ type: 'text', text: 'results' }] }] },
    meta: { truncated: false, sources: [{ url: `https://x/${HOSTILE}`, title: `${HOSTILE}${OVERSIZED}` }] },
  })

  // unregistered: MALFORMED xml, which must refuse back to plain escaped text.
  send('tool/call', { turn: 1, step: 7, callId: 'x1', name: 'mcp__evil__run', arguments: JSON.stringify({ q: HOSTILE }) })
  send('tool/result', { turn: 1, step: 7, message: { content: [{ toolCallId: 'x1', content: [{ type: 'text', text: `<a><b attr="${HOSTILE}">${OVERSIZED}</a>` }] }] } })

  // The T4 surfaces: a title derived from model output, and a workflow record
  // whose every string came from a script talon did not write.
  send('session/title', { title: `${HOSTILE}${OVERSIZED}`, messageSeqs: [], source: { kind: 'llm' } })
  send('tool-workflow/run-start', { runId: 'r1', name: `${HOSTILE}${OVERSIZED}` })
  send('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: HOSTILE, phase: HOSTILE, childId: 'c' })
  send('tool-workflow/agent-end', { runId: 'r1', seq: 1, outcome: HOSTILE })
  send('tool-workflow/run-end', { runId: 'r1', stopReason: HOSTILE })

  // retry, approval audit, compaction marker, and a command's output.
  send('llm/retry', { retryId: 'r', turn: 1, step: 8, provider: HOSTILE, policyKey: 'p', mode: 'always', retry: 1, delayMs: 10, failure: { message: `${HOSTILE}${OVERSIZED}`, code: 'X' } })
  send('approval/asked', { id: 'a1', toolName: `bash${HOSTILE}` })
  send('approval/decided', { id: 'a1', outcome: `weird${HOSTILE}` })
  send('user/message', { content: [{ type: 'text', text: `summary ${HOSTILE}` }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'k' } })
  send('command/run', { name: `evil${HOSTILE}`, args: HOSTILE })
  send('command/done', { kind: 'error', text: `${HOSTILE}${OVERSIZED}` })
  send('request/context', { provider: 'p', model: `model${HOSTILE}`, contextWindow: 100 })
  send('turn/end', { turn: 1, reason: { kind: 'error', error: { message: `${HOSTILE}` } } })
}

describe('untrusted controls (D7.8, spec §8 T3 acceptance)', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    // The footer prints the workspace: hostile there too, and still frozen so
    // the golden never embeds the machine that ran it.
    vi.spyOn(process, 'cwd').mockReturnValue(`/workspace/${HOSTILE}`)
  })
  afterAll(() => vi.restoreAllMocks())

  it('no hostile sequence survives to the emulator, in any card mode', async () => {
    const { terminal, controller, send } = mount()
    await terminal.waitForFrame(0)
    let before = terminal.frames
    hostileSession(send)
    await terminal.waitForFrame(before)

    // Growing a transcript never wipes scrollback, however hostile it is.
    expect(terminal.scrollbackWipes, 'appending is always differential').toBe(0)

    // Every visibility mode re-derives every body, so each one is its own
    // chance to leak: check the frame after each. This transcript is far taller
    // than the viewport, so a mode change may cost the ONE unavoidable redraw
    // (tests/redraw.spec.ts documents why) — but never more than one each.
    for (const cycle of [1, 2, 3]) {
      const snapshot = terminal.snapshot()
      for (const [name, pattern] of FORBIDDEN) expect(snapshot, name).not.toMatch(pattern)
      expect(terminal.themeViolations()).toEqual([])
      expect(terminal.scrollbackWipes, 'at most one redraw per shrink').toBeLessThanOrEqual(cycle)
      before = terminal.frames
      terminal.input('\x0f')                    // Ctrl+O: collapsed → expanded → hidden
      await terminal.waitForFrame(before)
    }
    // …and with reasoning toggled off, which re-derives the streaming cells.
    before = terminal.frames
    terminal.input('\x12')
    await terminal.waitForFrame(before)
    for (const [name, pattern] of FORBIDDEN) expect(terminal.snapshot(), name).not.toMatch(pattern)

    await controller.dispose()
  })

  it('keeps the completion menu and the agents tree clean of hostile content too', async () => {
    const { terminal, controller, send } = mount()
    await terminal.waitForFrame(0)
    let before = terminal.frames
    hostileSession(send)
    await terminal.waitForFrame(before)

    // `@` opens the file menu over the hostile candidates above.
    for (const key of ['@', 's']) {
      before = terminal.frames
      terminal.input(key)
      await terminal.waitForFrame(before)
    }
    await new Promise((r) => setTimeout(r, 20))
    for (const [name, pattern] of FORBIDDEN) expect(terminal.snapshot(), `menu: ${name}`).not.toMatch(pattern)
    expect(terminal.themeViolations()).toEqual([])
    await controller.dispose()
  })

  it('renders the hostile session at every width without an over-wide row', async () => {
    // Realistic terminals only: wrapping multiplies rows by the width factor,
    // so a one-column terminal turns a 4000-character line into 4000 rows —
    // unbounded by DESIGN (D10 caps CONTENT lines, not wrapped rows), not by a
    // defect. What matters here is that no row is ever wider than the terminal.
    for (const cols of [10, 20, 40, 100]) {
      const { terminal, controller, send } = mount(30, cols)
      await terminal.waitForFrame(0)
      const before = terminal.frames
      hostileSession(send)
      await terminal.waitForFrame(before)       // an over-wide row CRASHES TuiMainScreen
      expect(terminal.snapshot(), `${cols} columns`).toContain(`terminal ${cols}x30`)
      await controller.dispose()
    }
  })

  it('untrusted-controls', async () => {
    const { terminal, controller, send } = mount(30, 100)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    hostileSession(send)
    await terminal.waitForFrame(before)
    await checkpoint('untrusted-controls', terminal)
    await controller.dispose()
  })
})
