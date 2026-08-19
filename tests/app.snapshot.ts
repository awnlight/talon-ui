import { afterAll, describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'
import { ResumePanel } from '../src/ui/panels/resume-panel.ts'
import { summarizeCandidate, type ResumeCandidate } from '../src/backend/sessions.ts'
import { checkpoint, expectObserved } from './helpers/checkpoint.ts'

const OWNED = ['conversation-roundtrip', 'approval-panel', 'question-multiselect', 'plan-review', 'slash-autocomplete', 'resume-selector'] as const
afterAll(() => expectObserved(OWNED))

/** Captures the registered provider so a checkpoint can drive a real ask()
 * through the controller's QuestionPanel (mirrors tests/questions.spec.ts). */
function questionService() {
  let provider: { ask(req: unknown): Promise<unknown> } | undefined
  return {
    get provider() { return provider },
    registerProvider(p: { ask(req: unknown): Promise<unknown> }) { provider = p; return () => { provider = undefined } },
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
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions, commands: commandService() })
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
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {}, userQuestions, commands: commandService() })
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

  it('question-multiselect', async () => {
    const terminal = new HeadlessTerminal(72, 24)
    const userQuestions = questionService()
    const controller = createController({ ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, userQuestions, commands: commandService() })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    const outcome = userQuestions.provider!.ask({ questions: [{
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
    const userQuestions = questionService()
    const controller = createController({ ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, userQuestions, commands: commandService() })
    await terminal.waitForFrame(0)
    const before = terminal.frames
    const outcome = userQuestions.provider!.ask({ questions: [{
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
    const controller = createController({ ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands })
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
    const controller = createController({ ctx: quietCtx(), agent: idleAgent(), terminal, palette: createPalette(true), exit: () => {}, userQuestions: { registerProvider: () => () => {} }, commands: commandService() })
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
})
