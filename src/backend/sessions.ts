// src/backend/sessions.ts
/** Resume candidates for the selector (spec §3.6): the disable ladder, the
 * title ladder (live → cached → cold, one batch when no cache service is
 * present), and the hand-written worker pool. Every dsh handle arrives as a
 * minimal facet, so the ladders run on fakes. */

export interface SessionRecordLike { header: { id: string; createdAt: number; cwd?: string }; live: boolean; persisted: boolean }
export interface ResumeCandidate {
  id: string; title: string; lastActivityAt: number; cwd: string | undefined
  live: boolean; persisted: boolean; currentWorkspace: boolean; disabledReason?: string
}
/** What the resume preflight reads — the live agent's status, the session
 * listing, the target's full log, and the currently routable providers. */
export interface PreflightServices {
  agentStatus(): 'idle' | 'running'
  listSessions(): Promise<SessionRecordLike[]>
  readSession(id: string): Promise<{ events: readonly { type: string; data: unknown }[] }>
  listProviders(): { id: string }[]
}
export interface SessionServices {
  listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
  liveSession(id: string): { events: readonly { time?: number }[] } | undefined      // ctx.sessions.get
  liveTitle?(session: unknown): string | null | undefined                            // sessionProjections?.snapshot(s).values.title
  cachedSnapshot?(header: SessionRecordLike['header']): { values: { title?: string | null } } | undefined
  coldSnapshot?(id: string, signal?: AbortSignal): Promise<{ values: { title?: string | null } }>
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<
    ({ sessionId: string; status: 'fulfilled'; value: { title?: { title: string } } } | { sessionId: string; status: 'rejected'; reason: unknown })[]>
}

export function summarizeCandidate(record: SessionRecordLike, title: string | undefined, lastActivityAt: number | undefined, currentId: string, cwd: string): ResumeCandidate {
  let disabledReason: string | undefined
  if (record.header.id === currentId) disabledReason = 'current session'
  else if (record.live) disabledReason = 'session is already live in this runtime'
  else if (record.header.cwd === undefined) disabledReason = 'session has no recorded workspace'
  return {
    id: record.header.id,
    title: title ?? 'Untitled session',
    lastActivityAt: lastActivityAt ?? record.header.createdAt,
    cwd: record.header.cwd,
    live: record.live,
    persisted: record.persisted,
    currentWorkspace: record.header.cwd === cwd,
    ...(disabledReason === undefined ? {} : { disabledReason }),
  }
}

export async function buildResumeCandidates(services: SessionServices, opts: { currentId: string; cwd: string; concurrency?: number; signal?: AbortSignal }): Promise<ResumeCandidate[]> {
  const records = await services.listSessions(opts.signal)
  const titles = new Map<string, string | undefined>()
  const failures = new Map<string, string>()
  const hasCacheLadder = services.cachedSnapshot !== undefined || services.coldSnapshot !== undefined
  const pending: SessionRecordLike[] = []
  for (const record of records) {
    const live = services.liveSession(record.header.id)
    // Both title rungs run a schema parse per projection unit, so one corrupt
    // payload must degrade ONE row, never reject the whole listing.
    try {
      if (live !== undefined && services.liveTitle !== undefined) { titles.set(record.header.id, services.liveTitle(live) ?? undefined); continue }
      const cached = services.cachedSnapshot?.(record.header)
      if (cached !== undefined && 'title' in cached.values) { titles.set(record.header.id, cached.values.title ?? undefined); continue }
      pending.push(record)
    } catch (cause) {
      failures.set(record.header.id, cause instanceof Error ? cause.message : String(cause))
    }
  }
  if (hasCacheLadder) {
    const queue = [...pending]
    const worker = async (): Promise<void> => {
      for (let record = queue.shift(); record !== undefined; record = queue.shift()) {
        try {
          const snap = await services.coldSnapshot?.(record.header.id, opts.signal)
          titles.set(record.header.id, (snap?.values.title as string | null | undefined) ?? undefined)
        } catch (cause) {
          failures.set(record.header.id, cause instanceof Error ? cause.message : String(cause))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, Math.max(1, queue.length)) }, worker))
  } else if (pending.length > 0) {
    for (const result of await services.readTitleSnapshots(pending.map((r) => r.header.id), opts.signal)) {
      if (result.status === 'fulfilled') titles.set(result.sessionId, result.value.title?.title)
      else failures.set(result.sessionId, result.reason instanceof Error ? (result.reason as Error).message : String(result.reason))
    }
  }
  const candidates = records.map((record) => {
    const failure = failures.get(record.header.id)
    const activity = services.liveSession(record.header.id)?.events.at(-1)?.time
    const candidate = summarizeCandidate(record, titles.get(record.header.id), activity, opts.currentId, opts.cwd)
    return failure === undefined ? candidate : { ...candidate, title: 'Unreadable session', disabledReason: `session cannot be loaded: ${failure}` }
  })
  candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id))
  return candidates
}

/** The route a persisted session last ran on: its newest `request/header`
 * snapshot (`data.header.config`, dsh session/types.ts:304 + llm
 * call-config.ts:23-25), else its newest assistant message's provenance
 * (`data.message.source`, session/types.ts:273 + llm message.ts:8-12).
 * Undefined when the log names neither — nothing to validate. */
export function resumeRoute(events: readonly { type: string; data: unknown }[]): { provider: string; model: string } | undefined {
  let header: { provider: string; model: string } | undefined
  let message: { provider: string; model: string } | undefined
  for (const event of events) {
    if (event.type === 'request/header') {
      const { config } = (event.data as { header: { config: { provider: string; model: string } } }).header
      header = { provider: config.provider, model: config.model }
    } else if (event.type === 'assistant/message') {
      const { source } = (event.data as { message: { source: { provider: string; model: string } } }).message
      message = { provider: source.provider, model: source.model }
    }
  }
  return header ?? message
}

function requireIdle(status: 'idle' | 'running'): void {
  if (status !== 'idle') throw new Error(`Resume requires an idle agent (status: ${status}).`)
}

/**
 * The recovered resume preflight (spec D8): idle at entry AND exit (the agent
 * can start a turn while the selector is open), the record re-read from a
 * FRESH listing with its disable ladder re-derived, the full log read once,
 * and the route it ran on still registered. Throws on every refusal, so the
 * caller renders one error notice and nothing is torn down.
 *
 * The workspace check precedes the ladder deliberately: the ladder's own
 * no-cwd rung says the same thing in the listing's vocabulary, and going
 * first keeps this failure's fuller sentence reachable.
 */
export async function preflightResume(services: PreflightServices, id: string, opts: { currentId: string; cwd: string }): Promise<{ id: string; cwd: string }> {
  requireIdle(services.agentStatus())
  const record = (await services.listSessions()).find((r) => r.header.id === id)
  if (record === undefined) throw new Error(`Session "${id}" is no longer available.`)
  const cwd = record.header.cwd
  if (cwd === undefined) throw new Error(`Session "${id}" has no recorded workspace to resume in.`)
  const { disabledReason } = summarizeCandidate(record, undefined, undefined, opts.currentId, opts.cwd)
  if (disabledReason !== undefined) throw new Error(disabledReason)
  let events: readonly { type: string; data: unknown }[]
  try {
    ({ events } = await services.readSession(id))
  } catch (cause) {
    throw new Error(`session cannot be loaded: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const route = resumeRoute(events)
  if (route !== undefined && !services.listProviders().some((p) => p.id === route.provider)) {
    throw new Error(`session is complete, but route is currently unavailable (${route.provider}/${route.model})`)
  }
  requireIdle(services.agentStatus())
  return { id, cwd }
}
