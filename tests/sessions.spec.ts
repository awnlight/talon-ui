// tests/sessions.spec.ts
import { describe, expect, it } from 'vitest'
import { buildResumeCandidates, preflightResume, resumeRoute, summarizeCandidate } from '../src/backend/sessions.ts'

const rec = (id: string, over: Partial<{ createdAt: number; cwd: string | undefined; live: boolean; persisted: boolean }> = {}) => ({
  header: { id, createdAt: over.createdAt ?? 1000, ...(('cwd' in over) ? (over.cwd === undefined ? {} : { cwd: over.cwd }) : { cwd: '/w' }) },
  live: over.live ?? false,
  persisted: over.persisted ?? true,
})

describe('summarizeCandidate (disable ladder, spec §3.6)', () => {
  it('current session wins over live', () => {
    expect(summarizeCandidate(rec('a', { live: true }) as never, 't', 5, 'a', '/w').disabledReason).toBe('current session')
  })
  it('live blocks; missing cwd blocks; foreign workspace does NOT block', () => {
    expect(summarizeCandidate(rec('b', { live: true }) as never, 't', 5, 'a', '/w').disabledReason).toBe('session is already live in this runtime')
    expect(summarizeCandidate(rec('c', { cwd: undefined }) as never, 't', 5, 'a', '/w').disabledReason).toBe('session has no recorded workspace')
    const foreign = summarizeCandidate(rec('d', { cwd: '/elsewhere' }) as never, 't', 5, 'a', '/w')
    expect(foreign.disabledReason).toBeUndefined()
    expect(foreign.currentWorkspace).toBe(false)
  })
  it('defaults title and activity', () => {
    const c = summarizeCandidate(rec('e') as never, undefined, undefined, 'a', '/w')
    expect(c.title).toBe('Untitled session')
    expect(c.lastActivityAt).toBe(1000)
  })
})

describe('buildResumeCandidates (title ladder + pool)', () => {
  const base = () => ({
    listSessions: async () => [rec('live1', { live: true, createdAt: 300 }), rec('cached1', { createdAt: 200 }), rec('cold1', { createdAt: 100 })],
    liveSession: (id: string) => (id === 'live1' ? { events: [{ time: 900 }] } : undefined),
    liveTitle: () => 'Live title',
    cachedSnapshot: (h: { id: string }) => (h.id === 'cached1' ? { values: { title: 'Cached title' } } : undefined),
    coldSnapshot: async (id: string) => ({ values: { title: id === 'cold1' ? 'Cold title' : null } }),
    readTitleSnapshots: async () => { throw new Error('batch path must not run when the cache ladder exists') },
  })
  it('walks live → cached → cold and stamps activity', async () => {
    const out = await buildResumeCandidates(base() as never, { currentId: 'me', cwd: '/w' })
    expect(out.map((c) => [c.id, c.title])).toEqual([
      ['live1', 'Live title'],      // activity 900 sorts first
      ['cached1', 'Cached title'],
      ['cold1', 'Cold title'],
    ])
    expect(out[0]!.lastActivityAt).toBe(900)
    expect(out[1]!.lastActivityAt).toBe(200)
  })
  it('falls back to ONE readTitleSnapshots batch without a cache service', async () => {
    let batches = 0
    const services = {
      ...base(), cachedSnapshot: undefined, coldSnapshot: undefined,
      readTitleSnapshots: async (ids: readonly string[]) => {
        batches += 1
        return ids.map((sessionId) => ({ sessionId, status: 'fulfilled' as const, value: { title: { title: `batch:${sessionId}` } } }))
      },
    }
    const out = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    expect(batches).toBe(1)
    expect(out.find((c) => c.id === 'cold1')!.title).toBe('batch:cold1')
    expect(out.find((c) => c.id === 'live1')!.title).toBe('Live title')   // live rung still wins
  })
  it('isolates a per-record cold failure into an unreadable candidate', async () => {
    const services = { ...base(), cachedSnapshot: () => undefined, coldSnapshot: async () => { throw new Error('corrupt tail') } }
    const out = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    const bad = out.filter((c) => c.title === 'Unreadable session')
    expect(bad.map((c) => c.id).sort()).toEqual(['cached1', 'cold1'])
    for (const c of bad) expect(c.disabledReason).toContain('session cannot be loaded: corrupt tail')
  })
  it('caps ladder concurrency at the pool size', async () => {
    let inFlight = 0, peak = 0
    const records = Array.from({ length: 9 }, (_, i) => rec(`s${i}`, { createdAt: i }))
    const services = {
      listSessions: async () => records, liveSession: () => undefined, liveTitle: undefined,
      cachedSnapshot: () => undefined,
      coldSnapshot: async (id: string) => {
        inFlight += 1; peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return { values: { title: id } }
      },
      readTitleSnapshots: async () => [],
    }
    await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w', concurrency: 3 })
    expect(peak).toBeLessThanOrEqual(3)
  })
})

describe('buildResumeCandidates (title fallbacks, failure isolation, ordering)', () => {
  it('falls back to Untitled at every rung that yields no title, and to createdAt on an empty live log', async () => {
    const services = {
      listSessions: async () => [rec('live1', { live: true, createdAt: 300 }), rec('cached1', { createdAt: 200 }), rec('cold1', { createdAt: 100 })],
      liveSession: (id: string) => (id === 'live1' ? { events: [] } : undefined),
      liveTitle: () => null,
      cachedSnapshot: (h: { id: string }) => (h.id === 'cached1' ? { values: { title: null } } : undefined),
      coldSnapshot: async () => ({ values: { title: null } }),
      readTitleSnapshots: async () => [],
    }
    const out = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    expect(out.map((c) => [c.id, c.title, c.lastActivityAt])).toEqual([
      ['live1', 'Untitled session', 300],
      ['cached1', 'Untitled session', 200],
      ['cold1', 'Untitled session', 100],
    ])
  })
  it('isolates rejected batch results and names a non-Error reason', async () => {
    const services = {
      listSessions: async () => [rec('ok', { createdAt: 300 }), rec('bad', { createdAt: 200 }), rec('worse', { createdAt: 100 })],
      liveSession: () => undefined,
      readTitleSnapshots: async (ids: readonly string[]) => [
        { sessionId: ids[0]!, status: 'fulfilled' as const, value: {} },
        { sessionId: ids[1]!, status: 'rejected' as const, reason: new Error('unreadable log') },
        { sessionId: ids[2]!, status: 'rejected' as const, reason: 'disk gone' },
      ],
    }
    const out = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    expect(out.map((c) => [c.title, c.disabledReason])).toEqual([
      ['Untitled session', undefined],
      ['Unreadable session', 'session cannot be loaded: unreadable log'],
      ['Unreadable session', 'session cannot be loaded: disk gone'],
    ])
  })
  it('names a non-Error cold failure', async () => {
    const services = {
      listSessions: async () => [rec('cold1')],
      liveSession: () => undefined,
      cachedSnapshot: () => undefined,
      coldSnapshot: async () => { throw 'corrupt tail' },
      readTitleSnapshots: async () => [],
    }
    const [candidate] = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    expect(candidate!.title).toBe('Unreadable session')
    expect(candidate!.disabledReason).toBe('session cannot be loaded: corrupt tail')
  })
  it('isolates a throwing live or cached rung, leaving its siblings titled', async () => {
    const services = {
      listSessions: async () => [rec('live1', { live: true, createdAt: 300 }), rec('cached1', { createdAt: 200 }), rec('cold1', { createdAt: 100 })],
      liveSession: (id: string) => (id === 'live1' ? { events: [{ time: 900 }] } : undefined),
      liveTitle: () => { throw new Error('schema.parse failed for key "goal"') },
      cachedSnapshot: (h: { id: string }) => { if (h.id === 'cached1') throw 'projection unit rejected a stored row'; return undefined },
      coldSnapshot: async () => ({ values: { title: 'Cold title' } }),
      readTitleSnapshots: async () => { throw new Error('batch path must not run when the cache ladder exists') },
    }
    const out = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    expect(out.map((c) => [c.id, c.title, c.disabledReason])).toEqual([
      ['live1', 'Unreadable session', 'session cannot be loaded: schema.parse failed for key "goal"'],
      ['cached1', 'Unreadable session', 'session cannot be loaded: projection unit rejected a stored row'],
      ['cold1', 'Cold title', undefined],
    ])
  })
  it('breaks an activity tie by id, ascending', async () => {
    const services = {
      listSessions: async () => [rec('zulu', { createdAt: 500 }), rec('alpha', { createdAt: 500 })],
      liveSession: () => undefined,
      readTitleSnapshots: async (ids: readonly string[]) =>
        ids.map((sessionId) => ({ sessionId, status: 'fulfilled' as const, value: { title: { title: sessionId } } })),
    }
    const out = await buildResumeCandidates(services as never, { currentId: 'me', cwd: '/w' })
    expect(out.map((c) => c.id)).toEqual(['alpha', 'zulu'])
  })
})

describe('resumeRoute', () => {
  it('prefers the latest request/header, falls back to the latest assistant/message', () => {
    const events = [
      { type: 'assistant/message', data: { message: { source: { provider: 'p-old', model: 'm-old' } } } },
      { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } } } },
      { type: 'request/header', data: { header: { config: { provider: 'p2', model: 'm2' } } } },
    ]
    expect(resumeRoute(events)).toEqual({ provider: 'p2', model: 'm2' })
    expect(resumeRoute([events[0]!])).toEqual({ provider: 'p-old', model: 'm-old' })
    expect(resumeRoute([])).toBeUndefined()
  })
})

describe('preflightResume (recovered semantics)', () => {
  const services = (over: Record<string, unknown> = {}) => ({
    agentStatus: () => 'idle' as const,
    listSessions: async () => [rec('target', { cwd: '/target' })],
    readSession: async () => ({ events: [{ type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'chat' } } } }] }),
    listProviders: () => [{ id: 'deepseek' }],
    ...over,
  })
  const opts = { currentId: 'me', cwd: '/w' }
  it('passes a clean target and returns the re-read cwd', async () => {
    await expect(preflightResume(services() as never, 'target', opts)).resolves.toEqual({ id: 'target', cwd: '/target' })
  })
  it('rejects when the agent is not idle', async () => {
    await expect(preflightResume(services({ agentStatus: () => 'running' }) as never, 'target', opts)).rejects.toThrow('Resume requires an idle agent (status: running).')
  })
  it('rejects a vanished record', async () => {
    await expect(preflightResume(services({ listSessions: async () => [] }) as never, 'target', opts)).rejects.toThrow('no longer available')
  })
  it('re-derives disable reasons from the FRESH record', async () => {
    await expect(preflightResume(services({ listSessions: async () => [rec('target', { live: true, cwd: '/target' })] }) as never, 'target', opts))
      .rejects.toThrow('already live')
  })
  it('rejects an unavailable route provider, naming it', async () => {
    await expect(preflightResume(services({ listProviders: () => [{ id: 'other' }] }) as never, 'target', opts))
      .rejects.toThrow('route is currently unavailable (deepseek/chat)')
  })
  it('rejects an unreadable log with the load-failure chain', async () => {
    await expect(preflightResume(services({ readSession: async () => { throw new Error('torn file') } }) as never, 'target', opts))
      .rejects.toThrow('session cannot be loaded: torn file')
  })
  it('re-checks idle at exit', async () => {
    let calls = 0
    await expect(preflightResume(services({ agentStatus: () => (calls++ === 0 ? 'idle' : 'running') }) as never, 'target', opts))
      .rejects.toThrow('Resume requires an idle agent (status: running).')
  })
  it('names a non-Error load failure through String(cause)', async () => {
    await expect(preflightResume(services({ readSession: async () => { throw 'torn tail' } }) as never, 'target', opts))
      .rejects.toThrow('session cannot be loaded: torn tail')
  })
  it('refuses a record with no workspace before the ladder repeats it', async () => {
    await expect(preflightResume(services({ listSessions: async () => [rec('target', { cwd: undefined })] }) as never, 'target', opts))
      .rejects.toThrow('Session "target" has no recorded workspace to resume in.')
  })
  it('accepts a log that names no route at all', async () => {
    await expect(preflightResume(services({ readSession: async () => ({ events: [] }) }) as never, 'target', opts))
      .resolves.toEqual({ id: 'target', cwd: '/target' })
  })
})
