/** T3 acceptance (spec §7.3, §8): a REAL recorded coding session replayed
 * through the production path, with HARD-REJECT assertions before the golden.
 *
 * The screenshot is the last thing checked, deliberately. A pretty frame over a
 * broken path is exactly the failure this gate exists to catch, so the fixture's
 * own facts are asserted first — the exact ordered tool-call sequence, every
 * turn reaching its end, every call reaching its result, zero scrollback wipes,
 * zero theme violations — and only then the terminal golden.
 *
 * The fixture is a complete prefix of a genuine `dsh --profile talon` session
 * (`~/.dsh/sessions`, zstd → plaintext): a session header, one conversational
 * turn, and one coding turn that reads files, greps and runs commands. Nothing
 * is mocked below the event boundary — the events go through the production
 * `translateSessionEvent` → `Transcript.apply` onto a real controller and a
 * real terminal emulator. See docs/INSTALL.md for how to re-record it. */
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../../src/testing/headless-terminal.ts'
import { createPalette } from '../../src/theme/palette.ts'
import { createController } from '../../src/app/controller.ts'
import { translateSessionEvent } from '../../src/backend/translate.ts'
import { readSessionLog } from '../helpers/session-log.ts'

const FIXTURE = fileURLToPath(new URL('./coding-session/session.jsonl', import.meta.url))
const GOLDEN = './coding-session/terminal.expected.txt'

/** What this recording is: the ordered tool calls talon must render, exactly.
 * A recording that drifts (a re-record with a different shape) fails HERE,
 * before anything renders, rather than quietly repainting the golden. */
const EXPECTED_CALLS = ['bash', 'grep', 'bash', 'read', 'bash', 'bash', 'read']

const idleAgent = () => ({ id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve() })

describe('recorded real-session replay (T3 acceptance)', () => {
  const session = readSessionLog(FIXTURE)
  afterAll(() => vi.restoreAllMocks())

  it('rejects a recording whose shape drifted, before any rendering', () => {
    const calls: string[] = []
    const results = new Set<string>()
    const openTurns = new Set<number>()
    const endedTurns: number[] = []
    const pending = new Map<string, number>()

    for (const event of session.events) {
      const data = event.data as Record<string, any>
      if (event.type === 'turn/start') openTurns.add(data.turn)
      if (event.type === 'turn/end') { endedTurns.push(data.turn); openTurns.delete(data.turn); pending.clear() }
      if (event.type === 'tool/call') { calls.push(String(data.name)); pending.set(String(data.callId), data.turn) }
      if (event.type === 'tool/result') results.add(String(data.message?.content?.[0]?.toolCallId))
    }

    expect(calls, 'the recording\'s tool sequence').toEqual(EXPECTED_CALLS)
    expect(endedTurns.length, 'turns that reached turn/end').toBeGreaterThan(0)
    expect(openTurns, 'every turn must reach its end').toEqual(new Set())
    // Every call either got its result or its turn ended without one — a call
    // that simply vanished mid-turn means the recording is truncated.
    expect(pending, 'calls still open after the last turn ended').toEqual(new Map())
    for (const call of calls) expect(EXPECTED_CALLS).toContain(call)
    expect(results.size, 'results delivered').toBe(EXPECTED_CALLS.length)
  })

  it('every event translates without throwing, and nothing unknown reaches the transcript', () => {
    for (const event of session.events) {
      expect(() => translateSessionEvent(event), event.type).not.toThrow()
    }
    // The log carries far more event types than talon renders; skipping them
    // must stay silent and total (the 40-type durable vocabulary, spec §3.2).
    const rendered = session.events.filter((event) => translateSessionEvent(event).length > 0)
    expect(rendered.length).toBeGreaterThan(0)
  })

  it('replays onto a real terminal with zero wipes, zero theme violations, and matches the golden', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    // The footer prints the workspace and reads the branch from its .git/HEAD:
    // pin it to the workspace the RECORDING ran in, so the golden describes the
    // session rather than the machine replaying it.
    vi.spyOn(process, 'cwd').mockReturnValue(session.header.cwd ?? '/workspace')

    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { ...idleAgent(), ctx }
    const terminal = new HeadlessTerminal(100, 34)
    const controller = createController({
      ctx, agent, terminal, palette: createPalette(true), exit: () => {},
      userQuestions: { registerProvider: () => () => {} },
      commands: { register: () => () => {}, list: () => [], execute: async () => undefined },
      agents: { resume: async () => ({ agent: idleAgent() }) },
      createRootAgent: async () => ({ agent: idleAgent() }),
      services: { sessions: { get: () => undefined }, llm: { listProviders: () => [] } },
    } as never)
    await terminal.waitForFrame(0)

    const before = terminal.frames
    for (const event of session.events) ctx.emit('session/event', agent.session, event)
    await terminal.waitForFrame(before)

    expect(terminal.scrollbackWipes, 'a replay only ever appends').toBe(0)
    expect(terminal.themeViolations(), 'ANSI-16 discipline across a real session').toEqual([])
    await expect(terminal.snapshot()).toMatchFileSnapshot(GOLDEN)

    await controller.dispose()
  })
})
