import { afterEach, describe, expect, it, vi } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController, type ControllerDeps } from '../src/app/controller.ts'

type Listener = (...args: unknown[]) => void

function fakeCtx() {
  const listeners = new Map<string, Listener[]>()
  return {
    listeners,
    on(event: string, fn: Listener) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(fn), 1)
    },
    emit(event: string, ...args: unknown[]) { for (const fn of listeners.get(event) ?? []) fn(...args) },
  }
}

function fakeAgent(id = 'main') {
  return {
    id,
    status: 'idle' as 'idle' | 'running',
    // Typed wide enough for Task 16's rebind tests to hand bindAgent a session
    // carrying a replayable event log.
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

// Minimal `ctx.commands` facet: registrations are accepted and dropped, no
// command is advertised, and every execute() settles like dsh's real
// CommandRuntime does for a resolved command (a CommandExecution object).
// Tests override individual members through setup().
type CommandDef = { name: string; description: string; handler: (invocation: never) => unknown }
function fakeCommandService() {
  return {
    register: (_definition: CommandDef): (() => void) => () => {},
    list: (): readonly { name: string; description: string }[] => [],
    execute: vi.fn(async (_agent: unknown, _line: string, _signal: AbortSignal): Promise<unknown> => ({ commandId: 'c', result: { kind: 'success' } })),
  }
}

// A commands facet that really dispatches: registrations land in `handlers`
// and execute() runs the matching one, so a test can drive talon's own
// handlers end-to-end from the composer (an unknown name still answers
// undefined, exactly like the real registry). `log` mirrors what dsh's
// CommandRuntime.execute appends to the durable session log — and, like the
// real one, the handler runs SYNCHRONOUSLY and the signal is re-checked once
// it returns (dsh's `withAbort` rejects an already-aborted signal before
// looking at the handler's result), so a self-abort turns a successful
// command into an errored `command/done`.
function dispatchingCommandService() {
  const handlers = new Map<string, () => unknown>()
  const log: string[] = []
  return {
    handlers,
    log,
    register: (definition: CommandDef): (() => void) => {
      handlers.set(definition.name, () => definition.handler(undefined as never))
      return () => handlers.delete(definition.name)
    },
    execute: vi.fn(async (_agent: unknown, line: string, signal: AbortSignal): Promise<unknown> => {
      const handler = handlers.get(line.slice(1))
      if (handler === undefined) return undefined
      log.push(`command/run ${line.slice(1)}`)
      const result = handler()
      if (signal.aborted) {
        log.push('command/done error')
        throw new Error('This operation was aborted')
      }
      log.push('command/done success')
      return { commandId: 'c', result }
    }),
  }
}

// Task 16's session-switching deps. Inert by default — no /resume flow runs
// without a `sessionQuery`, and no test reaches the agent factories unless it
// overrides them.
function fakeSessionDeps() {
  return {
    agents: { resume: async () => ({ agent: fakeAgent('resumed') }) },
    createRootAgent: async () => ({ agent: fakeAgent('fresh') }),
    services: { sessions: { get: () => undefined }, llm: { listProviders: () => [{ id: 'deepseek' }] } },
  }
}

// `enabled` toggles palette colors on (default off, matching every prior
// test's plain-text assertions). Only the waiting-color test below needs
// colors on, to tell the composer's rule-line state apart by SGR (mirrors
// composer.spec.ts's own fg-13/fg-3 convention).
function setup(overrides: {
  enabled?: boolean
  cols?: number
  commands?: Partial<ReturnType<typeof fakeCommandService>>
  agents?: ControllerDeps['agents']
  createRootAgent?: ControllerDeps['createRootAgent']
  services?: Partial<ControllerDeps['services']>
} = {}) {
  const ctx = fakeCtx()
  const agent = fakeAgent()
  agent.ctx = ctx
  const terminal = new HeadlessTerminal(overrides.cols ?? 60, 14)
  const exit = vi.fn()
  // This file doesn't exercise user-questions flows (see tests/questions.spec.ts) — a no-op stub satisfies ControllerDeps.
  const userQuestions = { registerProvider: () => () => {} }
  const commands = { ...fakeCommandService(), ...overrides.commands }
  const session = fakeSessionDeps()
  const controller = createController({
    ctx, agent, terminal, palette: createPalette(overrides.enabled ?? false), exit, userQuestions, commands,
    agents: overrides.agents ?? session.agents,
    createRootAgent: overrides.createRootAgent ?? session.createRootAgent,
    services: { ...session.services, ...overrides.services },
  })
  return { ctx, agent, terminal, exit, controller, commands }
}

describe('controller', () => {
  it('streams a session event roundtrip into the transcript', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello back' } } })
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('hello back')
    await controller.dispose()
  })
  it('ignores events from other sessions', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    ctx.emit('session/event', { id: 'other' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'foreign' }] } })
    await new Promise((r) => setTimeout(r, 30))
    expect(terminal.snapshot()).not.toContain('foreign')
    await controller.dispose()
  })
  it('submit dispatches followup when idle, steer when running', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    // Two separate input() calls, not one 'question\r' chunk: pi-tui's Editor
    // matches "enter" via matchesKey(data, 'enter'), which requires data to be
    // EXACTLY "\r" (dist/keys.js). A combined multi-char-plus-\r chunk fails
    // that exact match and falls through to Editor's plain-text insertion
    // branch instead, so onSubmit never fires. Verified empirically against
    // the real @earendil-works/pi-tui package; matches the established
    // pattern in tests/composer.spec.ts ('submit fires onSubmit with typed
    // text': term.input('hello'); term.input('\r')).
    terminal.input('question')
    terminal.input('\r')
    expect(agent.followups.length).toBe(1)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('steer this')
    terminal.input('\r')
    expect(agent.followups.length).toBe(2)
    await controller.dispose()
  })
  it('Ctrl+C cancels a running turn; on idle+empty requests exit', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('\x03')
    expect(agent.cancelled.length).toBe(1)
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' })
    terminal.input('\x03')
    await new Promise((r) => setTimeout(r, 10))
    expect(exit).toHaveBeenCalledWith(0)
    await controller.dispose()
  })
  it('two rapid idle+empty Ctrl+D presses request exit exactly once', async () => {
    // Regression (review round 1): requestExit had no re-entrancy guard, so
    // two calls to it would each independently run
    // dispose().then(() => exit(0)), double-invoking exit. Pins the guarded
    // contract — exit fires exactly once no matter how many idle-exit
    // presses land — with no await between the two presses.
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('\x04')
    terminal.input('\x04')
    await new Promise((r) => setTimeout(r, 10))
    expect(exit).toHaveBeenCalledTimes(1)
    await controller.dispose()
  })
  it('user exit prints the goodbye line after teardown, before exit(0)', async () => {
    const { terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('\x04')                       // idle + empty → requestExit
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    const snap = terminal.snapshot()
    expect(snap).toContain('stopped=1')
    expect(snap).toContain('To resume: dsh --profile talon, then /resume — session main')
    await controller.dispose()
  })
  it('plugin teardown prints NO goodbye', async () => {
    const { terminal, controller } = setup()
    await terminal.waitForFrame(0)
    await controller.dispose()
    expect(terminal.snapshot()).not.toContain('To resume:')
  })
  it('Ctrl+D while running flashes the interrupt-first hint instead of exiting (carryover 3)', async () => {
    // 80 cols: the flashed hint is 63 columns wide — at the default 60 the
    // Text component would word-wrap it across two buffer rows and the
    // single-row toContain below could never match.
    const { ctx, agent, terminal, exit, controller } = setup({ cols: 80 })
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    const before = terminal.frames
    terminal.input('\x04')
    await terminal.waitForFrame(before)
    expect(exit).not.toHaveBeenCalled()
    expect(terminal.snapshot()).toContain('press Esc to interrupt, then Ctrl+D to exit')
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' })
    await terminal.waitForFrame(terminal.frames)
    expect(terminal.snapshot()).not.toContain('press Esc to interrupt')
    await controller.dispose()
  })
  it('Esc cancels only while running', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('\x1b')
    expect(agent.cancelled.length).toBe(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('\x1b')
    expect(agent.cancelled.length).toBe(1)
    await controller.dispose()
  })
  it('dispose stops the terminal exactly once and detaches listeners', async () => {
    const { ctx, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    await controller.dispose()
    await controller.dispose() // idempotent
    const snap = terminal.snapshot()
    expect(snap).toContain('stopped=1')
    expect([...ctx.listeners.values()].flat().length).toBe(0)
  })
  it('ignores agent/status events for a different agent', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    // If this leaked through, `running` would flip true and the following
    // Ctrl+C would cancel instead of requesting exit (mirrors the
    // 'ignores events from other sessions' session/event test above).
    ctx.emit('agent/status', { agent: { ...agent, id: 'other' }, status: 'running' })
    terminal.input('\x03')
    await new Promise((r) => setTimeout(r, 10))
    expect(agent.cancelled.length).toBe(0)
    expect(exit).toHaveBeenCalledWith(0)
    await controller.dispose()
  })
  it('Ctrl+C with idle non-empty composer clears the text instead of exiting', async () => {
    const { terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    let before = terminal.frames
    terminal.input('draft')
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('draft')
    before = terminal.frames
    terminal.input('\x03')
    await terminal.waitForFrame(before)
    expect(exit).not.toHaveBeenCalled()
    expect(terminal.snapshot()).not.toContain('draft')
    await controller.dispose()
  })
  it('Ctrl+L forces a full render', async () => {
    const { terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const before = terminal.frames
    terminal.input('\x0c')
    await terminal.waitForFrame(before)
    expect(terminal.frames).toBeGreaterThan(before)
    await controller.dispose()
  })
  it('global keys yield while a panel is active (spec D5)', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    void controller.panels.enqueue({ create: () => new Text('panel', 0, 0), forced: () => ({ outcome: undefined }) })
    terminal.input('\x03')                       // Ctrl+C must NOT reach the exit path
    await new Promise((r) => setTimeout(r, 10))
    expect(exit).not.toHaveBeenCalled()
    expect(agent.cancelled.length).toBe(0)
    await controller.dispose()
  })
  it('agent/status while a panel is active keeps the waiting rule color, not streaming', async () => {
    const { ctx, agent, terminal, controller } = setup({ enabled: true }) // colors on: distinguish waiting (fg-3) from streaming (fg-13)
    await terminal.waitForFrame(0)
    void controller.panels.enqueue({ create: () => new Text('panel', 0, 0), forced: () => ({ outcome: undefined }) })
    agent.status = 'running'
    const before = terminal.frames
    ctx.emit('agent/status', { agent, status: 'running' })
    await terminal.waitForFrame(before)
    const snap = terminal.snapshot()
    expect(snap).toMatch(/style 0-\d+ fg-3\b/)   // warning tone: panel wins over running
    expect(snap).not.toMatch(/fg-13/)             // never the streaming/accent tone
    await controller.dispose()
  })
  it('a panel draining (PanelManager.onActiveChange(false)) returns the rule to streaming or idle per running', async () => {
    const { ctx, agent, terminal, controller } = setup({ enabled: true }) // colors on: distinguish streaming (fg-13) from idle (dim)
    await terminal.waitForFrame(0)

    let finish!: (outcome: undefined) => void
    let before = terminal.frames
    void controller.panels.enqueue<undefined>({
      create: (f) => { finish = f; return new Text('panel', 0, 0) },
      forced: () => ({ outcome: undefined }),
    })
    await terminal.waitForFrame(before)

    before = terminal.frames
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    await terminal.waitForFrame(before) // settle the (still-waiting) render before draining

    before = terminal.frames
    finish(undefined) // drains while running -> onActiveChange(false) should pick 'streaming'
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toMatch(/style 0-\d+ fg-13\b/)

    before = terminal.frames
    void controller.panels.enqueue<undefined>({
      create: (f) => { finish = f; return new Text('panel', 0, 0) },
      forced: () => ({ outcome: undefined }),
    })
    await terminal.waitForFrame(before)

    before = terminal.frames
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' })
    await terminal.waitForFrame(before)

    before = terminal.frames
    finish(undefined) // drains while idle -> onActiveChange(false) should pick 'idle'
    await terminal.waitForFrame(before)
    const snap = terminal.snapshot()
    expect(snap).toMatch(/style 0-\d+ dim\b/)
    expect(snap).not.toMatch(/fg-3\b/)
    expect(snap).not.toMatch(/fg-13/)

    await controller.dispose()
  })
  it('slash input routes to commands.execute, never to the model', async () => {
    const { agent, terminal, commands, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(commands.execute).toHaveBeenCalledOnce())
    expect(commands.execute.mock.calls[0]![1]).toBe('/status')
    expect(agent.followups.length).toBe(0)
    await controller.dispose()
  })
  it('unknown command renders a local warning notice', async () => {
    const { terminal, controller } = setup({ commands: { execute: vi.fn(async () => undefined) } })
    await terminal.waitForFrame(0)
    terminal.input('/nope extra args')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Unknown command: /nope'))
    await controller.dispose()
  })
  it('rejected execute renders a neutralized error notice', async () => {
    const { terminal, controller } = setup({ commands: { execute: vi.fn(async () => { throw new Error('handler exploded \x1b[31m') }) } })
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('handler exploded \\x1b[31m'))
    await controller.dispose()
  })
  it('a non-Error rejection reaches the notice through String(cause)', async () => {
    const { terminal, controller } = setup({ commands: { execute: vi.fn(async () => { throw 'plain boom' }) } })
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Command failed: plain boom'))
    await controller.dispose()
  })
  it('a command rejecting after dispose paints nothing into the stopped TUI', async () => {
    let fail: ((cause: unknown) => void) | undefined
    const { terminal, controller } = setup({ commands: { execute: vi.fn(() => new Promise<unknown>((_resolve, reject) => { fail = reject })) } })
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(fail).toBeDefined())
    await controller.dispose()
    fail!(new Error('late boom'))
    await new Promise((r) => setTimeout(r, 10))
    expect(terminal.snapshot()).not.toContain('late boom')
  })
  it('dispose aborts in-flight command signals', async () => {
    let captured: AbortSignal | undefined
    const { terminal, controller } = setup({ commands: { execute: vi.fn((_a: unknown, _l: string, signal: AbortSignal) => { captured = signal; return new Promise(() => {}) }) } })
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(captured).toBeDefined())
    await controller.dispose()
    expect(captured!.aborted).toBe(true)
  })
  it('registers the talon command set with live session status and drops it on dispose', async () => {
    const svc = dispatchingCommandService()
    const { ctx, agent, terminal, controller } = setup({ commands: { ...svc, list: () => [{ name: 'help', description: 'List available commands' }] } })
    const text = (name: string): string | undefined => (svc.handlers.get(name)!() as { text?: string }).text
    await terminal.waitForFrame(0)
    expect([...svc.handlers.keys()].sort()).toEqual(['clear', 'exit', 'help', 'quit', 'resume', 'status'])
    expect(text('status')).toBe(`session main\nworkspace ${process.cwd()}\nagent idle`)
    expect(text('help')).toBe('/help — List available commands')
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    expect(text('status')).toBe(`session main\nworkspace ${process.cwd()}\nagent running`)
    await controller.dispose()
    expect(svc.handlers.size).toBe(0) // the registration disposer rides in the controller's detachers
  })
  it('/exit while running cancels the turn first, then disposes and exits', async () => {
    // Ledger carry from Task 1: requestExit()'s running branch was dead code
    // until a command could reach it. /exit does — cancel -> whenIdle ->
    // dispose -> exit(0).
    const svc = dispatchingCommandService()
    const { ctx, agent, terminal, exit, controller } = setup({ commands: svc })
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('/exit')
    terminal.input('\r')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(agent.cancelled).toEqual([{ kind: 'user' }])
    await controller.dispose()
  })
  it('two /exit lines in the same tick still exit exactly once', async () => {
    // The re-entrancy guard's first reachable caller: exiting mid-turn defers
    // dispose() until whenIdle settles, so a second /exit still reaches
    // requestExit (the Ctrl+D twin above cannot — its dispose runs
    // synchronously and detaches the input listener first).
    const svc = dispatchingCommandService()
    const { ctx, agent, terminal, exit, controller } = setup({ commands: svc })
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('/exit')
    terminal.input('\r')
    terminal.input('/exit')
    terminal.input('\r')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(agent.cancelled.length).toBe(1)
    await controller.dispose()
  })
  it('/exit from idle logs a successful command — dispose never aborts its own run', async () => {
    // Regression (review round 1): dispose() aborted EVERY in-flight run,
    // including the /exit execution whose handler had just called it (the
    // idle branch disposes synchronously, inside `commands.execute`). dsh
    // re-checks the signal after the handler returns, so the successful exit
    // was logged as `command/done {kind:'error'}` — a red "This operation was
    // aborted" notice that live never paints (listener already detached) but
    // Task 16's replay does, breaking Ruling 5's live≡replay invariant.
    const svc = dispatchingCommandService()
    const { terminal, exit, controller } = setup({ commands: svc })
    await terminal.waitForFrame(0)
    terminal.input('/exit')
    terminal.input('\r')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(svc.log).toEqual(['command/run exit', 'command/done success'])
    await controller.dispose()
  })
  it('the slash menu lists whatever commands.list() answers at query time', async () => {
    const registry = [{ name: 'help', description: 'List available commands' }]
    const { terminal, controller } = setup({ commands: { list: () => registry } })
    await terminal.waitForFrame(0)
    terminal.input('/')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('List available commands'))
    await controller.dispose()
  })
  it('commands/change re-queries a visible menu instead of accepting into it', async () => {
    // The provider reads the registry through a closure (Ruling 4), so a new
    // command needs no provider rebuild — only a re-query of the open menu.
    const registry = [{ name: 'help', description: 'List available commands' }]
    const { ctx, terminal, controller } = setup({ commands: { list: () => registry } })
    await terminal.waitForFrame(0)
    terminal.input('/')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('List available commands'))
    registry.push({ name: 'status', description: 'Show session status' })
    ctx.emit('commands/change')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Show session status'))
    expect(terminal.snapshot()).toContain('| "/"') // the composer still holds a bare slash: nothing was accepted
    await controller.dispose()
  })
  it('Enter on a highlighted completion applies it and falls through to submit', async () => {
    // pi-tui applies the completion and then keeps going into its submit
    // branch for a '/'-prefixed prefix (editor.js:564), so accepting a command
    // RUNS it. applyCompletion's trailing space never reaches dsh:
    // submitValue() trims the line first (editor.js:1070).
    const registry = [{ name: 'status', description: 'Show session status' }]
    const { terminal, commands, agent, controller } = setup({ commands: { list: () => registry } })
    await terminal.waitForFrame(0)
    terminal.input('/st')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Show session status'))
    terminal.input('\r')
    await vi.waitFor(() => expect(commands.execute).toHaveBeenCalledOnce())
    expect(commands.execute.mock.calls[0]![1]).toBe('/status')
    expect(agent.followups.length).toBe(0)
    await controller.dispose()
  })
})

// One persisted listing behind `sessionQuery`, plus the projection services
// when a test wants the per-record title ladder instead of the batch rung.
const record = (id: string, cwd: string, over: { createdAt?: number; live?: boolean } = {}) =>
  ({ header: { id, createdAt: over.createdAt ?? 1000, cwd }, live: over.live ?? false, persisted: true })

const ROUTE_LOG = { events: [{ type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'chat' } } } }] }

describe('bindAgent / resume wiring', () => {
  // process.cwd/chdir are spied per test below — restore them so a later test
  // (and the worker itself) keeps the real working directory.
  afterEach(() => vi.restoreAllMocks())

  it('rebind replays the new session and routes input to the new agent', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const next = fakeAgent('next')
    next.session = { id: 'next', events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'old prompt' }], source: { kind: 'user' } } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old reply' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] }
    const before = terminal.frames
    controller.bindAgent(next as never)
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('old reply')
    ctx.emit('session/event', next.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'live after rebind' }], source: { kind: 'user' } } })
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('live after rebind'))
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'stale old-agent event' }], source: { kind: 'user' } } })
    await new Promise((r) => setTimeout(r, 30))
    expect(terminal.snapshot()).not.toContain('stale old-agent event')
    terminal.input('hello'); terminal.input('\r')
    expect(next.followups.length).toBe(1)
    expect(agent.followups.length).toBe(0)
    await controller.dispose()
  })

  it('/resume refuses while a turn is running', async () => {
    const { ctx, agent, terminal, controller } = setup({ commands: dispatchingCommandService() })
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('/resume')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Resume is not available while a turn is'))
    await controller.dispose()
  })

  it('/resume without a mounted session query says so', async () => {
    const { terminal, controller } = setup({ commands: dispatchingCommandService() })
    await terminal.waitForFrame(0)
    terminal.input('/resume')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Resume is not available: session query is not'))
    await controller.dispose()
  })

  it('/resume picks a foreign-workspace session: preflight, chdir, resume, rebind', async () => {
    // chdir is spied on EVERY resume test: a real chdir would move the whole
    // vitest worker out of the repo.
    const chdir = vi.spyOn(process, 'chdir').mockImplementation(() => {})
    vi.spyOn(process, 'cwd').mockReturnValue('/w')
    const resumed = fakeAgent('target')
    resumed.session = { id: 'target', events: [
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'resumed reply' }] } } },
    ] }
    const resume = vi.fn(async (_opts: { resumeSessionId: string }) => ({ agent: resumed }))
    const { terminal, controller } = setup({
      commands: dispatchingCommandService(),
      agents: { resume } as never,
      services: {
        // The full title ladder: a live session (live rung), a cached hit, and
        // one record left for the cold rung.
        sessionQuery: {
          listSessions: async () => [record('live-1', '/w', { createdAt: 300, live: true }), record('target', '/target', { createdAt: 200 }), record('cold-1', '/w', { createdAt: 100 })],
          readSession: async () => ROUTE_LOG,
          readTitleSnapshots: async () => { throw new Error('batch rung must not run when the cache ladder exists') },
        } as never,
        sessions: { get: (id: string) => (id === 'live-1' ? { events: [{ time: 900 }] } : undefined) },
        projections: { snapshot: () => ({ values: { title: 'Live title' } }) },
        projectionCache: {
          cachedSnapshot: (h: { id: string }) => (h.id === 'target' ? { values: { title: 'Fix the login flow' } } : undefined),
          coldSnapshot: async () => ({ values: { title: 'Cold title' } }),
        } as never,
      },
    })
    await terminal.waitForFrame(0)
    terminal.input('/resume')
    terminal.input('\r')
    // The default scope lists this workspace only: the cold-rung row proves
    // the ladder ran; the target itself lives elsewhere.
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Cold title'))
    expect(terminal.snapshot()).not.toContain('Fix the login flow')
    terminal.input('\t')        // scope → all workspaces (the target lives elsewhere)
    terminal.input('\x1b[B')    // down onto it
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Resumed session target · /target'))
    expect(chdir).toHaveBeenCalledWith('/target')
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: 'target' })
    expect(terminal.snapshot()).toContain('resumed reply')
    await controller.dispose()
  })

  it('a chdir failure leaves the old binding intact and renders the error', async () => {
    const chdir = vi.spyOn(process, 'chdir').mockImplementation(() => { throw new Error('ENOENT: no such directory') })
    vi.spyOn(process, 'cwd').mockReturnValue('/w')
    const resume = vi.fn(async (_opts: { resumeSessionId: string }) => ({ agent: fakeAgent('target') }))
    // No projection services here: the title ladder falls back to the single
    // readTitleSnapshots batch.
    const { agent, terminal, controller } = setup({
      commands: dispatchingCommandService(),
      agents: { resume } as never,
      services: {
        sessionQuery: {
          listSessions: async () => [record('target', '/w')],
          readSession: async () => ROUTE_LOG,
          readTitleSnapshots: async (ids: readonly string[]) => ids.map((sessionId) => ({ sessionId, status: 'fulfilled' as const, value: { title: { title: 'Batch title' } } })),
        } as never,
      },
    })
    await terminal.waitForFrame(0)
    terminal.input('/resume')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Batch title'))
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Resume failed: ENOENT: no such directory'))
    expect(chdir).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
    terminal.input('still here')
    terminal.input('\r')
    expect(agent.followups.length).toBe(1)   // the original agent is still the bound one
    await controller.dispose()
  })

  it('a failed candidate build closes the selector with an error notice', async () => {
    vi.spyOn(process, 'chdir').mockImplementation(() => {})
    const { terminal, controller } = setup({
      commands: dispatchingCommandService(),
      services: { sessionQuery: { listSessions: async () => { throw new Error('listing exploded') } } as never },
    })
    await terminal.waitForFrame(0)
    terminal.input('/resume')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Resume failed: listing exploded'))
    expect(terminal.snapshot()).not.toContain('Loading sessions')
    await controller.dispose()
  })

  it('teardown force-settles an open selector without resuming anything', async () => {
    const resume = vi.fn(async (_opts: { resumeSessionId: string }) => ({ agent: fakeAgent('target') }))
    const { terminal, controller } = setup({
      commands: dispatchingCommandService(),
      agents: { resume } as never,
      services: { sessionQuery: { listSessions: () => new Promise(() => {}) } as never },
    })
    await terminal.waitForFrame(0)
    terminal.input('/resume')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Loading sessions'))
    await controller.dispose()
    await new Promise((r) => setTimeout(r, 10))
    expect(resume).not.toHaveBeenCalled()
  })

  it('/clear mints a fresh session and binds it', async () => {
    const fresh = fakeAgent('fresh')
    const { terminal, controller } = setup({
      commands: dispatchingCommandService(),
      createRootAgent: async () => ({ agent: fresh }),
    })
    await terminal.waitForFrame(0)
    terminal.input('/clear')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Started a fresh session fresh'))
    terminal.input('after clear')
    terminal.input('\r')
    expect(fresh.followups.length).toBe(1)
    await controller.dispose()
  })

  it('/clear reports a failed creation, non-Error causes included', async () => {
    const { terminal, controller } = setup({
      commands: dispatchingCommandService(),
      createRootAgent: async () => { throw 'no agent factory registered' },
    })
    await terminal.waitForFrame(0)
    terminal.input('/clear')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('New session failed: no agent factory'))
    await controller.dispose()
  })

  it('/clear refuses while a turn is running', async () => {
    const { ctx, agent, terminal, controller } = setup({ commands: dispatchingCommandService() })
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('/clear')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('A fresh session is not available while a'))
    await controller.dispose()
  })
})
