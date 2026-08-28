/** Footer metrics, folded from durable events (spec §3.8, §5.2). Event-driven
 * ONLY — nothing here is polled per keystroke or per frame.
 *
 * The fold is talon's own rather than a `ctx.tokenMeter` read: it is the spec's
 * forward-scan accumulator (§5.2), so it is replay-equivalent by construction
 * and costs O(1) per event where `measure()` costs O(surface); it needs no
 * injected service; and it takes `contextWindow` from `request/context`
 * directly, so the staleness §3.8 warns about (reading the window off
 * `contextPressure` after a model switch) cannot arise.
 *
 * The one subtle law is REPLACE-NOT-ACCUMULATE, keyed `${turn}:${step}`: dsh
 * reports a step's usage twice — once as an early `usage` chunk that survives a
 * later request failure, once on the settled assistant message — and a resend
 * reports it again. Each key therefore SUBTRACTS what it contributed before
 * adding what it now contributes, so replaying a log twice yields the same
 * totals as replaying it once. */
import type { AppEvent } from './app-events.js'

/** dsh's `TokenUsage` buckets, normalized. They are DISJOINT: billed input is
 * `inputTokens + cacheReadTokens + cacheWriteTokens` (llm types.d.ts:118-129). */
export interface UsageSample {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const BUCKETS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/** What the footer draws. An absent value is genuinely absent — the footer
 * drops it together with its separator rather than printing a zero. */
export interface MetricsView {
  model: string | undefined
  cachePercent: number | undefined
  contextPercent: number | undefined
}

function billed(usage: UsageSample): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

export class Metrics {
  private readonly perStep = new Map<string, UsageSample>()
  private readonly totals: UsageSample = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  private latest: UsageSample | undefined
  private model: string | undefined
  private contextWindow: number | undefined

  apply(event: AppEvent): void {
    if (event.kind === 'request-context') {
      this.model = event.model
      this.contextWindow = event.contextWindow
      return
    }
    if (event.kind !== 'usage') return
    const key = `${event.turn}:${event.step}`
    const previous = this.perStep.get(key)
    if (previous !== undefined) for (const bucket of BUCKETS) this.totals[bucket] -= previous[bucket]
    for (const bucket of BUCKETS) this.totals[bucket] += event.usage[bucket]
    this.perStep.set(key, event.usage)
    this.latest = event.usage
  }

  read(): MetricsView {
    const billedTotal = billed(this.totals)
    return {
      model: this.model,
      // Omitted entirely before anything was billed — never a misleading 0%.
      cachePercent: billedTotal === 0 ? undefined : Math.round((this.totals.cacheReadTokens / billedTotal) * 100),
      // Occupancy is the LATEST request's own pressure against the window the
      // same request declared — not a session-wide total, which would only
      // grow (and would be meaningless after a compaction).
      contextPercent: this.latest === undefined || this.contextWindow === undefined || this.contextWindow === 0
        ? undefined
        : Math.round(((billed(this.latest) + this.latest.outputTokens) / this.contextWindow) * 100),
    }
  }
}
