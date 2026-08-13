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
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Minimal structural shape of the Cordis plugin context this file needs. */
export interface BootContext {
  agents: AgentRegistry
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
 * @param ctx - Cordis context carrying the agent registry (`inject: ['agents']`
 *   guarantees `ctx.agents` is available before this runs).
 * @param config - `sessionId` defaults to `'main'`.
 */
export async function apply(ctx: BootContext, config: Config = {}): Promise<void> {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing) return
  await ctx.agents.create({ sessionId })
}
