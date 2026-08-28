/** The `/model` catalog (spec §3.7).
 *
 * `readModelChoices` is named after the old TUI's function, but that TUI is
 * deleted — there is nothing to import, so this builds the same thing from the
 * live seam: every provider crossed with its models, each route resolved for
 * its context window and its selectable reasoning efforts.
 *
 * Two rules make the selector trustworthy rather than merely complete:
 *   - the CURRENT target is appended even when the catalog omits it, so a
 *     hand-configured model never vanishes from its own selector; and
 *   - a provider or a route that fails to answer is DEGRADED, never fatal —
 *     one dead provider must not empty the list, and an unresolvable route
 *     still appears, just without its window and efforts. */

/** One selectable reasoning effort (`resolveModelInfo().reasoning.efforts`). */
export interface EffortChoice { id: string; name: string }

/** One flattened provider/model route the selector offers. */
export interface ModelChoice {
  provider: string
  providerName: string
  model: string
  name: string
  description: string | undefined
  contextWindow: number | undefined
  efforts: readonly EffortChoice[]
  defaultEffort: string | undefined
  /** Whether this route is the one currently selected. */
  current: boolean
}

/** What the agent is running right now (dsh's `ModelSelection`). */
export interface ModelTarget { provider: string; model: string; reasoningEffort?: string }

/** The slice of `ctx.llm` this module reads. */
export interface LlmCatalog {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string; description?: string }[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    context?: { contextWindow: number }
    reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string }
  }>
}

export function routeKey(provider: string, model: string): string { return `${provider}/${model}` }

export async function readModelChoices(
  llm: LlmCatalog,
  current: ModelTarget | undefined,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  const choices: ModelChoice[] = []
  for (const provider of llm.listProviders()) {
    // A provider that cannot list is skipped, not fatal: the others still work.
    const models = await llm.listModels(provider.id).catch(() => [])
    const resolved = await Promise.all(models.map(async (model) => {
      // An unresolvable route still belongs in the list — it just has no
      // window and no efforts to show.
      const info = await llm.resolveModelInfo(provider.id, model.id, signal).catch(() => undefined)
      return {
        provider: provider.id,
        providerName: provider.name,
        model: model.id,
        name: model.name,
        description: model.description,
        contextWindow: info?.context?.contextWindow,
        efforts: info?.reasoning?.efforts ?? [],
        defaultEffort: info?.reasoning?.defaultEffort,
        current: current !== undefined && current.provider === provider.id && current.model === model.id,
      }
    }))
    choices.push(...resolved)
  }
  if (current !== undefined && !choices.some((choice) => choice.current)) {
    choices.push({
      provider: current.provider,
      providerName: current.provider,
      model: current.model,
      name: current.model,
      description: undefined,
      contextWindow: undefined,
      efforts: [],
      defaultEffort: undefined,
      current: true,
    })
  }
  return choices
}
