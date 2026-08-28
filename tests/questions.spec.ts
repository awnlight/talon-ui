import { describe, expect, it, vi } from 'vitest'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { attachQuestionProvider, cancelledError } from '../src/backend/questions.ts'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

/** The Cordis waterfall dsh 0.1.2-alpha.1 moved questions onto — the same one
 * approvals use. `ask` invokes the registered answerers in order, exactly as
 * `UserQuestionService.ask` does. */
function fakeWaterfall() {
  const listeners: ((req: unknown, next: () => Promise<unknown>) => unknown)[] = []
  return {
    listeners,
    on(event: string, fn: (req: unknown, next: () => Promise<unknown>) => unknown) {
      if (event !== 'user-questions/request') throw new Error(`unexpected event ${event}`)
      listeners.push(fn)
      return () => listeners.splice(listeners.indexOf(fn), 1)
    },
    /** Drive the waterfall; `fell-through` stands in for the service's own
     * NO_PROVIDER rejection so a test can see that nobody claimed. */
    async ask(request: unknown): Promise<unknown> {
      const next = async (): Promise<unknown> => 'fell-through'
      for (const listener of listeners) return await listener(request, next)
      return 'fell-through'
    },
  }
}

const BOUND = { id: 'main' }

describe('question answerer wiring (the dsh 0.1.2 waterfall)', () => {
  const deps = (present: () => Promise<never>) => ({ isBound: (agent: unknown) => agent === BOUND, present })

  it('claims the BOUND agent\'s request and answers it', async () => {
    const events = fakeWaterfall()
    const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
    attachQuestionProvider(events as never, deps(async () => answer as never))
    await expect(events.ask({ questions: [], agent: BOUND })).resolves.toBe(answer)
  })

  it('answers an AGENT-LESS request too — the one UI in the process owns it', async () => {
    const events = fakeWaterfall()
    const answer = { answers: [] }
    attachQuestionProvider(events as never, deps(async () => answer as never))
    await expect(events.ask({ questions: [] })).resolves.toBe(answer)
  })

  it('passes ANOTHER agent\'s request on, untouched', async () => {
    const events = fakeWaterfall()
    let presented = 0
    attachQuestionProvider(events as never, deps(async () => { presented += 1; return {} as never }))
    await expect(events.ask({ questions: [], agent: { id: 'other' } })).resolves.toBe('fell-through')
    expect(presented).toBe(0)
  })

  it('passes on a request that is already aborted, rather than mounting a panel for it', async () => {
    const events = fakeWaterfall()
    let presented = 0
    attachQuestionProvider(events as never, deps(async () => { presented += 1; return {} as never }))
    const controller = new AbortController()
    controller.abort()
    await expect(events.ask({ questions: [], agent: BOUND, signal: controller.signal })).resolves.toBe('fell-through')
    expect(presented).toBe(0)
  })

  it('detaches on dispose', async () => {
    const events = fakeWaterfall()
    const off = attachQuestionProvider(events as never, deps(async () => ({ answers: [] }) as never))
    expect(events.listeners).toHaveLength(1)
    off()
    expect(events.listeners).toHaveLength(0)
    await expect(events.ask({ questions: [], agent: BOUND })).resolves.toBe('fell-through')
  })

  it('cancelledError() carries the exact ASK_CANCELLED code and message (Ruling 7)', () => {
    const err = cancelledError()
    expect(err).toBeInstanceOf(UserQuestionError)
    expect(err.code).toBe('ASK_CANCELLED')
    expect(err.message).toBe('the user cancelled ask_user_question')
  })
})

// Controller-level fakes mirror tests/controller.spec.ts's fakeCtx/fakeAgent/setup
// (tests/approval.spec.ts's precedent for a per-backend spec file owning its own
// controller-level flow tests, rather than growing tests/controller.spec.ts).
// Questions now ride the SAME ctx waterfall approvals do (dsh 0.1.2-alpha.1),
// so the fake ctx below carries an `ask()` that drives it, exactly as
// `UserQuestionService.ask` drives the real one.
function fakeCtx() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    listeners,
    on(event: string, fn: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(fn), 1)
    },
    emit(event: string, ...args: unknown[]) { for (const fn of listeners.get(event) ?? []) fn(...args) },
    /** What `ctx.userQuestions.ask` does: run the answerer waterfall. */
    async ask(request: unknown): Promise<unknown> {
      const next = async (): Promise<unknown> => { throw new UserQuestionError('no user-questions answerer accepted the request', 'NO_PROVIDER') }
      for (const fn of listeners.get('user-questions/request') ?? []) {
        return await (fn as unknown as (r: unknown, n: () => Promise<unknown>) => Promise<unknown>)(request, next)
      }
      return await next()
    },
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
// Task 16's session-switching deps: this file drives no /resume or /clear, so
// an inert set (no sessionQuery at all) satisfies ControllerDeps.
const sessionDeps = {
  agents: { resume: async () => ({ agent: fakeAgent('resumed') }) },
  createRootAgent: async () => ({ agent: fakeAgent('fresh') }),
  services: { sessions: { get: () => undefined }, llm: { listProviders: () => [] } },
}

function setup() {
  const ctx = fakeCtx()
  const agent = fakeAgent()
  agent.ctx = ctx
  const terminal = new HeadlessTerminal(60, 14)
  const exit = vi.fn()
  // No slash-command flow here (see tests/controller.spec.ts) — a no-op registry stub satisfies ControllerDeps.
  const commands = { register: () => () => {}, list: () => [], execute: async () => undefined }
  const controller = createController({ ctx, agent, terminal, palette: createPalette(false), exit, commands, ...sessionDeps })
  return { ctx, agent, terminal, exit, controller }
}

describe('questions through the controller', () => {
  it('answers a 2-question request end-to-end, one panel session for the whole request', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const request = {
      questions: [
        { id: 'q1', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: 'Second?', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    }
    const outcome = ctx.ask({ ...request, agent })
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()
    terminal.input('\r') // q1: cursor defaults to option 0 -> 'A'
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined() // still the same panel session, now on q2
    terminal.input('\r') // q2: cursor defaults to option 0 -> 'C'
    await expect(outcome).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['C'] }] })
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('Esc rejects the whole request with ASK_CANCELLED (the exact code plan-mode narrows on)', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const outcome = ctx.ask({ questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }], agent })
    await terminal.waitForFrame(terminal.frames)
    terminal.input('\x1b')
    await expect(outcome).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('signal abort mid-display force-closes the panel and rejects with ASK_CANCELLED', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const ctl = new AbortController()
    const outcome = ctx.ask({ questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }], signal: ctl.signal, agent })
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()
    ctl.abort()
    await expect(outcome).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
})
