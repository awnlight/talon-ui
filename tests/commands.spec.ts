// tests/commands.spec.ts
import { describe, expect, it } from 'vitest'
import { registerSessionCommands, registerTalonCommands } from '../src/backend/commands.ts'

function fakeCommands() {
  const defs = new Map<string, { name: string; description: string; handler: (i: { commandId: string; agent: unknown; rawInput: string; signal: AbortSignal }) => unknown }>()
  return {
    defs,
    register(def: never) {
      const d = def as never as { name: string }
      defs.set(d.name, def as never)
      return () => defs.delete(d.name)
    },
  }
}

describe('registerTalonCommands', () => {
  const deps = () => ({
    exits: 0,
    requestExit() { this.exits += 1 },
    statusLines: () => ['session s1', 'workspace /w', 'agent idle'],
    list: () => [{ name: 'help', description: 'List commands' }, { name: 'status', description: 'Show session status' }],
  })
  const invoke = { commandId: 'c', agent: {}, rawInput: '', signal: new AbortController().signal }
  it('registers the T2 set and disposes as one', () => {
    const svc = fakeCommands()
    const d = deps()
    const off = registerTalonCommands(svc as never, d)
    expect([...svc.defs.keys()].sort()).toEqual(['exit', 'help', 'quit', 'status'])
    off()
    expect(svc.defs.size).toBe(0)
  })
  it('help lists /name — description lines from deps.list()', async () => {
    const svc = fakeCommands()
    registerTalonCommands(svc as never, deps())
    const result = await svc.defs.get('help')!.handler(invoke) as { kind: string; text?: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('/help — List commands')
    expect(result.text).toContain('/status — Show session status')
  })
  it('status returns deps.statusLines()', async () => {
    const svc = fakeCommands()
    registerTalonCommands(svc as never, deps())
    const result = await svc.defs.get('status')!.handler(invoke) as { kind: string; text?: string }
    expect(result).toEqual({ kind: 'success', text: 'session s1\nworkspace /w\nagent idle' })
  })
  it('exit and quit share the requestExit handler', async () => {
    const svc = fakeCommands()
    const d = deps()
    registerTalonCommands(svc as never, d)
    await svc.defs.get('exit')!.handler(invoke)
    await svc.defs.get('quit')!.handler(invoke)
    expect(d.exits).toBe(2)
  })
})

describe('registerSessionCommands', () => {
  const invoke = { commandId: 'c', agent: {}, rawInput: '', signal: new AbortController().signal }
  const deps = () => ({
    opened: 0,
    fresh: 0,
    openResume() { this.opened += 1 },
    newSession() { this.fresh += 1 },
  })
  it('registers the session pair with its descriptions and disposes as one', () => {
    const svc = fakeCommands()
    const off = registerSessionCommands(svc as never, deps())
    expect([...svc.defs.values()].map((d) => [d.name, d.description])).toEqual([
      ['resume', 'Resume a previous session'],
      ['clear', 'Start a fresh session'],
    ])
    off()
    expect(svc.defs.size).toBe(0)
  })
  it('each handler starts its flow and reports success without text', async () => {
    const svc = fakeCommands()
    const d = deps()
    registerSessionCommands(svc as never, d)
    expect(await svc.defs.get('resume')!.handler(invoke)).toEqual({ kind: 'success' })
    expect(await svc.defs.get('clear')!.handler(invoke)).toEqual({ kind: 'success' })
    expect([d.opened, d.fresh]).toEqual([1, 1])
  })
})
