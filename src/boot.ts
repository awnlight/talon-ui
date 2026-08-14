/** talon-boot: creates the root agent the talon-ui plugin presents.
 * Separation is deliberate (host owns the agent; UI only renders — the
 * dedicated-front-door decision, spec §2).
 *
 * No '@deepseek-ai/cordis' import here (controller ruling): `BootContext` is
 * a minimal local structural type covering only the member this file reads.
 * `AgentRegistry`/`SessionId` come from the real dsh packages so the
 * `agents.create`/`agents.roots` call below typechecks against dsh's actual
 * signatures, not a hand-rolled guess.
 *
 * Timing: dsh's Cordis fork has no 'ready' lifecycle event — there is no
 * `'ready'` key in vendor/cordis/src/events.ts's `Events` interface, and no
 * `ctx.on('ready', ...)` call anywhere under deepseek-harness/packages. Real
 * root-agent creators call `agents.create` directly from `apply` instead,
 * relying on `inject` to guarantee the service exists first — e.g.
 * dsh-headless (packages/bundle/headless/src/index.ts:96-119, apply at 141-150)
 * and the ACP bridge (packages/acp/acp/src/index.ts:105-108, `const agents =
 * ctx.agents` captured directly in `apply`). This file follows that
 * precedent for *timing* only: `apply` calls `agents.create` directly rather
 * than deferring to an event.
 *
 * Unlike this file, dsh-headless's own `apply` is void-returning and
 * manually swallows failure (`void run(...).catch(fail)` at
 * packages/bundle/headless/src/index.ts:149) because it owns a process exit
 * code to report through `io.exit`. This file has no such reporting surface,
 * so `apply` is `async` and lets a rejected `agents.create` propagate
 * instead of catching it locally. The rejection is not unhandled: Cordis's
 * own fiber loader awaits every plugin callback and catches there —
 * `_execute` (vendor/cordis/src/fiber.ts:356-374) invokes the callback and,
 * when it returns a thenable, chains `.then(safeCollect)` with no catch of
 * its own; `_reload` (vendor/cordis/src/fiber.ts:646-663) is what actually
 * awaits that call inside a `try/catch`, and on rejection logs via
 * `this.ctx.logger.error(reason)` (line 661) and records `this._error`
 * (line 660), which the fiber's `state` getter (line 576) then reports as
 * `FiberState.FAILED`. That fiber-level catch is this file's rejection
 * safety net, not dsh-headless's manual `.catch`.
 */
import type { AgentRegistry, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Minimal structural shape of the Cordis plugin context this file needs.
 * `get` mirrors cordis Context.get: undefined when a service is absent. */
export interface BootContext {
  agents: AgentRegistry
  get(name: string): unknown
}

export const name = 'talon-boot'
// 'agentLoop' is a real dependency, not just 'agents': AgentRegistry.create
// throws 'no agent factory registered' until AgentLoop's constructor has run
// (it calls ctx.agents.setFactory(this) — packages/core/agent-loop/src/
// index.ts:350). dsh-base mounts 'agent' (the registry) far earlier than
// 'agent-loop' (near the end of its insert list, gated on AgentLoop's own
// `static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']` —
// index.ts:297), so a plugin injecting only 'agents' can activate and call
// create() before the factory is registered — confirmed live: `dsh
// --profile talon` failed with exactly "no agent factory registered (load
// an agent-loop plugin)" until 'agentLoop' was added here (Task 10 boot
// smoke). Injecting it forces Cordis to wait for AgentLoop's constructor
// (and its synchronous setFactory effect) to complete first.
export const inject = ['agents', 'agentLoop'] as const

export interface Config { sessionId?: string }

/**
 * Create the root agent talon-ui presents, unless one already exists under
 * the configured session id.
 * @param ctx - Cordis context carrying the agent registry and agent-loop
 *   factory (see `inject`).
 * @param config - `sessionId` defaults to a fresh UUID per boot: dsh
 *   persists one log per session id, so a fixed default collides with the
 *   previous run's persisted log ("id collision" turn errors). Set it only
 *   to pin a specific session deliberately.
 */
/**
 * Void-returning by necessity, not style: `run()` awaits `loader.await()`,
 * which resolves only after EVERY entry (including talon-boot itself)
 * activates — an async `apply` awaiting it would deadlock the boot
 * (dsh-headless hit the same constraint; its apply detaches `void
 * run(...).catch(fail)` at packages/bundle/headless/src/index.ts:149).
 * A boot failure here is fatal and pre-raw-mode, so print and exit(1).
 */
export function apply(ctx: BootContext, config: Config = {}): void {
  void run(ctx, config).catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
    process.stderr.write(`talon-boot: fatal: ${detail}\n`)
    process.exit(1)
  })
}

async function run(ctx: BootContext, config: Config): Promise<void> {
  // Let the whole plugin tree settle before creating the agent, so llm
  // adapters/tools/skills are not half-composed (dsh-headless precedent,
  // packages/bundle/headless/src/index.ts:99). Absent outside Loader boots.
  await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
  const sessionId = SessionId(config.sessionId ?? `session-${crypto.randomUUID()}`)
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing) return
  // Model selection: dsh-base's agent-default-model row supplies the
  // transport-independent default (settings-overridable). Without it the
  // request waterfall has no provider/model and every turn errors — fail
  // loud naming the missing row instead (dsh-headless reads the same
  // service, packages/bundle/headless/src/index.ts:101-118).
  const defaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): { provider: string; model: string } }
    | undefined
  if (defaultModel === undefined) {
    throw new Error('talon-boot: missing agentDefaultModel service — compose @deepseek-ai/dsh-agent-default-model (dsh-base provides it)')
  }
  const selection = defaultModel.currentSelection()
  // Dynamic import: this is a runtime value from dsh resolved inside the
  // dsh process (profile module fallback); a static import would force
  // vitest to resolve dsh's whole runtime graph just to load the plugin
  // shape in unit tests.
  const { installModelSelection } = (await import('@deepseek-ai/dsh-agent')) as unknown as {
    installModelSelection(agentCtx: unknown, ref: ModelSelectionRef): () => void
  }
  await ctx.agents.create({
    sessionId,
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      // Same ref the /model picker will mutate later (spec §3.7).
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
}
