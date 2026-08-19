import { describe, expect, it, vi } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

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
    session: { id },
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

// `enabled` toggles palette colors on (default off, matching every prior
// test's plain-text assertions). Only the waiting-color test below needs
// colors on, to tell the composer's rule-line state apart by SGR (mirrors
// composer.spec.ts's own fg-13/fg-3 convention).
function setup(overrides: { enabled?: boolean; commands?: Partial<ReturnType<typeof fakeCommandService>> } = {}) {
  const ctx = fakeCtx()
  const agent = fakeAgent()
  agent.ctx = ctx
  const terminal = new HeadlessTerminal(60, 14)
  const exit = vi.fn()
  // This file doesn't exercise user-questions flows (see tests/questions.spec.ts) — a no-op stub satisfies ControllerDeps.
  const userQuestions = { registerProvider: () => () => {} }
  const commands = { ...fakeCommandService(), ...overrides.commands }
  const controller = createController({ ctx, agent, terminal, palette: createPalette(overrides.enabled ?? false), exit, userQuestions, commands })
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
    expect([...svc.handlers.keys()].sort()).toEqual(['exit', 'help', 'quit', 'status'])
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
})
