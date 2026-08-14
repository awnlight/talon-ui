import { describe, expect, it, vi } from 'vitest'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { attachQuestionProvider, cancelledError } from '../src/backend/questions.ts'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

function fakeService() {
  let provider: { ask(req: unknown): Promise<unknown> } | undefined
  return {
    get provider() { return provider },
    registerProvider(p: { ask(req: unknown): Promise<unknown> }) {
      if (provider !== undefined) throw new UserQuestionError('a user-questions provider is already registered', 'DUPLICATE_PROVIDER')
      provider = p
      return () => { provider = undefined }
    },
  }
}

describe('question provider wiring', () => {
  it('registers and forwards ask() to the presenter', async () => {
    const svc = fakeService()
    const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
    attachQuestionProvider(svc as never, { present: async () => answer as never })
    await expect(svc.provider!.ask({ questions: [] })).resolves.toBe(answer)
  })
  it('unregisters on dispose', () => {
    const svc = fakeService()
    const off = attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })
    off()
    expect(svc.provider).toBeUndefined()
    expect(() => attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })).not.toThrow()
  })
  it('propagates DUPLICATE_PROVIDER loudly (composition error, fail loud)', () => {
    const svc = fakeService()
    attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })
    expect(() => attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })).toThrow(UserQuestionError)
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
// `userQuestions` reuses this file's own `fakeService()` — its shape
// (`registerProvider` capturing the live provider) is exactly the minimal
// facet `ControllerDeps.userQuestions` declares.
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
function setup() {
  const ctx = fakeCtx()
  const agent = fakeAgent()
  agent.ctx = ctx
  const terminal = new HeadlessTerminal(60, 14)
  const exit = vi.fn()
  const userQuestions = fakeService()
  const controller = createController({ ctx, agent, terminal, palette: createPalette(false), exit, userQuestions })
  return { ctx, agent, terminal, exit, controller, userQuestions }
}

describe('questions through the controller', () => {
  it('answers a 2-question request end-to-end, one panel session for the whole request', async () => {
    const { terminal, controller, userQuestions } = setup()
    await terminal.waitForFrame(0)
    const request = {
      questions: [
        { id: 'q1', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: 'Second?', options: [{ label: 'C' }, { label: 'D' }] },
      ],
    }
    const outcome = userQuestions.provider!.ask(request)
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
    const { terminal, controller, userQuestions } = setup()
    await terminal.waitForFrame(0)
    const outcome = userQuestions.provider!.ask({ questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }] })
    await terminal.waitForFrame(terminal.frames)
    terminal.input('\x1b')
    await expect(outcome).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('signal abort mid-display force-closes the panel and rejects with ASK_CANCELLED', async () => {
    const { terminal, controller, userQuestions } = setup()
    await terminal.waitForFrame(0)
    const ctl = new AbortController()
    const outcome = userQuestions.provider!.ask({ questions: [{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }], signal: ctl.signal })
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()
    ctl.abort()
    await expect(outcome).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
})
