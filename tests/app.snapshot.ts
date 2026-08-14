import { afterAll, describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'
import { checkpoint, expectObserved } from './helpers/checkpoint.ts'

const OWNED = ['conversation-roundtrip', 'approval-panel'] as const
afterAll(() => expectObserved(OWNED))

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
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {} })
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
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {} })
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
})
