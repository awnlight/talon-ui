import { describe, expect, it, vi } from 'vitest'
import { apply, disposeRootAndExit, installProcessGuards, type Context } from '../src/index.ts'

// Mirrors controller.spec.ts's fakeCtx style: a small helper returning just
// the structural shape these functions actually touch (`ctx.root.fiber.
// dispose()` — everything else on Context goes through an `as any` cast in
// the source, per index.ts's own doc comment).
function fakeCtx(dispose: () => Promise<void> = () => Promise.resolve()): Context {
  return { root: { fiber: { dispose } } } as unknown as Context
}

describe('apply()', () => {
  it('throws the TTY error when stdin/stdout are not TTYs', () => {
    // No mocking: the test runner's stdin/stdout are pipes, not TTYs
    // (verified: process.stdin.isTTY / stdout.isTTY are both falsy here).
    expect(process.stdin.isTTY).toBeFalsy()
    expect(process.stdout.isTTY).toBeFalsy()
    expect(() => apply({} as Context)).toThrow(/stdin and stdout must be TTYs/)
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
})
