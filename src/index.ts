/** talon-ui: the Cordis plugin. TTY fail-loud (never silently downgrade —
 * recorded dsh decision), waits for the configured root agent, mounts the
 * controller as one ctx.effect, and owns process-level exit safety.
 *
 * No '@deepseek-ai/cordis' import here (controller ruling): mirrors
 * boot.ts's BootContext. This file's own code never reads `ctx.<member>` in
 * typed form either — every dsh-specific call (`.agents.roots()`, `.on(...)`,
 * `.effect(...)`, `.root.fiber`) goes through an `as any` cast below, so the
 * local `Context` interface only needs to name the one thing worth typing
 * for real: `agents`, reusing dsh-agent's actual `AgentRegistry` (available
 * without cordis, same as boot.ts). The type name `Context` is kept
 * (rather than importing boot.ts's `BootContext`) so every signature below
 * reads exactly as the task brief specifies, and so this plugin's types stay
 * decoupled from talon-boot's (separate plugins, per boot.ts's
 * dedicated-front-door decision). */
import { ProcessTerminal } from '@earendil-works/pi-tui'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createController } from './app/controller.js'
import { createPalette, displayText } from './theme/palette.js'

/** Minimal structural shape of the Cordis plugin context this file needs. */
export interface Context {
  agents: AgentRegistry
}

export const name = 'talon-ui'
export const inject = ['agents', 'sessions'] as const

export interface Config { sessionId?: string }

const ROOT_DISPOSE_TIMEOUT_MS = 5_000
const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

/**
 * Dispose the whole app (not just this plugin) and exit. `ctx.root.fiber.
 * dispose()` is the real, verified root-dispose path on dsh's Cordis fork
 * (controller ruling 5): `Context.root: this` (vendor/cordis/src/context.ts:22)
 * and `this.fiber = new Fiber(...)` (context.ts:77) give every context a
 * `.fiber`, and `Fiber.dispose: () => Promise<void>` (vendor/cordis/src/
 * fiber.ts:196). A real dsh plugin fixture calls this exact expression from
 * inside its own `apply(ctx)` to terminate the whole tree, and dsh's own
 * test suite asserts it actually tears the app down
 * (deepseek-harness/packages/boot/app-boot/tests/app-boot.spec.ts:696-698,
 * exercised by the test at :689-716).
 */
export function disposeRootAndExit(ctx: Context, code: number, exit: (code: number) => never = process.exit): void {
  let exited = false
  const exitOnce = (): void => { if (!exited) { exited = true; exit(code) } }
  const timer = setTimeout(exitOnce, ROOT_DISPOSE_TIMEOUT_MS)
  timer.unref?.()
  void Promise.resolve((ctx as any).root.fiber.dispose()).finally(exitOnce)
}

export function installProcessGuards(ctx: Context): () => void {
  const release = async (): Promise<void> => {
    await Promise.race([
      Promise.resolve((ctx as any).root.fiber.dispose()),
      new Promise((r) => setTimeout(r, FAIL_LOUD_RELEASE_TIMEOUT_MS)),
    ])
  }
  const failLoud = (label: string) => (cause: unknown): void => {
    // D7.8: cause.stack/message is untrusted (a thrown value can carry
    // arbitrary text, including OSC/CSI) — neutralize before it hits stderr.
    const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
    process.stderr.write(`talon-ui: ${label}: ${displayText(detail)}\n`)
    void release().finally(() => process.exit(1))
  }
  const onSignal = (): void => { void release().finally(() => process.exit(0)) }
  const rejection = failLoud('unhandled rejection')
  const exception = failLoud('uncaught exception')
  process.on('unhandledRejection', rejection)
  process.on('uncaughtException', exception)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  return () => {
    process.off('unhandledRejection', rejection)
    process.off('uncaughtException', exception)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('talon-ui requires an interactive terminal (stdin and stdout must be TTYs). Use dsh --profile headless for automation.')
  }
  const sessionId = config.sessionId ?? 'main'
  const enabled = process.env.NO_COLOR === undefined
  const anyCtx = ctx as any

  const start = (agent: any): void => {
    anyCtx.effect(() => {
      const terminal = new ProcessTerminal()
      const removeGuards = installProcessGuards(ctx)
      const controller = createController({
        ctx: agent.ctx ?? ctx,
        agent,
        terminal,
        palette: createPalette(enabled),
        exit: (code) => disposeRootAndExit(ctx, code),
      })
      return () => { removeGuards(); return controller.dispose() }
    }, 'talon-ui')
  }

  const matches = (agent: any): boolean => agent.id === sessionId && anyCtx.agents.roots().includes(agent)
  const existing = anyCtx.agents.roots().find(matches)
  if (existing) { start(existing); return }
  const off = anyCtx.on('agent/created', ({ agent }: { agent: any }) => {
    if (!matches(agent)) return
    off()
    start(agent)
  })
}
