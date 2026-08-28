/** T4's acceptance line, made executable: "全功能面逐项勾验" — every feature
 * surface ticked off one by one.
 *
 * This file is deliberately NOT a second copy of the per-feature tests. Each
 * surface has its own file that proves how it behaves; what this one proves is
 * that the surface is REACHABLE from a real controller with a realistic
 * composition — the failure mode a suite of well-tested units cannot catch is
 * a feature nobody wired up. */
import { describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

const idle = () => ({ id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve() })

/** A composition with every optional row T4 can use present, so "not composed"
 * can never be the reason a surface is missing here. */
function fullyComposed() {
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const ctx = {
    on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
    emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
  }
  const agent = { ...idle(), ctx }
  const handlers = new Map<string, () => unknown>()
  const terminal = new HeadlessTerminal(110, 26)
  const controller = createController({
    ctx, agent, terminal, palette: createPalette(true), exit: () => {},
    userQuestions: { registerProvider: () => () => {} },
    commands: {
      register: (definition: { name: string; handler: () => unknown }) => { handlers.set(definition.name, definition.handler); return () => handlers.delete(definition.name) },
      list: () => [...handlers.keys()].map((name) => ({ name, description: name })),
      execute: async () => undefined,
    },
    agents: { resume: async () => ({ agent: idle() }) },
    createRootAgent: async () => ({ agent: idle() }),
    readClipboardImage: async () => ({ mediaType: 'image/png' as const, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]) }),
    modelSelection: { current: { provider: 'deepseek', model: 'deepseek-chat' } },
    services: {
      sessions: { get: () => undefined },
      sessionQuery: {
        listSessions: async () => [{ header: { id: 's-old', createdAt: 1, cwd: process.cwd() }, live: false, persisted: true }],
        readSession: async () => undefined,
        readTitleSnapshots: async () => new Map(),
      } as never,
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        listModels: async () => [{ id: 'deepseek-reasoner', name: 'Reasoner' }],
        resolveModelInfo: async () => ({ context: { contextWindow: 128_000 }, reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
      },
      fileReferences: { list: async () => [{ path: 'src/app/controller.ts', kind: 'file' as const }] },
      attachments: { saveImages: async () => [{ id: 'att-1' }] },
      subagents: { listDescendants: async () => [{ kind: 'child' as const, id: 's-1', depth: 1, activity: 'running' as const, mode: 'continuable' as const, label: 'reviewer' }] },
      settings: { register: () => ({ get: () => ({}), watch: () => () => {}, update: async () => {} }) },
    },
  } as never)
  const send = (type: string, data: unknown) => ctx.emit('session/event', agent.session, { type, data })
  const type_ = async (keys: string[]): Promise<void> => {
    for (const key of keys) {
      const before = terminal.frames
      terminal.input(key)
      await terminal.waitForFrame(before)
    }
  }
  return { ctx, agent, terminal, controller, handlers, send, type: type_ }
}

describe('T4 acceptance — every surface reachable from a real controller', () => {
  it('registers every command the spec names for v1', async () => {
    const { controller, handlers, terminal } = fullyComposed()
    await terminal.waitForFrame(0)
    // spec §3.5's v1 set, minus /details (T4's own ruling 3 in the T3 plan
    // deferred it) — every other name must be here.
    for (const name of ['help', 'model', 'clear', 'palette', 'resume', 'status', 'agents', 'exit', 'quit']) {
      expect(handlers.has(name), `/${name}`).toBe(true)
    }
    await controller.dispose()
  })

  it('opens the /model selector on the live catalog', async () => {
    const { controller, handlers, terminal } = fullyComposed()
    await terminal.waitForFrame(0)
    handlers.get('model')!()
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Reasoner'))
    await controller.dispose()
  })

  it('opens the /agents tree', async () => {
    const { controller, handlers, terminal } = fullyComposed()
    await terminal.waitForFrame(0)
    handlers.get('agents')!()
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('reviewer'))
    await controller.dispose()
  })

  it('completes @file from the workspace and @@ from the session store', async () => {
    const files = fullyComposed()
    await files.terminal.waitForFrame(0)
    await files.type([...'@src'])
    await vi.waitFor(() => expect(files.terminal.snapshot()).toContain('controller.ts'))
    await files.controller.dispose()

    const sessions = fullyComposed()
    await sessions.terminal.waitForFrame(0)
    await sessions.type([...'@@s'])
    await vi.waitFor(() => expect(sessions.terminal.snapshot()).toContain('s-old'))
    await sessions.controller.dispose()
  })

  it('sets the window title from the session, and notifies an unfocused terminal on turn end', async () => {
    const { controller, terminal, send } = fullyComposed()
    await terminal.waitForFrame(0)
    const written: string[] = []
    const realWrite = terminal.write.bind(terminal)
    terminal.write = (data: string) => { written.push(data); realWrite(data) }

    const before = terminal.frames
    send('session/title', { title: 'Fix the login flow', messageSeqs: [], source: { kind: 'llm' } })
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('title "Fix the login flow"')

    send('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await new Promise((r) => setTimeout(r, 20))
    expect(written.some((data) => data.includes('\x1b]9;'))).toBe(true)
    await controller.dispose()
  })

  it('attaches a pasted image as a mention', async () => {
    const { controller, terminal } = fullyComposed()
    await terminal.waitForFrame(0)
    const before = terminal.frames
    terminal.input('\x16')
    await terminal.waitForFrame(before)
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('@image:att-1'))
    await controller.dispose()
  })

  it('renders a workflow run from its durable record, and the live subagent badge', async () => {
    const { ctx, agent, controller, terminal, send } = fullyComposed()
    await terminal.waitForFrame(0)
    let before = terminal.frames
    send('tool-workflow/run-start', { runId: 'r1', name: 'review-changes' })
    send('tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'review:bugs', phase: 'Review', childId: 'c' })
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('workflow · review-changes')
    expect(terminal.snapshot()).toContain('review:bugs')

    before = terminal.frames
    ctx.emit('subagent/start', {}, agent)
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('⚙ 1 agent')
    await controller.dispose()
  })

  it('keeps the T3 surfaces working alongside the T4 ones', async () => {
    const { controller, terminal, send } = fullyComposed()
    await terminal.waitForFrame(0)
    const before = terminal.frames
    send('user/message', { content: [{ type: 'text', text: 'Run it.' }], source: { kind: 'user' } })
    send('request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 1000 })
    send('assistant/message', {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: '# Done\n\n- one' }] },
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 },
    })
    send('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls","description":"list"}' })
    send('tool/result', { turn: 1, step: 1, message: { content: [{ toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb' }] }] } })
    await terminal.waitForFrame(before)
    const snapshot = terminal.snapshot()
    expect(snapshot).toContain('◆ bash · ls · list')      // T3 tool card
    expect(snapshot).toContain('Done')                    // T3 markdown
    expect(snapshot).toContain('cache 75%')               // T3 footer metrics
    expect(terminal.themeViolations()).toEqual([])        // T3 theme discipline
    await controller.dispose()
  })
})
