import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette, paletteTable } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'
import { AgentsPanel } from '../src/ui/panels/agents-panel.ts'
import { ModelPanel, type ModelPick } from '../src/ui/panels/model-panel.ts'
import { ResumePanel } from '../src/ui/panels/resume-panel.ts'
import { summarizeCandidate, type ResumeCandidate } from '../src/backend/sessions.ts'
import { checkpoint, expectObserved } from './helpers/checkpoint.ts'

const OWNED = ['conversation-roundtrip', 'approval-panel', 'question-multiselect', 'plan-review', 'slash-autocomplete', 'resume-selector', 'context-card', 'md-settled', 'md-stream', 'card-terminal', 'card-diff', 'card-read', 'card-search', 'card-generic', 'cards-expanded', 'cards-hidden', 'palette-table', 'compaction-marker', 'footer-metrics', 'model-selector', 'at-completion', 'agents-panel', 'card-workflow'] as const
afterAll(() => expectObserved(OWNED))

/** Drives a real ask() through the controller's QuestionPanel over the ctx
 * waterfall dsh 0.1.2-alpha.1 moved questions onto (mirrors
 * tests/questions.spec.ts). */
function questionCtx() {
  const listeners: ((req: unknown, next: () => Promise<unknown>) => unknown)[] = []
  return {
    on: (event: string, fn: (req: unknown, next: () => Promise<unknown>) => unknown) => {
      if (event === 'user-questions/request') listeners.push(fn)
      return () => {}
    },
    ask: async (request: unknown): Promise<unknown> => {
      for (const fn of listeners) return await fn(request, async () => { throw new Error('no answerer') })
      throw new Error('no answerer')
    },
  }
}

/** No checkpoint EXECUTES a slash command (see tests/controller.spec.ts) — a
 * no-op registry stub satisfies ControllerDeps. `list` is the one member a
 * checkpoint drives: it feeds the slash-autocomplete menu below. */
const commandService = () => ({ register: () => () => {}, list: () => [], execute: async () => undefined })

/** What dsh's `commands.list(agent)` answers once talon has registered its T2
 * set: name-sorted CommandDescriptors, descriptions verbatim from
 * src/backend/commands.ts. */
const T2_COMMANDS = [
  { name: 'exit', description: 'Exit talon' },
  { name: 'help', description: 'List available commands' },
  { name: 'quit', description: 'Exit talon (alias of /exit)' },
  { name: 'status', description: 'Show session status' },
]

/** Three fixed resume rows built by Task 14's own summarizer, so the golden's
 * refusal copy comes from the disable ladder rather than a hand-typed string.
 * Newest first (what buildResumeCandidates hands the panel), one foreign
 * workspace and one already-live session. */
const RESUME_CANDIDATES: ResumeCandidate[] = [
  summarizeCandidate({ header: { id: 's-abc', createdAt: 1_755_100_000_000, cwd: '/workspace/talon-ui' }, live: false, persisted: true }, 'Fix the login flow', undefined, 'main', '/workspace/talon-ui'),
  summarizeCandidate({ header: { id: 's-def', createdAt: 1_755_000_000_000, cwd: '/workspace/talon-ui' }, live: true, persisted: true }, undefined, undefined, 'main', '/workspace/talon-ui'),
  summarizeCandidate({ header: { id: 's-ghi', createdAt: 1_754_900_000_000, cwd: '/workspace/api' }, live: false, persisted: true }, 'Ship the webhook', undefined, 'main', '/workspace/talon-ui'),
]

/** Feed keystrokes one settled frame at a time — a checkpoint must never race
 * a frame still in flight. */
async function type(terminal: HeadlessTerminal, keys: string[]): Promise<void> {
  for (const key of keys) {
    const before = terminal.frames
    terminal.input(key)
    await terminal.waitForFrame(before)
  }
}

describe('talon snapshots', () => {
  // The footer prints the workspace, and reads the git branch out of its
  // `.git/HEAD`: freeze the cwd so no golden embeds the machine that ran it
  // (the fake path has no repository, so the branch segment stays absent —
  // gitBranch's own behaviour is pinned by tests/controller.spec.ts).
  beforeEach(() => { vi.spyOn(process, 'cwd').mockReturnValue('/workspace/talon-ui') })

  it('conversation-roundtrip', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 18)
    // No question flow in this checkpoint (see tests/questions.spec.ts) — a no-op stub satisfies ControllerDeps.
    const userQuestions = { registerProvider: () => () => {} }
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    let before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Rename the button.' }] } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Looking at the file.' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Done — renamed.' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'Looking at the file.' }, { type: 'text', text: 'Done — renamed.' }] } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await terminal.waitForFrame(before)
    await checkpoint('conversation-roundtrip', terminal)
    await controller.dispose()
  })

  it('approval-panel', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    // The panel renders process.cwd() verbatim (controller.ts): freeze it so
    // the committed golden snapshot doesn't embed this checkout's absolute
    // path (would mismatch on any other machine or CI).
    vi.spyOn(process, 'cwd').mockReturnValue('/workspace/talon-ui')
    const listeners = new Map<string, ((...a: unknown[]) => unknown)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => unknown) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
      emitWaterfall: (e: string, ...a: unknown[]): Promise<unknown> => {
        const listener = (listeners.get(e) ?? [])[0]
        if (!listener) return Promise.resolve('unavailable')
        return Promise.resolve(listener(...a, () => Promise.resolve('unavailable')))
      },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 18)
    // No question flow in this checkpoint (see tests/questions.spec.ts) — a no-op stub satisfies ControllerDeps.
    const userQuestions = { registerProvider: () => () => {} }
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    let before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' } } })
    const outcome = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', callId: 'c1', reason: 'sandbox escalation' })
    await terminal.waitForFrame(before)
    await checkpoint('approval-panel', terminal)

    before = terminal.frames
    terminal.input('1') // close the panel before dispose, so disposeAll finds nothing to force-settle
    await expect(outcome).resolves.toBe('allowed-once')
    await terminal.waitForFrame(before)

    before = terminal.frames
    // Mirrors what ApprovalService actually logs: the durable audit pair,
    // appended around the answerer dispatch this test drove above.
    ctx.emit('session/event', agent.session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c1' } })
    ctx.emit('session/event', agent.session, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('◆ approval · bash · allowed once')

    await controller.dispose()
  })

  // The two question checkpoints drive the panel entirely through the
  // questions provider, so their ctx never dispatches an event — `on` alone
  // (returning a detacher) is the whole surface the controller uses. 24 rows
  // gives the panel enough height that the header pager stays idle, so each
  // golden shows the whole question.
  const quietCtx = () => ({ on: () => () => {} })
  const idleAgent = () => ({ id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve() })
  /** Nor does any checkpoint drive /resume or /clear — the resume-selector
   * golden mounts its panel straight into the controller's PanelManager — so
   * an inert session-switching set satisfies ControllerDeps. */
  const sessionDeps = {
    agents: { resume: async () => ({ agent: idleAgent() }) },
    createRootAgent: async () => ({ agent: idleAgent() }),
    services: { sessions: { get: () => undefined }, llm: { listProviders: () => [] } },
  }

  it('question-multiselect', async () => {
    const terminal = new HeadlessTerminal(72, 24)
        const questions = questionCtx()
    const controller = createController({ ctx: questions, agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    const outcome = questions.ask({ questions: [{
      id: 'q1', header: 'Checks', question: 'Which checks should run before the push?',
      options: [{ label: 'Types', description: 'tsc --noEmit' }, { label: 'Tests' }, { label: 'Lint' }],
      multiSelect: true,
    }] })
    await terminal.waitForFrame(before)
    // Check one option, then leave a custom draft behind in the Input: Esc
    // returns to options mode (marks visible) and keeps the draft, which the
    // merged answer below proves survived.
    await type(terminal, [' ', '\t', ...'smoke run', '\x1b'])
    await checkpoint('question-multiselect', terminal)

    await type(terminal, ['\r']) // answer it, so dispose() finds no open panel
    await expect(outcome).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Types'], custom: 'smoke run' }] })
    await controller.dispose()
  })

  it('plan-review', async () => {
    const terminal = new HeadlessTerminal(72, 24)
        const questions = questionCtx()
    const controller = createController({ ctx: questions, agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    const outcome = questions.ask({ questions: [{
      id: 'q1', header: 'Plan review', question: 'Approve this plan and leave plan mode?',
      detail: '# The plan\n1. do things',
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve' },
    }] })
    await terminal.waitForFrame(before)
    await checkpoint('plan-review', terminal)

    // Enter on the landing cursor is the approval — the exact wire shape
    // plan-mode narrows on (selected === [approve], no custom key).
    await type(terminal, ['\r'])
    await expect(outcome).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Approve'] }] })
    await controller.dispose()
  })

  it('slash-autocomplete', async () => {
    const terminal = new HeadlessTerminal(72, 18)
    const commands = { ...commandService(), list: () => T2_COMMANDS }
    const controller = createController({ ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands, ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    terminal.input('/')
    await terminal.waitForFrame(before)   // the keystroke frame (menu query still in flight)
    // The menu arrives one async provider round-trip later; the frame carrying
    // it is the settled one — nothing else is scheduled after it.
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('List available commands'))
    await checkpoint('slash-autocomplete', terminal)

    await controller.dispose()
  })

  it('resume-selector', async () => {
    const terminal = new HeadlessTerminal(72, 18)
    const controller = createController({ ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    let before = terminal.frames
    // Mounted through the controller's own PanelManager (what Task 16 will
    // do), so the golden covers the real focus/queue path, not a bare render().
    let panel: ResumePanel | undefined
    const picked = controller.panels.enqueue<ResumeCandidate | undefined>({
      create: (finish) => (panel = new ResumePanel(finish, createPalette(true), (cwd) => cwd ?? 'cwd unset')),
      forced: () => ({ outcome: undefined }),
    })
    await terminal.waitForFrame(before)   // the loading frame

    panel!.setCandidates(RESUME_CANDIDATES)
    // setCandidates paints nothing by itself — the loader's owner requests that
    // render (Task 16 wires it). These keystrokes are that nudge, and they also
    // park the cursor on the already-live row and make it refuse: at 72 columns
    // the two-column row leaves 48 for the meta, so the full reason only ever
    // fits on the error line below.
    await type(terminal, ['\x1b[B', '\r'])
    await checkpoint('resume-selector', terminal)

    before = terminal.frames
    terminal.input('\x1b')                // empty query: esc cancels the panel
    await expect(picked).resolves.toBeUndefined()
    await terminal.waitForFrame(before)
    await controller.dispose()
  })

  it('md-settled', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 18)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // A settled assistant message with markdown source (Task 2): heading,
    // highlighted ts fence, list with inline bold — reasoning stays plain
    // dim+italic above it (Ruling 16).
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Show the fix.' }] } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: 'Checking the diff.' },
      { type: 'text', text: '# Fix\n```ts\nconst n = 1 // count\n```\n- fast\n- **safe**' },
    ] } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await terminal.waitForFrame(before)
    await checkpoint('md-settled', terminal)

    await controller.dispose()
  })

  it('md-stream', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 18)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // A frame frozen MID-STREAM (Task 3): fixed text deltas cut a list item
    // in half across chunks and leave a ts fence OPEN — the live Markdown
    // rebuild renders bullets + the highlighted partial fence body, with
    // trimPartialClosingFences keeping the open fence stable. No
    // assistant/message before the checkpoint: this IS the live path.
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Stream the fix.' }] } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Sketching the patch.' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: '# Fix\n\n- fast\n- sa' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'fe\n\n```ts\nconst n = 1 // count\nlet m = ' } } })
    await terminal.waitForFrame(before)
    await checkpoint('md-stream', terminal)

    // Settle and close the turn after the frozen frame, so dispose() finds a
    // quiet transcript (mirrors conversation-roundtrip).
    const after = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [
      { type: 'reasoning', text: 'Sketching the patch.' },
      { type: 'text', text: '# Fix\n\n- fast\n- safe\n\n```ts\nconst n = 1 // count\nlet m = 2\n```' },
    ] } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await terminal.waitForFrame(after)
    await controller.dispose()
  })

  it('card-terminal', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    // The cards render the cwd the command ran in (tool-cards.ts): freeze it so
    // the committed golden does not embed this checkout's absolute path.
    vi.spyOn(process, 'cwd').mockReturnValue('/workspace/talon-ui')
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 22)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // All three terminal-card tones in one frame (Task 6): a clean run in
    // success, a non-zero exit the tool did NOT flag as an error yet the card
    // colors red and refuses to fold, and a call still running in warning.
    // Every result string is shaped exactly as dsh's `renderResult` emits it.
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Run the checks.' }] } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"pnpm test","description":"Run the test suite"}' } })
    ctx.emit('session/event', agent.session, { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: '12 passed\n0 failed\n' }] }] } } })
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{"command":"pnpm typecheck","description":"Check the types","workdir":"/workspace/talon-ui/src"}' } })
    ctx.emit('session/event', agent.session, { type: 'tool/result', data: { turn: 1, step: 2, message: { content: [{ toolCallId: 'c2', content: [{ type: 'text', text: 'src/a.ts(4,7): error TS2304: cannot find name\n[exit code: 2]' }] }] } } })
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn: 1, step: 3, callId: 'c3', name: 'bash', arguments: '{"command":"pnpm build","description":"Build the bundle"}' } })
    await terminal.waitForFrame(before)
    await checkpoint('card-terminal', terminal)

    await controller.dispose()
  })

  it('card-diff', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 22)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // An `edit` settling from the applied hunks dsh persists as meta (path
    // header suppressed — the head already names the file), then a `write`
    // create, whose meta records NO hunks so the card rebuilds the change from
    // the call arguments. Both hunks are shaped exactly as computeHunkDiffs
    // emits them: three context lines a side, `oldText: null` for an insertion.
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Rename the flag.' }] } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"file_path":"src/flags.ts","old_string":"legacy","new_string":"modern"}' } })
    ctx.emit('session/event', agent.session, {
      type: 'tool/result',
      data: {
        turn: 1, step: 1,
        message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'edited src/flags.ts' }] }] },
        meta: { diffs: [{ path: 'src/flags.ts', oldText: 'export const flags = {\n  legacy: true,\n}', newText: 'export const flags = {\n  modern: true,\n}' }] },
      },
    })
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn: 1, step: 2, callId: 'c2', name: 'write', arguments: '{"file_path":"src/notes.md","content":"# Notes\\n\\nRenamed the flag."}' } })
    ctx.emit('session/event', agent.session, { type: 'tool/result', data: { turn: 1, step: 2, message: { content: [{ toolCallId: 'c2', content: [{ type: 'text', text: 'wrote src/notes.md' }] }] }, meta: { diffs: [] } } })
    await terminal.waitForFrame(before)
    await checkpoint('card-diff', terminal)

    await controller.dispose()
  })

  /** The card checkpoints below share one harness: a controller bound to an
   * event-emitting ctx, driven purely by durable session events. */
  const cardHarness = (rows: number, columns = 72) => {
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(columns, rows)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    const send = (type: string, data: unknown) => ctx.emit('session/event', agent.session, { type, data })
    return { terminal, controller, send }
  }

  it('card-read', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(18)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // The numbered window `read` persists as meta, highlighted through
    // meta.lang — ANSI-16 roles only, which the checkpoint's theme gate proves.
    send('user/message', { content: [{ type: 'text', text: 'Show me the flag.' }] })
    send('turn/start', { turn: 1 })
    send('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/flags.ts","offset":9}' })
    send('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: '9\tconst flags = {' }] }] },
      meta: {
        path: 'src/flags.ts', offset: 9, totalLines: 120, lang: 'typescript',
        lines: [
          { number: 9, text: '// the feature flags' },
          { number: 10, text: 'export const flags = {' },
          { number: 11, text: '  modern: true,' },
          { number: 12, text: '}' },
        ],
      },
    })
    await terminal.waitForFrame(before)
    await checkpoint('card-read', terminal)

    await controller.dispose()
  })

  it('card-search', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(20)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // grep's by-file groups and glob's flat list, both carrying the pre-cap
    // `total` — the grep result is capped, so its card says so.
    send('user/message', { content: [{ type: 'text', text: 'Where is the flag used?' }] })
    send('turn/start', { turn: 1 })
    send('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'grep', arguments: '{"pattern":"modern","path":"src"}' })
    send('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'src/flags.ts:10:  modern: true,' }] }] },
      meta: {
        shape: 'matches', truncated: true, total: 42,
        files: [
          { path: 'src/flags.ts', matches: [{ lineNumber: 10, line: '  modern: true,' }] },
          { path: 'src/app.ts', matches: [{ lineNumber: 3, line: 'if (flags.modern) {' }] },
        ],
      },
    })
    send('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'glob', arguments: '{"pattern":"src/**/*.test.ts"}' })
    send('tool/result', {
      turn: 1, step: 2,
      message: { content: [{ toolCallId: 'c2', content: [{ type: 'text', text: 'src/flags.test.ts' }] }] },
      meta: { shape: 'paths', truncated: false, total: 2, paths: ['src/flags.test.ts', 'src/app.test.ts'] },
    })
    await terminal.waitForFrame(before)
    await checkpoint('card-search', terminal)

    await controller.dispose()
  })

  it('card-generic', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(20)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // The web rows (a source list over dim urls) and a generic body rendered
    // through the shared Markdown theme — heading, bullets, a highlighted
    // fence — folded by VISIBLE rows.
    send('user/message', { content: [{ type: 'text', text: 'What changed upstream?' }] })
    send('turn/start', { turn: 1 })
    send('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{"queries":["pi-tui release notes"]}' })
    send('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'two results' }] }] },
      meta: { truncated: false, sources: [
        { url: 'https://pi-tui.example/releases/0.84.1', title: 'pi-tui 0.84.1' },
        { url: 'https://pi-tui.example/blog', title: 'Release notes' },
      ] },
    })
    send('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'skill', arguments: '{"name":"writing-plans"}' })
    send('tool/result', { turn: 1, step: 2, message: { content: [{ toolCallId: 'c2', content: [{ type: 'text', text: '# writing-plans\n\n- state the goal\n- **verify** each step' }] }] } })
    await terminal.waitForFrame(before)
    await checkpoint('card-generic', terminal)

    await controller.dispose()
  })

  /** One coding turn — text, a tool call, more text, plus injected context —
   * driven through the SAME events for both visibility goldens below, so the
   * pair reads as one Ctrl+O sequence rather than two unrelated frames. */
  const visibilityTurn = (send: (type: string, data: unknown) => void) => {
    send('user/message', { content: [{ type: 'text', text: 'Rename the flag.' }] })
    send('user/message', { content: [{ type: 'text', text: 'writing-plans\nexecuting-plans' }], source: { kind: 'skill-catalog', form: 'catalog' } })
    send('turn/start', { turn: 1 })
    send('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Looking at the flag.' }] } })
    send('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"src/flags.ts","offset":9}' })
    send('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: '9\tconst flags' }] }] },
      meta: { path: 'src/flags.ts', offset: 9, totalLines: 120, lang: 'typescript', lines: [
        { number: 9, text: 'export const flags = {' },
        { number: 10, text: '  modern: true,' },
        { number: 11, text: '}' },
      ] },
    })
    send('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Renamed it.' }] } })
    send('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }

  it('cards-expanded', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(22)
    await terminal.waitForFrame(0)
    let before = terminal.frames
    visibilityTurn(send)
    await terminal.waitForFrame(before)

    before = terminal.frames
    terminal.input('\x0f')          // Ctrl+O once: expanded — the context body appears too
    await terminal.waitForFrame(before)
    await checkpoint('cards-expanded', terminal)

    await controller.dispose()
  })

  it('cards-hidden', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(18)
    await terminal.waitForFrame(0)
    let before = terminal.frames
    visibilityTurn(send)
    await terminal.waitForFrame(before)

    // Twice: expanded, then hidden — the card and the context card vanish, the
    // two steps of the turn fold under ONE talon header, and no orphaned blank
    // rows are left where the cards were.
    for (const _ of [0, 1]) {
      before = terminal.frames
      terminal.input('\x0f')
      await terminal.waitForFrame(before)
    }
    await checkpoint('cards-hidden', terminal)

    await controller.dispose()
  })

  it('palette-table', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(20, 108)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // `/palette` through the DURABLE path (Ruling 5): command/run then
    // command/done, exactly as dsh's CommandRuntime records them, with the
    // table generated from paletteSpec so the golden cannot drift from the
    // spec table it documents.
    send('command/run', { name: 'palette', args: '' })
    send('command/done', { kind: 'success', text: paletteTable(createPalette(true)) })
    await terminal.waitForFrame(before)
    await checkpoint('palette-table', terminal)

    await controller.dispose()
  })

  it('compaction-marker', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(18)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // The permanent bookmark: the shadowed exchange stays ABOVE it, exactly as
    // it does on replay — one durable checkpoint message, one dim line.
    send('user/message', { content: [{ type: 'text', text: 'What did we decide?' }], source: { kind: 'user' } })
    send('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'To rename the flag.' }] } })
    send('compaction/start', { compactionId: 'k1', turn: 1 })
    send('user/message', { content: [{ type: 'text', text: 'Summary of the earlier conversation.' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'k1' } })
    send('compaction/end', { compactionId: 'k1', turn: 1 })
    send('user/message', { content: [{ type: 'text', text: 'Ship it.' }], source: { kind: 'user' } })
    await terminal.waitForFrame(before)
    await checkpoint('compaction-marker', terminal)

    await controller.dispose()
  })

  it('footer-metrics', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(14, 88)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // The whole template at rest: workspace, model, cache and context folded
    // from durable events, with two messages waiting behind an idle agent.
    // (No branch: the frozen workspace has no repository — gitBranch's own
    // behaviour is pinned in tests/controller.spec.ts.)
    send('user/message', { content: [{ type: 'text', text: 'Rename the flag.' }], source: { kind: 'user' } })
    send('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64000 })
    send('assistant/message', {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Renamed it.' }] },
      usage: { inputTokens: 4200, outputTokens: 380, cacheReadTokens: 31_000, cacheWriteTokens: 400 },
    })
    send('turn/end', { turn: 1, reason: { kind: 'completed' } })
    send('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{}, {}] })
    await terminal.waitForFrame(before)
    await checkpoint('footer-metrics', terminal)

    await controller.dispose()
  })

  it('model-selector', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const terminal = new HeadlessTerminal(76, 18)
    // Mounted through the controller's own PanelManager, like the resume
    // selector's golden: the real focus and queue path, not a bare render().
    const controller = createController({
      ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {},
      userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps,
    })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    let panel: ModelPanel | undefined
    const picked = controller.panels.enqueue<ModelPick | undefined>({
      create: (finish) => (panel = new ModelPanel(finish, createPalette(true))),
      forced: () => ({ outcome: undefined }),
    })
    await terminal.waitForFrame(before)   // the loading frame
    panel!.setChoices([
      { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', name: 'Chat', description: 'fast general model', contextWindow: 64_000, efforts: [], defaultEffort: undefined, current: false },
      { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-reasoner', name: 'Reasoner', description: undefined, contextWindow: 128_000, efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low', current: true },
      { provider: 'local', providerName: 'local', model: 'my-own-build', name: 'my-own-build', description: undefined, contextWindow: undefined, efforts: [], defaultEffort: undefined, current: false },
    ])
    // setChoices paints nothing by itself (the resume selector's precedent):
    // these keys are the nudge, and they park the highlight on the current
    // route with its effort cycled one step on.
    await type(terminal, ['\x1b[B', '\x1b[Z'])
    await checkpoint('model-selector', terminal)

    const after = terminal.frames
    terminal.input('\x1b')                // esc on an empty query cancels
    await expect(picked).resolves.toBeUndefined()
    await terminal.waitForFrame(after)
    await controller.dispose()
  })

  it('at-completion', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const terminal = new HeadlessTerminal(76, 16)
    const controller = createController({
      ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {},
      userQuestions: { registerProvider: () => () => {} }, commands: commandService(),
      ...sessionDeps,
      services: {
        ...sessionDeps.services,
        // `@` reads the composed file-reference service; the paths below are
        // exactly the shape it answers with (path + kind, never contents).
        fileReferences: { list: async () => [
          { path: 'src/app/controller.ts', kind: 'file' as const },
          { path: 'src/ui', kind: 'directory' as const },
          { path: 'docs/my plan.md', kind: 'file' as const },
        ] },
      },
    })
    await terminal.waitForFrame(0)
    await type(terminal, [...'look at @src'])
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('controller.ts'))
    await checkpoint('at-completion', terminal)

    await controller.dispose()
  })

  it('agents-panel', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const terminal = new HeadlessTerminal(76, 16)
    const controller = createController({
      ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {},
      userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps,
    })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    let panel: AgentsPanel | undefined
    void controller.panels.enqueue<undefined>({
      create: (finish) => (panel = new AgentsPanel(() => finish(undefined), createPalette(true))),
      forced: () => ({ outcome: undefined }),
    })
    await terminal.waitForFrame(before)
    // The shape `listDescendants` answers with: an interpreted tree, including
    // a diagnostic the panel shows dim rather than as an error.
    panel!.setEntries([
      { kind: 'child', id: 's-review', depth: 1, activity: 'running', mode: 'continuable', label: 'reviewer' },
      { kind: 'child', id: 's-grep', depth: 2, activity: 'inactive', mode: 'one-shot', label: 'grep pass' },
      { kind: 'diagnostic', id: 's-broken', depth: 2, reason: 'corrupt' },
    ])
    await type(terminal, ['x'])            // any key repaints; none of them close
    await checkpoint('agents-panel', terminal)

    const after = terminal.frames
    terminal.input('\x1b')
    await terminal.waitForFrame(after)
    await controller.dispose()
  })

  it('card-workflow', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const { terminal, controller, send } = cardHarness(18)
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // The durable record, in the order a real run writes it: one run still in
    // flight beneath one that already settled, so both tones are on screen.
    send('user/message', { content: [{ type: 'text', text: 'Review the branch.' }], source: { kind: 'user' } })
    send('tool-workflow/run-start', { runId: 'r1', name: 'review-changes' })
    send('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'review:bugs', phase: 'Review', childId: 'c1' })
    send('tool-workflow/agent-start', { runId: 'r1', seq: 2, label: 'review:perf', phase: 'Review', childId: 'c2' })
    send('tool-workflow/agent-end', { runId: 'r1', seq: 1, outcome: 'completed' })
    send('tool-workflow/agent-end', { runId: 'r1', seq: 2, outcome: 'failed' })
    send('tool-workflow/run-end', { runId: 'r1', stopReason: 'completed' })
    send('tool-workflow/run-start', { runId: 'r2', name: 'verify-findings' })
    send('tool-workflow/agent-start', { runId: 'r2', seq: 1, label: 'verify:a', phase: 'Verify', childId: 'c3' })
    await terminal.waitForFrame(before)
    await checkpoint('card-workflow', terminal)

    await controller.dispose()
  })

  it('context-card', async () => {
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 18)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService(), ...sessionDeps })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    // Injected context between two real prompts (carryover 11): only what the
    // user typed wears the 'You' header — the skill catalog dsh injects as a
    // user-role message collapses to one dim card.
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Which skills are loaded?' }], source: { kind: 'user' } } })
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: '# Skills\n- writing-plans\n- executing-plans' }], source: { kind: 'skill-catalog', form: 'catalog' } } })
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Use executing-plans.' }], source: { kind: 'user' } } })
    await terminal.waitForFrame(before)
    await checkpoint('context-card', terminal)

    await controller.dispose()
  })
})
