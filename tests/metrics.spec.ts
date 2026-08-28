import { describe, expect, it } from 'vitest'
import type { AppEvent } from '../src/backend/app-events.ts'
import { Metrics } from '../src/backend/metrics.ts'

const usage = (turn: number, step: number, over: Partial<Record<string, number>> = {}): AppEvent => ({
  kind: 'usage', turn, step,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over } as never,
})

describe('Metrics (spec §3.8, the replace-not-accumulate law)', () => {
  it('omits every segment until something has actually been reported', () => {
    expect(new Metrics().read()).toEqual({ model: undefined, cachePercent: undefined, contextPercent: undefined })
  })

  it('folds cache% over the billed input, and never shows a misleading 0% before any billing', () => {
    const m = new Metrics()
    m.apply(usage(1, 1, { outputTokens: 40 }))                   // output only: nothing billed as input yet
    expect(m.read().cachePercent).toBeUndefined()
    m.apply(usage(1, 2, { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 }))
    expect(m.read().cachePercent).toBe(60)                       // 300 / (100+300+100)
  })

  it('REPLACES a step rather than accumulating it — a re-reported step, and a full replay, both land the same', () => {
    const m = new Metrics()
    m.apply(usage(1, 1, { inputTokens: 100, cacheReadTokens: 100 }))   // the early usage chunk
    m.apply(usage(1, 1, { inputTokens: 200, cacheReadTokens: 200 }))   // the settled message, same step
    expect(m.read().cachePercent).toBe(50)

    const replayed = new Metrics()
    const log = [usage(1, 1, { inputTokens: 200, cacheReadTokens: 200 }), usage(1, 2, { inputTokens: 200 })]
    for (const event of log) replayed.apply(event)
    const once = replayed.read()
    for (const event of log) replayed.apply(event)                     // replaying the log twice changes nothing
    expect(replayed.read()).toEqual(once)
  })

  it('reads ctx% off the LATEST request, against the window that request declared', () => {
    const m = new Metrics()
    m.apply({ kind: 'request-context', model: 'deepseek-chat', contextWindow: 1000 })
    m.apply(usage(1, 1, { inputTokens: 600, outputTokens: 20 }))
    expect(m.read()).toEqual({ model: 'deepseek-chat', cachePercent: 0, contextPercent: 62 })
    m.apply(usage(1, 2, { inputTokens: 100, cacheReadTokens: 100, outputTokens: 10 }))
    expect(m.read().contextPercent).toBe(21)                     // the newest request, not a running total
  })

  it('omits ctx% without a window, a window of zero, or any sample at all', () => {
    const noWindow = new Metrics()
    noWindow.apply({ kind: 'request-context', model: 'm', contextWindow: undefined })
    noWindow.apply(usage(1, 1, { inputTokens: 10 }))
    expect(noWindow.read().contextPercent).toBeUndefined()

    const zero = new Metrics()
    zero.apply({ kind: 'request-context', model: 'm', contextWindow: 0 })
    zero.apply(usage(1, 1, { inputTokens: 10 }))
    expect(zero.read().contextPercent).toBeUndefined()

    const noSample = new Metrics()
    noSample.apply({ kind: 'request-context', model: 'm', contextWindow: 100 })
    expect(noSample.read().contextPercent).toBeUndefined()
  })

  it('ignores every event that is not a metric', () => {
    const m = new Metrics()
    m.apply({ kind: 'user-message', text: 'hi' })
    expect(m.read().model).toBeUndefined()
  })
})
