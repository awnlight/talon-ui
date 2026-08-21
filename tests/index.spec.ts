import { describe, expect, it, vi } from 'vitest'
import { apply, disposeRootAndExit, installProcessGuards, type Context } from '../src/index.ts'

// Mirrors controller.spec.ts's fakeCtx style: a small helper returning just
// the structural shape these functions actually touch (`ctx.root.fiber.
// dispose()` — everything else on Context goes through an `as any` cast in
// the source, per index.ts's own doc comment).
function fakeCtx(dispose: () => Promise<void> = () => Promise.resolve()): Context {
  return { root: { fiber: { dispose } } } as unknown as Context
}

// Fake Cordis-ish ctx for driving apply() past the TTY guard. `effect` only
// RECORDS the mount name — it deliberately never invokes the callback it's
// given, so the live-mount body (ProcessTerminal + createController, ignored
// for coverage — see index.ts's `start`) never actually runs; constructing a
// real ProcessTerminal / calling TuiMainScreen.start() against non-TTY test
// streams is exactly what the upfront TTY guard exists to prevent.
function fakeMountCtx() {
  const rootsList: { id: string }[] = []
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
  const mounted: string[] = []
  const ctx = {
    agents: { roots: () => rootsList },
    effect: (_fn: () => void, name: string) => { mounted.push(name) },
    on: (event: string, fn: (...a: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1) }
    },
    emit: (event: string, ...a: unknown[]) => { for (const fn of [...(listeners.get(event) ?? [])]) fn(...a) },
  }
  return { ctx, rootsList, mounted, listeners }
}

// `vi.spyOn(stream, 'isTTY', 'get')` requires the property to already exist
// as an accessor — it doesn't in this sandboxed test environment (stdin/
// stdout have no `isTTY` descriptor at all, own or inherited: spyOn throws
// "isTTY does not exist", verified empirically). Object.defineProperty works
// regardless of whether the property pre-exists, so use that instead and
// restore the original descriptor (or delete it back out) afterward.
function setTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(stream, 'isTTY')
  Object.defineProperty(stream, 'isTTY', { value, configurable: true })
  return () => {
    if (original) Object.defineProperty(stream, 'isTTY', original)
    else delete (stream as unknown as Record<string, unknown>).isTTY
  }
}

function withTTY<T>(fn: () => T): T {
  const restoreStdin = setTTY(process.stdin, true)
  const restoreStdout = setTTY(process.stdout, true)
  try {
    return fn()
  } finally {
    restoreStdin(); restoreStdout()
  }
}

describe('apply()', () => {
  it('throws the TTY error when stdin/stdout are not TTYs', () => {
    // No mocking: the test runner's stdin/stdout are pipes, not TTYs
    // (verified: process.stdin.isTTY / stdout.isTTY are both falsy here).
    expect(process.stdin.isTTY).toBeFalsy()
    expect(process.stdout.isTTY).toBeFalsy()
    expect(() => apply({} as Context)).toThrow(/stdin and stdout must be TTYs/)
  })
  it('apply refuses a non-TTY stdin/stdout with the documented message', () => {
    const restoreStdin = setTTY(process.stdin, false)
    const restoreStdout = setTTY(process.stdout, true)
    try {
      expect(() => apply({ agents: { roots: () => [] } } as never, {})).toThrow(/interactive terminal/)
    } finally {
      restoreStdin(); restoreStdout()
    }
  })
  it('mounts the first existing root agent immediately when no sessionId is configured', () => {
    withTTY(() => {
      const { ctx, rootsList, mounted } = fakeMountCtx()
      rootsList.push({ id: 'a' })
      apply(ctx as never, {})
      expect(mounted).toEqual(['talon-ui'])
    })
  })
  it('waits for agent/created, ignoring non-matching agents and agents not yet in roots, then mounts the matching one and stops listening', () => {
    withTTY(() => {
      const { ctx, rootsList, mounted, listeners } = fakeMountCtx()
      apply(ctx as never, { sessionId: 'target' })
      expect(mounted.length).toBe(0) // nothing existing yet: waiting on agent/created
      const other = { id: 'other' }
      rootsList.push(other)
      ctx.emit('agent/created', { agent: other })
      expect(mounted.length).toBe(0) // wrong id: not matched
      const notYetRooted = { id: 'target' }
      ctx.emit('agent/created', { agent: notYetRooted }) // matching id, but not (yet) in roots()
      expect(mounted.length).toBe(0)
      expect(listeners.get('agent/created')?.length).toBe(1) // still listening after two misses
      const target = { id: 'target' }
      rootsList.push(target)
      ctx.emit('agent/created', { agent: target })
      expect(mounted).toEqual(['talon-ui'])
      expect(listeners.get('agent/created')?.length).toBe(0) // off() detached the listener
    })
  })
})

describe('disposeRootAndExit', () => {
  it('calls exit exactly once with the code when dispose resolves', async () => {
    const ctx = fakeCtx(() => Promise.resolve())
    const exit = vi.fn() as unknown as (code: number) => never
    disposeRootAndExit(ctx, 3, exit)
    await new Promise((r) => setImmediate(r))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(3)
  })

  it('fires exactly once via the 5s timeout path when dispose never resolves', async () => {
    vi.useFakeTimers()
    try {
      const ctx = fakeCtx(() => new Promise<void>(() => {}))
      const exit = vi.fn() as unknown as (code: number) => never
      disposeRootAndExit(ctx, 7, exit)
      await vi.advanceTimersByTimeAsync(5000)
      expect(exit).toHaveBeenCalledTimes(1)
      expect(exit).toHaveBeenCalledWith(7)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not double-call exit when both the timeout and dispose settle', async () => {
    vi.useFakeTimers()
    try {
      let resolveDispose: () => void = () => {}
      const disposePromise = new Promise<void>((r) => { resolveDispose = r })
      const ctx = fakeCtx(() => disposePromise)
      const exit = vi.fn() as unknown as (code: number) => never
      disposeRootAndExit(ctx, 2, exit)
      await vi.advanceTimersByTimeAsync(5000) // timeout path fires first
      expect(exit).toHaveBeenCalledTimes(1)
      resolveDispose() // dispose settles late; must not fire exit again
      await vi.advanceTimersByTimeAsync(0)
      expect(exit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('installProcessGuards', () => {
  it('wires SIGTERM/SIGHUP/unhandledRejection/uncaughtException and the remover fully detaches them', () => {
    const ctx = fakeCtx()
    const before = {
      SIGTERM: process.listeners('SIGTERM'),
      SIGHUP: process.listeners('SIGHUP'),
      unhandledRejection: process.listeners('unhandledRejection'),
      uncaughtException: process.listeners('uncaughtException'),
    }
    const remove = installProcessGuards(ctx)
    try {
      for (const event of ['SIGTERM', 'SIGHUP', 'unhandledRejection', 'uncaughtException'] as const) {
        const added = process.listeners(event).filter((l) => !before[event].includes(l))
        expect(added.length).toBe(1) // exactly one new guard registered, nothing emitted/delivered
      }
    } finally {
      remove()
    }
    expect(process.listeners('SIGTERM')).toEqual(before.SIGTERM)
    expect(process.listeners('SIGHUP')).toEqual(before.SIGHUP)
    expect(process.listeners('unhandledRejection')).toEqual(before.unhandledRejection)
    expect(process.listeners('uncaughtException')).toEqual(before.uncaughtException)
  })

  it('failLoud sanitizes hostile error text through displayText before writing stderr (I5)', async () => {
    const ctx = fakeCtx()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const remove = installProcessGuards(ctx)
    try {
      // Assert wiring + invoke the registered handler directly with a fake
      // error — never process.emit/kill a real signal or exception in-process.
      const handler = process.listeners('uncaughtException').at(-1) as (e: unknown) => void
      const evil = new Error('boom')
      evil.stack = 'Error: boom\n\x1b[31mhostile\x1b[0m'
      handler(evil)
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(written).toContain('boom')
      expect(written).not.toContain('\x1b[31m') // raw CSI never reaches stderr
      expect(written).toContain('\\x1b[31m') // displayText's escaped form does
      await new Promise((r) => setImmediate(r)) // let release()->exit settle before restoring mocks
    } finally {
      remove()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })

  it('onSignal releases and exits 0 on SIGTERM/SIGHUP', async () => {
    const ctx = fakeCtx()
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const remove = installProcessGuards(ctx)
    try {
      const handler = process.listeners('SIGTERM').at(-1) as () => void
      handler()
      await new Promise((r) => setImmediate(r))
      expect(exitSpy).toHaveBeenCalledWith(0)
    } finally {
      remove()
      exitSpy.mockRestore()
    }
  })

  it('failLoud falls back to String(cause) for a non-Error cause', async () => {
    const ctx = fakeCtx()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const remove = installProcessGuards(ctx)
    try {
      const handler = process.listeners('uncaughtException').at(-1) as (e: unknown) => void
      handler('boom-string')
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(written).toContain('boom-string')
      await new Promise((r) => setImmediate(r))
    } finally {
      remove()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })

  it('failLoud falls back to cause.message when the Error has no stack', async () => {
    const ctx = fakeCtx()
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const remove = installProcessGuards(ctx)
    try {
      const handler = process.listeners('unhandledRejection').at(-1) as (e: unknown) => void
      const noStack = new Error('no-stack-message')
      noStack.stack = undefined
      handler(noStack)
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
      expect(written).toContain('no-stack-message')
      await new Promise((r) => setImmediate(r))
    } finally {
      remove()
      stderrSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })
})
