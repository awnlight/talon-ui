/** One mounted talon channel: TuiMainScreen + Transcript + Composer +
 * global keys + backend subscriptions. Async results re-enter through the
 * same handlers — no side-channel state (spec §2 data flow). */
import { Container, matchesKey, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui'
import type { CommandDefinition, CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import type { Notice } from '../backend/app-events.js'
import { attachApprovalResponder } from '../backend/approval.js'
import { registerSessionCommands, registerTalonCommands } from '../backend/commands.js'
import { attachQuestionProvider, cancelledError } from '../backend/questions.js'
import { buildResumeCandidates, preflightResume, type PreflightServices, type ResumeCandidate, type SessionRecordLike, type SessionServices } from '../backend/sessions.js'
import { translateSessionEvent } from '../backend/translate.js'
import { displayText, type Palette } from '../theme/palette.js'
import { Composer } from '../ui/composer/composer.js'
import { createSlashProvider } from '../ui/composer/slash-provider.js'
import { ApprovalPanel } from '../ui/panels/approval-panel.js'
import { PanelManager } from '../ui/panels/panel-manager.js'
import { QuestionPanel } from '../ui/panels/question-panel.js'
import { ResumePanel } from '../ui/panels/resume-panel.js'
import { Transcript } from '../ui/transcript/transcript.js'

/** The slice of dsh's `Agent` the UI drives. Named (Task 16) because the
 * in-process rebind takes one as an argument. */
export interface AgentFacet {
  id: string
  status: 'idle' | 'running'
  session: unknown
  cancel(cause: { kind: 'user' }): void
  followup(message: unknown): void
  steer(message: unknown): void
  whenIdle(): Promise<void>
}

/** Minimal facet of dsh's `ctx.sessionQuery` (spec §3.6) — the listing, one
 * full log for the preflight, and the batch title rung. */
interface SessionQueryFacet {
  listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>
  readSession(id: string): Promise<{ events: readonly { type: string; data: unknown }[] }>
  readTitleSnapshots: SessionServices['readTitleSnapshots']
}

export interface ControllerDeps {
  /** The plugin's ROOT ctx — NOT a per-agent scope (root-ctx flip, T2 Task
   * 5). dsh's event dispatch is scope-filtered per agent, so a listener
   * bound to `agent.ctx` goes deaf across Task 16's in-process rebind;
   * binding the root here keeps listening. The per-event identity checks
   * below (`session !== bound.session`, `payload.agent !== bound`) are the
   * ONLY filter keeping other agents' events out — required for D8. */
  ctx: { on(event: string, fn: (...args: any[]) => void): () => void }
  agent: AgentFacet
  terminal: Terminal
  palette: Palette
  /** Minimal facet of dsh's `ctx.userQuestions` (spec §3.4) — just enough for
   * `attachQuestionProvider` to register the one active UI provider. */
  userQuestions: { registerProvider(p: { ask(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void }
  /** Minimal facet of dsh's `ctx.commands` (spec §3.5): registration for
   * talon's own set (global — Ruling 3), the descriptor list `/help` prints,
   * and the executor every slash submission goes through. */
  commands: {
    register(def: CommandDefinition): () => void
    list(agent: unknown): readonly CommandDescriptor[]
    execute(agent: unknown, line: string, signal: AbortSignal): Promise<unknown>
  }
  /** Minimal facet of dsh's `ctx.agents` (spec §3.6): in-process resume keeps
   * the old agent alive and only moves this UI's binding (Ruling 8). */
  agents: { resume(opts: { resumeSessionId: string }): Promise<{ agent: AgentFacet }> }
  /** talon-boot's `createRootAgent` bound to the host ctx — `/clear` mints a
   * fresh session through the boot's own composition (Ruling 10). */
  createRootAgent(): Promise<{ agent: AgentFacet }>
  /** Services the session flows read. `sessionQuery` and the two projection
   * services are `ctx.get` optionals (spec §3.1): without the first, `/resume`
   * says so; without the others, the title ladder falls back to one
   * `readTitleSnapshots` batch. `llm` rides `inject`, so it is always there. */
  services: {
    sessionQuery?: SessionQueryFacet
    sessions: { get(id: string): { events: readonly { time?: number }[] } | undefined }
    projections?: { snapshot(session: unknown): { values: { title?: string | null } } }
    projectionCache?: {
      cachedSnapshot(header: SessionRecordLike['header']): { values: { title?: string | null } } | undefined
      coldSnapshot(id: string, signal?: AbortSignal): Promise<{ values: { title?: string | null } }>
    }
    llm: { listProviders(): { id: string }[] }
  }
  exit(code: number): void
}

const HINT_IDLE = 'enter send · shift+enter newline · ctrl+c exit'
const HINT_RUNNING = 'esc interrupt · ctrl+c interrupt'
/** Ctrl+D while a turn is running (carryover 3): never a silent swallow. */
const HINT_INTERRUPT_FIRST = 'Agent is running — press Esc to interrupt, then Ctrl+D to exit.'
/** The one goodbye line (Ruling 12), written only on the user-exit path. */
const GOODBYE = (sessionId: string): string => `To resume: dsh --profile talon, then /resume — session ${sessionId}`
const RESUME_RUNNING = 'Resume is not available while a turn is running.'
const RESUME_UNMOUNTED = 'Resume is not available: session query is not mounted.'
const CLEAR_RUNNING = 'A fresh session is not available while a turn is running.'
/** What the selector shows for a session whose log recorded no workspace. */
const WORKSPACE_UNSET = 'cwd unset'

/**
 * Build a value shaped like dsh's real `UserMessage` (id/role/content/source)
 * so a live agent's `followup`/`steer` accepts it — the task brief's bare
 * `{ content }` object does not match the real wire shape (controller ruling
 * 4). Hand-constructed rather than calling the real `createUserMessage`:
 * `@deepseek-ai/dsh-llm`'s tsconfig path points at raw
 * `packages/llm/llm/src` (not a compiled `.d.ts`), and that package's
 * `src/index.ts:9` imports `@deepseek-ai/cordis` as a value — which has no
 * path mapping and is not installed. Confirmed empirically: importing
 * anything from `@deepseek-ai/dsh-llm` makes `tsc -p tsconfig.json --noEmit`
 * fail with `TS2307: Cannot find module '@deepseek-ai/dsh-llm'`.
 *
 * Shape mirrors `deepseek-harness/packages/llm/llm/src/message.ts:129-143`
 * (`Message`/`UserMessage`: `id`, `role`, `content`, `source`) and
 * `:192-199` (`createUserMessage`: `role: 'user'` + a fresh `MessageId`,
 * which `brand.ts:23-24` shows is just `id as MessageId` — a plain string at
 * runtime, so `crypto.randomUUID()` here is runtime-identical). Matches the
 * real production call site `packages/schedule/schedule/src/runtime.ts:
 * 271-275` and every dsh test call site:
 * `createUserMessage({ content, source: { kind: 'user' } })` passed straight
 * into `agent.followup`/`steer` — both typed to take a complete `UserMessage`,
 * not a partial (`packages/core/agent/lib/types/runtime-types.d.ts:115,123`).
 */
function toUserMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

export function createController(deps: ControllerDeps): { dispose(): Promise<void>; panels: PanelManager; bindAgent(next: AgentFacet): void } {
  const { ctx, agent, terminal, palette, exit } = deps
  const tui = new TuiMainScreen(terminal)
  tui.setClearOnShrink(false) // spec D10: shrink clears via normal diff, never a scrollback-wiping full redraw
  // The transcript hangs in a slot rather than directly off the TUI: a rebind
  // (D8) swaps a whole new Transcript in while keeping render position 0
  // (container children order IS the render order).
  const transcriptSlot = new Container()
  let transcript = new Transcript(palette)
  transcriptSlot.addChild(transcript.container)
  const composer = new Composer(tui, palette)
  composer.setHint(HINT_IDLE)

  let disposed = false
  let running = agent.status === 'running'
  // Identity target for the two per-event filters below. Always `agent`
  // today; Task 16's in-process rebind reassigns this in place so the
  // listeners registered against the root ctx (see ControllerDeps.ctx) keep
  // matching the live agent instead of going deaf.
  let bound = agent
  const panels = new PanelManager({
    setFocus: (c) => tui.setFocus(c),
    focusHome: () => composer.editor,
    requestRender: () => tui.requestRender(),
    onActiveChange: (active) => {
      composer.setState(active ? 'waiting' : running ? 'streaming' : 'idle')
      tui.requestRender()
    },
  })
  const hasPanel = (): boolean => panels.active !== undefined
  /** The composer's whole derived look: a panel outranks a running turn. */
  const syncComposer = (): void => {
    composer.setState(panels.active ? 'waiting' : running ? 'streaming' : 'idle')
    composer.setHint(running ? HINT_RUNNING : HINT_IDLE)
  }

  tui.addChild(transcriptSlot)
  tui.addChild(panels.container)
  tui.addChild(composer.container)
  tui.setFocus(composer.editor)

  const detachers: (() => void)[] = []
  // Tool-call previews, keyed by callId, so an approval prompt for that call
  // can enrich its header (spec D9); cleared per turn — a callId is only
  // ever relevant to the turn that issued it.
  const pendingCalls = new Map<string, string>()

  detachers.push(ctx.on('session/event', (session: unknown, event: { type: string; data: unknown; time?: number }) => {
    if (session !== bound.session || disposed) return
    for (const appEvent of translateSessionEvent(event)) {
      if (appEvent.kind === 'tool-call' && appEvent.preview !== undefined) pendingCalls.set(appEvent.callId, appEvent.preview)
      if (appEvent.kind === 'turn-end') pendingCalls.clear()
      transcript.apply(appEvent)
    }
    tui.requestRender()
  }))

  detachers.push(ctx.on('agent/status', (payload: { agent: unknown; status: 'idle' | 'running' }) => {
    if (payload.agent !== bound || disposed) return
    running = payload.status === 'running'
    syncComposer()
    tui.requestRender()
  }))

  /** Move the whole UI onto another agent in place (spec D8, Ruling 8): the
   * root-ctx listeners keep firing, so only the identity they filter on, the
   * transcript they paint into, and the per-turn scratch state change. The
   * old agent stays alive and simply stops being rendered. */
  function bindAgent(next: AgentFacet): void {
    // The screen transition (D10④, Task 19): a rebind swaps the WHOLE UI, so
    // diffing new-against-old flags rows above the viewport, and pi-tui's only
    // recovery there is fullRender(true) — the ED3 scrollback wipe (verified
    // tui-main-screen.js:346-350). Instead, park the cursor on a fresh row
    // below the old screen (as beforeTerminalStop does, tui-main-screen.js:
    // 81-92; after any completed paint hardwareCursorRow is clamped inside
    // the rendered block, so the distance down is >= 1 — the clamp only bars
    // a malformed CSI param) and hand the renderer a no-previous-frame
    // baseline, so the new session's UI APPENDS and the old screen scrolls
    // into history intact. The ZERO width/height sentinels are load-bearing:
    // doRender treats 0 as "no previous frame" (widthChanged tests `!== 0`,
    // tui-main-screen.js:158-159) — the protected resetRenderState()'s -1
    // would read as a resize and fullRender(true)-wipe instead.
    const screen = tui.captureRenderState()
    if (screen.previousLines.length > 0) {
      terminal.write(` \x1b[${Math.max(1, screen.previousLines.length - screen.hardwareCursorRow)}B\r\n`)
    }
    tui.restoreRenderState({ previousLines: [], previousWidth: 0, previousHeight: 0, cursorRow: 0, hardwareCursorRow: 0, maxLinesRendered: 0, previousViewportTop: 0 })
    bound = next
    running = next.status === 'running'
    pendingCalls.clear()
    transcript = new Transcript(palette)
    transcriptSlot.clear()
    transcriptSlot.addChild(transcript.container)
    // Replay from the LIVE session (Ruling 8): whatever agents.resume() loaded,
    // through the same translation live events take — so a resumed screen and
    // the screen that produced it are the same screen.
    for (const event of (next.session as { events?: readonly { type: string; data: unknown; time?: number }[] }).events ?? []) {
      for (const appEvent of translateSessionEvent(event)) transcript.apply(appEvent)
    }
    syncComposer()
    tui.requestRender()
  }

  // The approval/request waterfall responder (spec D9): claims only this
  // controller's bound agent's requests by identity, presents them through
  // the same PanelManager FIFO every other panel uses. A signal abort while
  // the panel is showing force-closes it 'cancelled'; teardown rejects (the
  // real ApprovalService normalizes a rejection to 'unavailable' — fail
  // closed, Ruling 7).
  detachers.push(attachApprovalResponder(ctx, {
    isBound: (a) => a === bound,
    present: (req) => panels.enqueue<ApprovalOutcome>({
      create: (finish) => new ApprovalPanel({
        toolName: req.toolName,
        preview: req.callId === undefined ? undefined : pendingCalls.get(req.callId),
        reason: req.reason,
        cwd: process.cwd(),
      }, finish, palette),
      forced: (reason) => reason === 'aborted' ? { outcome: 'cancelled' } : { error: new Error('talon-ui torn down before the approval was answered') },
    }, req.signal === undefined ? {} : { signal: req.signal }),
  }))

  // The user-questions provider (spec §3.4): one QuestionPanel session per
  // request, walking its questions serially through the same PanelManager
  // FIFO. QuestionPanel's `cancel()` cannot throw directly (GuardedPanel
  // would settle that as a crash, indistinguishable from a bug) — so both the
  // panel's own dismissal AND a forced teardown/abort settle the enqueue with
  // a discriminated outcome, and only THIS function maps 'cancelled' to the
  // exact rejection dsh's plan-mode narrows on (Ruling 7).
  detachers.push(attachQuestionProvider(deps.userQuestions as never, {
    present: async (request) => {
      const result = await panels.enqueue<{ kind: 'answered'; answer: AskUserQuestionAnswer } | { kind: 'cancelled' }>({
        create: (finish) => new QuestionPanel(
          request as never,
          (answer) => finish({ kind: 'answered', answer }),
          () => finish({ kind: 'cancelled' }),
          palette,
          () => Math.max(6, Math.min(20, terminal.rows - 6)),
        ),
        forced: () => ({ outcome: { kind: 'cancelled' } }),
      }, request.signal === undefined ? {} : { signal: request.signal })
      if (result.kind === 'cancelled') throw cancelledError()
      return result.answer
    },
  }))

  const appendLocalNotice = (notice: Notice): void => {
    transcript.apply({ kind: 'notice', notice })
    tui.requestRender()
  }

  // Slash lines go to dsh's command registry, never to the model (spec §3.5):
  // one AbortController per execution, all aborted at teardown. Only what the
  // durable log never carries is rendered locally — an unknown/unparsable
  // command (the service logs nothing for it) and a rejected execution (which
  // can reject before logging anything at all: a pre-aborted signal, a failed
  // command/run append).
  const commandRuns = new Set<AbortController>()
  // The one run dispose() must NOT abort: dsh invokes a command handler
  // synchronously inside `commands.execute` and re-checks the signal the
  // moment it returns. /exit's handler calls requestExit(), which from idle
  // disposes synchronously — so aborting here would make dsh log the
  // successful exit as `command/done {kind:'error'}`: a red notice live never
  // paints (the listener is already detached) but replay does (Ruling 5).
  // Only ever set across `execute`'s synchronous window.
  let executingRun: AbortController | undefined
  const executeSlash = (line: string): void => {
    const controllerAbort = new AbortController()
    commandRuns.add(controllerAbort)
    executingRun = controllerAbort
    try {
      void Promise.resolve(deps.commands.execute(bound, line, controllerAbort.signal))
        .then((execution) => {
          if (disposed || execution !== undefined) return   // logged results render via durable events (Ruling 5)
          appendLocalNotice({ text: `Unknown command: ${line.trim().split(/\s+/, 1)[0]}`, tone: 'warning' })
        })
        .catch((cause: unknown) => {
          if (disposed) return
          const detail = cause instanceof Error ? cause.message : String(cause)
          appendLocalNotice({ text: `Command failed: ${detail}`, tone: 'error' })
        })
        .finally(() => commandRuns.delete(controllerAbort))
    } finally {
      executingRun = undefined
    }
  }

  composer.onSubmit = (text) => {
    /* v8 ignore next -- defensive: dispose() tears down the terminal's input pipeline synchronously (tui.stop() -> terminal.stop()), so no keystroke can reach onSubmit once disposed is true; nothing outside this closure can invoke onSubmit directly to race it either */
    if (disposed) return
    if (text.startsWith('/')) executeSlash(text)
    else {
      const message = toUserMessage(text)
      // `bound`, never the constructor's `agent`: after a D8 rebind the
      // composer must talk to the session on screen.
      if (running) bound.steer(message)
      else bound.followup(message)
    }
    composer.editor.setText('')
    composer.editor.addToHistory(text)
    tui.requestRender()
  }

  let exitRequested = false
  // The goodbye (Ruling 12): dim + displayText, straight to the restored
  // terminal AFTER dispose() ran tui.stop() — user-exit path only, never
  // plugin teardown. `bound.id` is read here, at exit time, so a D8 rebind
  // names the session actually on screen.
  const farewell = (): void => {
    terminal.write(palette.dim(displayText(GOODBYE(bound.id))) + '\n')
    exit(0)
  }
  const requestExit = (): void => {
    if (exitRequested) return
    exitRequested = true
    // /exit and /quit reach this while a turn is running (the key bindings
    // never do): cancel first, then tear down once the agent is idle.
    if (running) {
      bound.cancel({ kind: 'user' })
      void bound.whenIdle().then(() => { void dispose().then(farewell) })
    } else {
      void dispose().then(farewell)
    }
  }

  const failureText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))
  const resumeFailed = (cause: unknown): void => appendLocalNotice({ text: `Resume failed: ${failureText(cause)}`, tone: 'error' })

  /** Task 14's title ladder assembled from whatever dsh actually mounted. The
   * projection members must stay ABSENT when their services are: their
   * presence is what picks the per-record cold ladder over the one batch. */
  const candidateServices = (query: SessionQueryFacet): SessionServices => {
    const { sessions, projections, projectionCache } = deps.services
    return {
      listSessions: (signal) => query.listSessions(signal),
      liveSession: (id) => sessions.get(id),
      ...(projections === undefined ? {} : { liveTitle: (session: unknown) => projections.snapshot(session).values.title }),
      ...(projectionCache === undefined ? {} : {
        cachedSnapshot: (header: SessionRecordLike['header']) => projectionCache.cachedSnapshot(header),
        coldSnapshot: (id: string, signal?: AbortSignal) => projectionCache.coldSnapshot(id, signal),
      }),
      readTitleSnapshots: (ids, signal) => query.readTitleSnapshots(ids, signal),
    }
  }

  const preflightFacets = (query: SessionQueryFacet): PreflightServices => ({
    agentStatus: () => bound.status,
    listSessions: () => query.listSessions(),
    readSession: (id) => query.readSession(id),
    listProviders: () => deps.services.llm.listProviders(),
  })

  /** D8's exact order: preflight → `process.chdir` BEFORE anything is torn
   * down (a refusal or a failed chdir leaves the whole UI as it was) → resume
   * → rebind → one local notice. */
  const resumeInto = async (query: SessionQueryFacet, picked: Promise<ResumeCandidate | undefined>): Promise<void> => {
    try {
      const candidate = await picked
      if (candidate === undefined) return // cancelled, or closed by a failed candidate build
      const target = await preflightResume(preflightFacets(query), candidate.id, { currentId: bound.id, cwd: process.cwd() })
      process.chdir(target.cwd)
      const handle = await deps.agents.resume({ resumeSessionId: target.id })
      bindAgent(handle.agent)
      appendLocalNotice({ text: `Resumed session ${target.id} · ${target.cwd}`, tone: 'info' })
    } catch (cause) {
      resumeFailed(cause)
    }
  }

  const openResume = (): void => {
    if (running) { appendLocalNotice({ text: RESUME_RUNNING, tone: 'warning' }); return }
    const query = deps.services.sessionQuery
    if (query === undefined) { appendLocalNotice({ text: RESUME_UNMOUNTED, tone: 'error' }); return }
    // The panel mounts in its own loading state and fills asynchronously;
    // `settle` is the manager's finish, so a failed fill can close it too.
    let settle!: (picked: ResumeCandidate | undefined) => void
    const panel = new ResumePanel((picked) => settle(picked), palette, (cwd) => cwd ?? WORKSPACE_UNSET)
    void resumeInto(query, panels.enqueue<ResumeCandidate | undefined>({
      create: (finish) => { settle = finish; return panel },
      forced: () => ({ outcome: undefined }),
    }))
    void (async () => {
      try {
        panel.setCandidates(await buildResumeCandidates(candidateServices(query), { currentId: bound.id, cwd: process.cwd() }))
        tui.requestRender()
      } catch (cause) {
        settle(undefined)
        resumeFailed(cause)
      }
    })()
  }

  /** `/clear` (Ruling 10): a real fresh session through talon-boot's own
   * composition, bound by the same machinery resume uses. */
  const newSession = async (): Promise<void> => {
    if (running) { appendLocalNotice({ text: CLEAR_RUNNING, tone: 'warning' }); return }
    try {
      const { agent: fresh } = await deps.createRootAgent()
      bindAgent(fresh)
      appendLocalNotice({ text: `Started a fresh session ${fresh.id}`, tone: 'info' })
    } catch (cause) {
      appendLocalNotice({ text: `New session failed: ${failureText(cause)}`, tone: 'error' })
    }
  }

  // Global (root-ctx) registration, Ruling 3: it survives Task 16's rebind,
  // and a single-UI process makes global equivalent to spec §3.5's agent
  // scoping. Every stateful answer is read at call time, so /status stays
  // truthful across status changes and rebinds.
  detachers.push(registerTalonCommands(deps.commands, {
    requestExit,
    statusLines: () => [`session ${bound.id}`, `workspace ${process.cwd()}`, `agent ${running ? 'running' : 'idle'}`],
    list: () => deps.commands.list(bound),
  }))
  detachers.push(registerSessionCommands(deps.commands, { openResume, newSession }))

  // Slash discovery: the provider reads the registry through this closure, so
  // it needs no rebuild when commands come and go (Ruling 4) — an already-open
  // menu just gets re-queried.
  composer.attachSlashCompletion(createSlashProvider(() => deps.commands.list(bound)))
  detachers.push(ctx.on('commands/change', () => composer.refreshCompletion()))

  detachers.push(tui.addInputListener((data) => {
    if (hasPanel()) return undefined // panels own 100% of input (spec D5)
    if (matchesKey(data, 'ctrl+c')) {
      if (running) { bound.cancel({ kind: 'user' }); return { consume: true } }
      if (composer.editor.getText() !== '') { composer.editor.setText(''); tui.requestRender(); return { consume: true } }
      requestExit()
      return { consume: true }
    }
    // 'escape' is exact/anchored-only in pi-tui 0.84.1 (controller ruling 6):
    // matchesKey checks `data === '\x1b'` or a fully `^...$`-anchored Kitty/
    // modifyOtherKeys escape encoding (dist/keys.js, the "escape" case of
    // matchesKey). Empirically verified against the real package — arrow
    // keys, alt+letter, home/end, F-keys, and bracketed-paste content (all
    // \x1b-prefixed) do NOT match; only a bare ESC byte or a full CSI-u/
    // modifyOtherKeys escape encoding does. No prefix-match guard needed.
    if (matchesKey(data, 'escape') && running) { bound.cancel({ kind: 'user' }); return { consume: true } }
    if (matchesKey(data, 'ctrl+l')) { tui.requestRender(true); return { consume: true } }
    if (matchesKey(data, 'ctrl+d') && composer.editor.getText() === '') {
      if (!running) requestExit()
      // Running: flash the interrupt-first hint (spec §6, carryover 3); the
      // next agent/status transition restores the normal hint via syncComposer.
      else { composer.flashHint(HINT_INTERRUPT_FIRST, 'warning'); tui.requestRender() }
      return { consume: true }
    }
    return undefined
  }))

  tui.start()

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    for (const detach of detachers.splice(0)) detach()
    for (const run of commandRuns) if (run !== executingRun) run.abort()
    panels.disposeAll()
    tui.stop()
  }

  return { dispose, panels, bindAgent }
}
