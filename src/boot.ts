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
 * precedent: `apply` is itself async and calls `agents.create` directly.
 */
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Minimal structural shape of the Cordis plugin context this file needs. */
export interface BootContext {
  agents: AgentRegistry
}

export const name = 'talon-boot'
export const inject = ['agents'] as const

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
