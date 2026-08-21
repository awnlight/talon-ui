/** D10④ (T2 carryover 8): normal interaction — streaming, panel open/close,
 * slash menu, notices — must trigger ZERO full redraws. A full redraw emits
 * ED3 (\x1b[3J), wiping terminal scrollback; resize is the ONLY tolerated
 * trigger and stays out of this flow. */
import { describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

// Fakes mirror tests/controller.spec.ts (fakeAgent, command dispatch) and
// tests/approval.spec.ts (fakeCtx with the waterfall) / tests/questions.spec.ts
// (the provider-capturing service) — the flow below drives the REAL controller
// through the same established shapes.
type CtxListener = (...args: unknown[]) => unknown
function fakeCtx() {
  const listeners = new Map<string, CtxListener[]>()
  return {
    listeners,
    on(event: string, fn: CtxListener) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(fn), 1)
    },
    emit(event: string, ...args: unknown[]) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    emitWaterfall(event: string, ...args: unknown[]): Promise<unknown> {
      const listener = (listeners.get(event) ?? [])[0]
      if (!listener) return Promise.resolve('unavailable')
      return Promise.resolve(listener(...args, () => Promise.resolve('unavailable')))
    },
  }
}

function fakeAgent(id = 'main') {
  return {
    id,
    status: 'idle' as 'idle' | 'running',
    session: { id } as { id: string; events?: { type: string; data: unknown }[] },
    cancelled: [] as unknown[],
    followups: [] as unknown[],
    cancel(cause: unknown) { this.cancelled.push(cause) },
    followup(message: unknown) { this.followups.push(message) },
    steer(message: unknown) { this.followups.push(message) },
    whenIdle: () => Promise.resolve(),
    ctx: undefined as unknown,
  }
}

function fakeQuestionService() {
  let provider: { ask(req: unknown): Promise<unknown> } | undefined
  return {
    get provider() { return provider },
    registerProvider(p: { ask(req: unknown): Promise<unknown> }) { provider = p; return () => { provider = undefined } },
  }
}

// tests/controller.spec.ts's dispatchingCommandService, closed into the durable
// loop: like dsh's CommandRuntime, execute() appends `command/run`, runs the
// handler synchronously, and appends `command/done` — arriving as session
// events so the result renders from the durable log (Ruling 5), and list()
// answers the registered definitions so the slash menu shows the real set.
type CommandDef = { name: string; description: string; handler: (invocation: never) => unknown }
function roundtripCommandService(record: (event: { type: string; data: unknown }) => void) {
  const definitions = new Map<string, CommandDef>()
  return {
    register: (definition: CommandDef): (() => void) => {
      definitions.set(definition.name, definition)
      return () => definitions.delete(definition.name)
    },
    list: (): readonly { name: string; description: string }[] =>
      [...definitions.values()].map(({ name, description }) => ({ name, description })).sort((a, b) => a.name.localeCompare(b.name)),
    execute: async (_agent: unknown, line: string, _signal: AbortSignal): Promise<unknown> => {
      const name = line.trim().slice(1).split(/\s+/, 1)[0]!
      const definition = definitions.get(name)
      if (definition === undefined) return undefined
      record({ type: 'command/run', data: { name, args: '' } })
      const result = definition.handler(undefined as never) as { kind: string; text?: string }
      record({ type: 'command/done', data: { kind: result.kind, text: result.text } })
      return { commandId: 'c', result }
    },
  }
}

function mount() {
  const ctx = fakeCtx()
  const agent = fakeAgent()
  agent.ctx = ctx
  const terminal = new HeadlessTerminal(60, 14)
  const userQuestions = fakeQuestionService()
  const commands = roundtripCommandService((event) => ctx.emit('session/event', agent.session, event))
  const controller = createController({
    ctx, agent, terminal, palette: createPalette(false), exit: vi.fn(), userQuestions, commands,
    agents: { resume: async () => ({ agent: fakeAgent('resumed') }) },
    createRootAgent: async () => ({ agent: fakeAgent('fresh') }),
    services: { sessions: { get: () => undefined }, llm: { listProviders: () => [] } },
  })
  return { ctx, agent, terminal, userQuestions, controller }
}

describe('zero-scrollback-wipe gate (D10④)', () => {
  it('the full T2 interaction flow completes with zero ED3 wipes', async () => {
    const { ctx, agent, terminal, userQuestions, controller } = mount()
    await terminal.waitForFrame(0)

    // Phase 1: user message → streaming deltas → settle → turn end.
    let before = terminal.frames
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'run the checks' }], source: { kind: 'user' } } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Running the ' } } })
    await terminal.waitForFrame(before)
    before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'checks now.' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Running the checks now.' }] } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' })
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('Running the checks now.')

    // Phase 2: approval request → panel → answer '1' → audit pair.
    before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' } } })
    const approval = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', callId: 'c1' })
    await terminal.waitForFrame(before)
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('pnpm test')) // enriched from tool/call by callId
    terminal.input('1')
    await expect(approval).resolves.toBe('allowed-once')
    before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } })
    ctx.emit('session/event', agent.session, { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } })
    await terminal.waitForFrame(before)
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('◆ approval · bash · allowed once'))

    // Phase 3: question request (multiSelect) → space + enter.
    before = terminal.frames
    const ask = userQuestions.provider!.ask({ questions: [{ id: 'q1', question: 'Which checks should run?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }] }] })
    await terminal.waitForFrame(before)
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('1. [ ] Lint')) // the question body itself sits in the panel's scroll region at 14 rows
    before = terminal.frames
    terminal.input(' ') // check 'Lint' under the cursor
    await terminal.waitForFrame(before)
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('1. [x] Lint'))
    terminal.input('\r')
    await expect(ask).resolves.toEqual({ answers: [{ id: 'q1', selected: ['Lint'] }] })
    expect(controller.panels.active).toBeUndefined()

    // Phase 4: '/' → slash menu open → esc closes it (draft cleared for phase 5).
    terminal.input('/')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('List available commands'))
    terminal.input('\x1b')
    await vi.waitFor(() => expect(terminal.snapshot()).not.toContain('List available commands'))
    terminal.input('\x03') // Ctrl+C: idle + non-empty composer clears the leftover '/'
    await vi.waitFor(() => expect(terminal.snapshot()).not.toContain('| "/"'))

    // Phase 5: /status roundtrip — the result renders from the durable
    // command/run + command/done events the service appended (Ruling 5).
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('agent idle'))
    expect(terminal.snapshot()).toContain('/status')

    // Phase 6: rebind to a second fake agent with a 3-event replay (D8).
    const next = fakeAgent('next')
    next.session = { id: 'next', events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'earlier prompt' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'earlier reply' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] }
    before = terminal.frames
    controller.bindAgent(next as never)
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('earlier reply')

    expect(terminal.scrollbackWipes).toBe(0)
    await controller.dispose()
  })

  it('a rebind before the first frame has no old screen to finish and still wipes nothing', async () => {
    const { terminal, controller } = mount()
    const next = fakeAgent('next')
    next.session = { id: 'next', events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'immediate prompt' }], source: { kind: 'user' } } },
    ] }
    controller.bindAgent(next as never) // synchronously — nothing has rendered yet
    await terminal.waitForFrame(0)
    expect(terminal.snapshot()).toContain('immediate prompt')
    expect(terminal.scrollbackWipes).toBe(0)
    await controller.dispose()
  })
})
