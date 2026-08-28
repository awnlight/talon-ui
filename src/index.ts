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
import { readFileSync } from 'node:fs'
import { ProcessTerminal, getCapabilities } from '@earendil-works/pi-tui'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createController } from './app/controller.js'
import { createRootAgent, resumeRootAgent } from './boot.js'
import { createPalette, displayText } from './theme/palette.js'

/** Minimal structural shape of the Cordis plugin context this file needs. */
export interface Context {
  agents: AgentRegistry
}

export const name = 'talon-ui'
// 'llm' joins the required set for the resume preflight's provider check
// (spec D8); sessionQuery and the projection services stay ctx.get optionals
// (spec §3.1) — /resume degrades to a notice or a cheaper title ladder.
export const inject = ['agents', 'sessions', 'userQuestions', 'approval', 'commands', 'llm'] as const

export interface Config { sessionId?: string }

/** talon's own version, for the boot banner. `../package.json` resolves to the
 * repo root from BOTH `src/index.ts` and the built `lib/index.js`, so one
 * expression serves source and package alike. A banner is not worth failing a
 * boot over: an unreadable manifest simply drops the segment. */
export function readVersion(manifestUrl: URL = new URL('../package.json', import.meta.url)): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

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
  // No sessionId configured -> bind the first root agent (talon-boot mints a
  // fresh UUID per run, so a fixed shared default cannot work). A configured
  // id binds that exact session only — keep it in sync with talon-boot's.
  const sessionId = config.sessionId
  const enabled = process.env.NO_COLOR === undefined
  const anyCtx = ctx as any

  /* v8 ignore start -- live TTY mount: ProcessTerminal + Cordis effect wiring cannot run off-TTY; exercised end-to-end by tests/e2e/tty-smoke (real PTY boot, T2 Task 20) */
  const start = (agent: any): void => {
    anyCtx.effect(() => {
      const terminal = new ProcessTerminal()
      const removeGuards = installProcessGuards(ctx)
      const controller = createController({
        ctx: anyCtx,
        agent,
        terminal,
        palette: createPalette(enabled, 'dark', getCapabilities().trueColor),
        userQuestions: anyCtx.userQuestions,
        commands: anyCtx.commands,
        // Not the bare registry: resume must carry the same model composition
        // the boot uses (dsh does not rehydrate agentOptions from the log, and
        // this composition's request waterfall supplies no provider/model
        // fallback), or every turn on the resumed agent errors — see
        // resumeRootAgent.
        agents: { resume: (opts: { resumeSessionId: string }) => resumeRootAgent(anyCtx, opts.resumeSessionId) },
        createRootAgent: () => createRootAgent(anyCtx),
        services: {
          // Optional by composition, every one of them: talon degrades rather
          // than failing when a row is absent (T4 ruling 2/7/8/10).
          fileReferences: anyCtx.get('fileReferences'),
          attachments: anyCtx.get('attachments'),
          subagents: anyCtx.get('subagents'),
          settings: anyCtx.get('settings'),
          sessionQuery: anyCtx.get('sessionQuery'),
          sessions: anyCtx.sessions,
          projections: anyCtx.get('sessionProjections'),
          projectionCache: anyCtx.get('sessionProjectionCache'),
          llm: anyCtx.llm,
        },
        version: readVersion(),
        exit: (code) => disposeRootAndExit(ctx, code),
      })
      return () => { removeGuards(); return controller.dispose() }
    }, 'talon-ui')
  }
  /* v8 ignore stop */

  const matches = (agent: any): boolean =>
    (sessionId === undefined || agent.id === sessionId) && anyCtx.agents.roots().includes(agent)
  const existing = anyCtx.agents.roots().find(matches)
  if (existing) { start(existing); return }
  const off = anyCtx.on('agent/created', ({ agent }: { agent: any }) => {
    if (!matches(agent)) return
    off()
    start(agent)
  })
}
