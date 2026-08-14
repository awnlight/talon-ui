import { afterEach, describe, expect, it, vi } from 'vitest'
import * as boot from '../src/boot.ts'
import { apply } from '../src/boot.ts'

describe('talon-boot plugin shape', () => {
  it('exports Cordis plugin surface without default export', () => {
    expect(boot.name).toBe('talon-boot')
    expect(boot.inject).toEqual(['agents', 'agentLoop'])
    expect(typeof boot.apply).toBe('function')
    expect((boot as Record<string, unknown>).default).toBeUndefined()
  })
})

// Mocked by the tsconfig-mapped path, not the bare '@deepseek-ai/dsh-agent'
// specifier: vite-tsconfig-paths resolves the bare specifier to this exact
// file before vitest's mock registry gets a chance to match it, so a mock
// registered under the bare specifier is silently never hit and boot.ts's
// dynamic import falls through to loading the (type-only, unexecutable) .d.ts
// for real — verified empirically (fails with "Cannot find module
// './runtime-types.ts'", the same failure the dynamic-import design in
// boot.ts exists to avoid at *static*-import time). Mocking this resolved
// path directly intercepts it correctly.
vi.mock('../../deepseek-harness/packages/core/agent/lib/types/index.d.ts', () => ({ installModelSelection: vi.fn(() => () => {}) }))

function bootCtx(overrides: Partial<{ roots: unknown[]; services: Record<string, unknown> }> = {}) {
  const created: unknown[] = []
  const ctx = {
    created,
    agents: {
      roots: () => overrides.roots ?? [],
      create: vi.fn(async (opts: unknown) => { created.push(opts); return { agent: { id: (opts as any).sessionId }, dispose: async () => {} } }),
    },
    get: (name: string) => (overrides.services ?? {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })[name],
  }
  return ctx
}

describe('talon-boot run()', () => {
  afterEach(() => vi.restoreAllMocks())
  it('creates the root agent with cwd meta and the default model selection', async () => {
    const ctx = bootCtx()
    apply(ctx as never, {})
    await vi.waitFor(() => expect(ctx.agents.create).toHaveBeenCalledOnce())
    const opts = (ctx.created[0] as { sessionId: string; meta: { cwd: string }; agentOptions: { provider: string; model: string }; setup: (c: unknown) => void })
    expect(opts.sessionId).toMatch(/^session-/)
    expect(opts.meta.cwd).toBe(process.cwd())
    expect(opts.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    opts.setup({}) // exercises installModelSelection wiring
  })
  it('skips creation when the configured session already exists', async () => {
    const ctx = bootCtx({ roots: [{ id: 'pinned' }] })
    apply(ctx as never, { sessionId: 'pinned' })
    await new Promise((r) => setTimeout(r, 10))
    expect(ctx.agents.create).not.toHaveBeenCalled()
  })
  it('awaits the loader before creating', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const ctx = bootCtx({ services: {
      loader: { await: () => gate },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    } })
    apply(ctx as never, {})
    await new Promise((r) => setTimeout(r, 10))
    expect(ctx.agents.create).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(ctx.agents.create).toHaveBeenCalledOnce())
  })
  it('fails loud (stderr + exit 1) when agentDefaultModel is missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    apply(bootCtx({ services: {} }) as never, {})
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stderr.mock.calls.some(([s]) => String(s).includes('agentDefaultModel'))).toBe(true)
  })
  it('fails loud with a non-Error rejection cause (String(cause) fallback)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const ctx = bootCtx()
    ctx.agents.create = vi.fn(async () => { throw 'boom-string' }) as unknown as typeof ctx.agents.create
    apply(ctx as never, {})
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stderr.mock.calls.some(([s]) => String(s).includes('boom-string'))).toBe(true)
  })
  it('fails loud using cause.message when the Error has no stack (?? fallback)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const ctx = bootCtx()
    ctx.agents.create = vi.fn(async () => {
      const cause = new Error('no-stack-message')
      cause.stack = undefined
      throw cause
    }) as unknown as typeof ctx.agents.create
    apply(ctx as never, {})
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stderr.mock.calls.some(([s]) => String(s).includes('no-stack-message'))).toBe(true)
  })
})
