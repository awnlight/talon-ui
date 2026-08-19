import { describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'
import { attachApprovalResponder } from '../src/backend/approval.ts'

type Listener = (req: unknown, next: () => Promise<string>) => unknown
function bus() {
  const listeners: Listener[] = []
  return {
    on: (_e: string, fn: Listener) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1) },
    dispatch: (req: unknown) => {
      const terminalNext = (): Promise<string> => Promise.resolve('unavailable')
      return Promise.resolve(listeners[0]!(req, terminalNext))
    },
  }
}
const AGENT = { id: 'main' }

describe('approval responder (D9)', () => {
  it('claims requests for the bound agent and presents them', async () => {
    const b = bus()
    const presented: unknown[] = []
    attachApprovalResponder(b, { isBound: (a) => a === AGENT, present: async (req) => { presented.push(req); return 'allowed-once' } })
    await expect(b.dispatch({ agent: AGENT, toolName: 'bash' })).resolves.toBe('allowed-once')
    expect(presented.length).toBe(1)
  })
  it('passes foreign-agent requests down the waterfall untouched (attribution filter)', async () => {
    const b = bus()
    let presented = 0
    attachApprovalResponder(b, { isBound: (a) => a === AGENT, present: async () => { presented += 1; return 'allowed-once' } })
    await expect(b.dispatch({ agent: { id: 'other' }, toolName: 'bash' })).resolves.toBe('unavailable')
    expect(presented).toBe(0)
  })
  it('answers cancelled for a pre-aborted signal without presenting', async () => {
    const b = bus()
    let presented = 0
    const ctl = new AbortController(); ctl.abort()
    attachApprovalResponder(b, { isBound: () => true, present: async () => { presented += 1; return 'allowed-once' } })
    await expect(b.dispatch({ agent: AGENT, toolName: 'bash', signal: ctl.signal })).resolves.toBe('cancelled')
    expect(presented).toBe(0)
  })
  it('detaches cleanly', () => {
    const b = bus()
    const off = attachApprovalResponder(b, { isBound: () => true, present: async () => 'allowed-once' })
    off()
    expect(() => off()).not.toThrow()
  })
})

// Controller-level fakes mirror tests/controller.spec.ts's fakeCtx/fakeAgent/setup,
// extended with emitWaterfall: the real service resolves listener return values
// (a waterfall), so this fake mirrors that instead of emit()'s fire-and-forget.
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
  // This file doesn't exercise user-questions flows (see tests/questions.spec.ts) — a no-op stub satisfies ControllerDeps.
  const userQuestions = { registerProvider: () => () => {} }
  // Nor slash commands (same) — a no-op registry stub satisfies ControllerDeps.
  const commands = { register: () => () => {}, list: () => [], execute: async () => undefined }
  const controller = createController({ ctx, agent, terminal, palette: createPalette(false), exit, userQuestions, commands })
  return { ctx, agent, terminal, exit, controller }
}

describe('approval through the controller', () => {
  it('FIFO-serializes two requests and enriches the preview from tool/call', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'rm -rf /tmp/x' } } })
    const first = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', callId: 'c1' })
    const second = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', callId: 'c2' })
    await terminal.waitForFrame(terminal.frames)
    expect(terminal.snapshot()).toContain('rm -rf /tmp/x')      // enriched from tool/call by callId
    terminal.input('1')
    await expect(first).resolves.toBe('allowed-once')
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()               // second request activated FIFO
    terminal.input('2')
    await expect(second).resolves.toBe('rejected')
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('signal abort mid-display closes the panel and answers cancelled', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const ctl = new AbortController()
    const outcome = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', signal: ctl.signal })
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()
    ctl.abort()
    await expect(outcome).resolves.toBe('cancelled')
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('teardown while a request is open rejects it (service normalizes to unavailable)', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const outcome = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash' })
    await terminal.waitForFrame(terminal.frames)
    await controller.dispose()
    await expect(outcome).rejects.toThrow('torn down')
  })
})
