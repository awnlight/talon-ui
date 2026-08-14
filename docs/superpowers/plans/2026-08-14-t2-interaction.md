# talon-ui T2 Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** T2 rich interaction: inline panel system (PanelManager FIFO + guarded), the first real dsh terminal approval responder (D9), the user-questions provider (incl. plan-review intent), slash commands with autocomplete, resume selector with in-process resume, exit summary line — plus all 12 carryover items from the T0+T1 final review.

**Architecture:** Panels are plain pi-tui components mounted in a slot Container between the transcript and the composer (inline bottom-anchored, spec §4.4 — NOT pi-tui overlays). While a panel is active it holds `tui.setFocus` and the global key listener yields (spec D5). Backend modules (`src/backend/`) stay the only code touching dsh services; controllers receive explicit `*Deps` facets. Event subscriptions move to the ROOT plugin ctx with manual bound-agent identity filtering so in-process resume (D8) can rebind the UI to a new agent without re-registering scoped listeners.

**Tech Stack:** TypeScript strict ESM, Node >=22.19, pnpm, `@earendil-works/pi-tui@0.84.1`, vitest 3 + `@vitest/coverage-v8@3.2.7` + `@xterm/headless@5.5.0`, dsh packages source-linked from `../deepseek-harness` (must be built: `pnpm run build:lib:host` there first; treat dsh as read-only).

**Spec:** `docs/superpowers/specs/2026-08-13-talon-ui-design.md` (D5, D8, D9, D10, §3 contract signatures, §4.4 panels, §8 T2 acceptance row). Carryover: `docs/superpowers/plans/2026-08-14-t2-carryover.md` (all 12 items land here; item 10's spec edit included).

## Global Constraints

- Node engines `>=22.19.0`; `"type": "module"`; TypeScript `strict: true`. Relative imports always carry the `.js` suffix.
- Every untrusted string (model text, tool output, titles, question metadata, error chains) passes `displayText()` before styling (spec D7.8).
- Any rendered line wider than the terminal CRASHES TuiMainScreen (verified: `tui-main-screen.js:406`, throws + writes pi-crash.log). Every panel row must be truncated (`truncateToWidth`) or wrapped (`wrapPlain`) — no exceptions.
- No component constructs Text/Markdown or wraps text inside `render(width)` for committed cells; width-keyed caches invalidated only by state mutators, pinned by `.toBe` identity tests (spec §5.1). Live panels re-render freely (they are the mutating tail, like StreamingAssistantCell pre-settle).
- Mount-cap accounting counts CONTENT lines (logical, pre-wrap), O(1) per apply (spec §5.2 / I3).
- `setClearOnShrink(false)` stays; normal interaction (incl. panel open/close) must produce ZERO `\x1b[3J` scrollback wipes (D10; gated by Task 19).
- pi-tui `Text` defaults `paddingX=1, paddingY=1` — always pass explicit `0, 0`. `new Text('', 0, 0)` renders zero rows (true placeholder).
- Close panels with `tui.setFocus(composerEditor)`, NEVER `setFocus(null)` (pi-tui overlay-restore landmine, verified tui.js:206-241).
- UI copy is English, constants in the rendering file. Chinese only in docs.
- Per task: `pnpm test && pnpm typecheck && pnpm build` all green, then a conventional commit. Coverage gate (Task 1 onward): v8 per-file 100% on src/, unreachable lines `/* v8 ignore … -- reason */` with a reason.
- dsh contract facts below were verified against `deepseek-harness@master 47f943859b` (2026-08-14). If a signature disagrees at execution time, STOP and re-verify against the checkout; do not guess.

## T2 Rulings (recorded per the standing "TUI best practice + spec as authority" mandate)

1. **Panels are focused inline components, not overlays.** `PanelManager` owns a slot Container; active panel takes `setFocus`. hasOverlay()/showOverlay unused. (Spec §4.4; pi-tui focus semantics verified.)
2. **FramelessEditor strips its frame by border-sentinel filtering, not `slice(1,-1)`.** Autocomplete rows render AFTER the bottom border (verified editor.js:466-474), so positional slicing corrupts an open menu. `borderColor` is applied to border rows and nowhere else — prefix a `\x00` sentinel and drop rows starting with it. Content rows cannot start with `\x00` (Editor inserts only charCode >= 32).
3. **Root-ctx event registration + manual identity filter.** dsh dispatch is scope-filtered per agent; agent.ctx-scoped listeners would go deaf after an in-process rebind (D8). All talon subscriptions, the approval responder, the question provider, and command registration bind to the plugin's root ctx and filter by `bound` agent object identity (the D9/ACP pattern generalized). Commands register globally (rebind-safe; single-UI process makes this equivalent to spec §3.5's agent scoping — recorded in the spec touch-up, Task 18).
4. **Slash autocomplete is a talon-owned provider, not `CombinedAutocompleteProvider`.** Combined bundles @-file/fd machinery (T4 scope). Our provider mirrors upstream's `/`-branch exactly (fuzzyFilter over names, `prefix` includes the leading `/`, accept inserts `/name ` — verified autocomplete.js:205-283) and reads the command list through a closure, so `commands/change` needs no provider rebuild — only the visible-menu refresh nudge.
5. **Command results render from durable events** (`command/run`/`command/done` via translate), not from `execute()`'s return value — live and resume-replay renderings are byte-identical (the compaction-marker principle). Unknown-command feedback is local-only (the service logs nothing for it, verified).
6. **Approval enrichment: the command preview comes from the matching `tool/call` event** (by callId; ApprovalRequest itself carries only toolName/reason — verified). Controller keeps a bounded callId→preview map, cleared at turn end.
7. **Question dismissal throws `UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')`** — the exact code plan-mode narrows on (verified apiproxy:3718, plan-mode:357). Teardown rejects the same way. Approval teardown rejects with a plain Error → the service normalizes to `'unavailable'` (fail-closed); signal abort settles `'cancelled'`.
8. **Resume: old agent stays alive; only the UI binding moves** (apiproxy multi-session precedent). `process.chdir` runs before any teardown (D8); replay reads the LIVE `agent.session.events` after `agents.resume()` returns (not the preflight snapshot). Spec's "已 live" disable state then correctly blocks re-resuming it this run.
9. **Resume selector uses SelectList single-line rows** (spec §4.4) with meta folded into the two-column description; PgUp/PgDn omitted in v1 (SelectList has no paging; fuzzy filter is the navigator). Relative-time display: none — ISO timestamps (the old TUI precedent; no invented formatter).
10. **/clear = fresh session via the rebind machinery** (create with a fresh UUID, bind, empty transcript), sharing `createRootAgent` extracted from talon-boot. Not a visual-only wipe.
11. **tsconfig paths for dsh packages point at `lib/types/index.d.ts`** (skipLibCheck absorbs their cordis type imports; src-plane paths break `tsc` the way dsh-llm did). Value imports (`UserQuestionError`, `parseCommand`) resolve at vitest runtime via package-dir aliases (the proven dsh-session pattern).
12. **Goodbye line:** printed dim + displayText once, only on the user-exit path, after `tui.stop()`, via `terminal.write` (old-TUI contract). Copy: `` To resume: dsh --profile talon, then /resume — session <id> ``.

## Signature crib (verified 2026-08-14; quote-level facts)

```ts
// ── dsh (deepseek-harness@47f943859b), all packages 0.1.0-rc.5 ──
// @deepseek-ai/dsh-user-approval
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
interface ApprovalRequest { agent: Agent; toolName: string; callId?: CallId; reason?: string; signal?: AbortSignal }
// waterfall event 'approval/request'(req, next): return outcome to claim, next() to pass;
// throw/non-vocab → 'unavailable'; policy 'ask'|'never' decided service-side; requests only happen mid-turn.
// Durable: 'approval/asked' {id, toolName, callId?, reason?} · 'approval/decided' {id, outcome} · 'approval/policy' {policy, source?}

// @deepseek-ai/dsh-user-questions
interface AskUserQuestionOption { label: string; description?: string }
type AskUserQuestionIntent = { kind: 'plan-review'; approve: string }
interface AskUserQuestionItem { id: string; question: string; detail?: string; header?: string; options?: AskUserQuestionOption[]; multiSelect?: boolean; intent?: AskUserQuestionIntent }
interface AskUserQuestionAnswerItem { id: string; selected: string[]; custom?: string }
interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[] }
interface AskUserQuestionRequest { questions: AskUserQuestionItem[]; agent?: Agent; signal?: AbortSignal }
// ctx.userQuestions.registerProvider({ask}) → () => void; throws UserQuestionError('…','DUPLICATE_PROVIDER') synchronously.
// class UserQuestionError extends HarnessError { constructor(message, code, options?) }
// plan-review approval answer MUST be { selected: [intent.approve] } with NO custom.

// @deepseek-ai/dsh-commands
interface CommandDescriptor { name: string; description: string; input?: { hint: string } }
interface CommandInvocation { commandId: CommandId; agent: Agent; rawInput: string; signal: AbortSignal }
type CommandResult = { kind: 'success'; text?: string; sourceEventSeq?: number } | { kind: 'error'; text: string }
interface CommandDefinition { name: string /* ^[a-z][a-z0-9_-]*$ */; description: string; input?: { hint: string }; recordInput?: boolean; handler(i: CommandInvocation): CommandResult | Promise<CommandResult> }
// ctx.commands.register(def) → disposer (root ctx = global). list(agent) → CommandDescriptor[] (name-sorted).
// execute(agent, line, signal) → Promise<CommandExecution|undefined>: undefined = unparsable/unknown (nothing logged);
// handler throw → logs command/done error then RETHROWS to the caller. parseCommand(line) exported.
// Event 'commands/change'(): void (unscoped). Durable: 'command/run' {commandId,name,args?,source} · 'command/done' {commandId,kind,text?,sourceEventSeq?}

// @deepseek-ai/dsh-session-query
interface SessionRecord { header: SessionHeader; live: boolean; persisted: boolean } // newest-first
// ctx.sessionQuery.listSessions(signal?) → Promise<SessionRecord[]>; readSession(id) → Promise<{events: SessionEvent[] …}>
// readTitleSnapshots(ids, signal?) → Promise<({sessionId; status:'fulfilled'; value:{session; title?:{title:string …}}}|{sessionId; status:'rejected'; reason})[]>
// SessionHeader { version; id: SessionId; createdAt: number; cwd?: string; … } — NO updatedAt.

// @deepseek-ai/dsh-session-projection(+cache)
// ctx.sessionProjections.snapshot(liveSession) → { asOfSeq; values: { title?: string | null } }  (sync)
// ctx.sessionProjectionCache.cachedSnapshot(header) → ProjectionSnapshot | undefined  (sync, zero-I/O)
// ctx.sessionProjectionCache.coldSnapshot(id, signal?) → Promise<ProjectionSnapshot>  (rejects if no persisted log)

// @deepseek-ai/dsh-agent
interface AgentHandle { agent: Agent; dispose(): Promise<void> }
interface ResumeAgentOptions { resumeSessionId: SessionId; agentOptions?; signal?; setup? } // NO cwd field
// ctx.agents.resume(opts) → Promise<AgentHandle>; throws 'cannot resume: session persistence is not configured…' without sessionPersistence.
// 'agent/status' {agent, status:'idle'|'running'} · 'agent/created' {agent} — dispatch is scope-filtered per agent (Ruling 3).

// user/message event data = UserMessage { id, role:'user', content: ContentBlock[], source: MessageSource }
// source.kind === 'user' ⇔ real typed prompt (web user-rpc keeps kind 'user'). Injected kinds seen in-repo:
// 'plugin' | 'agent-instructions' | 'session-reference' | 'skill-catalog' | 'skill-invocation' | 'goal' | 'coordinator' | 'subagent-report' | 'subagent-settled'
// source may carry form: 'instructions'|'catalog'|'snapshot'|'notice'|'relay'|'recall'; form 'notice' carries summary: string.

// turn/end reasons today: completed | aborted{reason} | blocked | error{error: LlmFailure{message,code,…}} | max-tokens | interrupted (crash-repair only)

// ── pi-tui 0.84.1 ──
// Editor.render() rows: [topBorder, …content, bottomBorder, …autocompleteRows?] — completion AFTER bottom border.
// borderColor: (s)=>string public mutable, applied ONLY to border rows. isShowingAutocomplete(): boolean.
// setAutocompleteProvider(p): merges p.triggerCharacters ('/' rejected as trigger char; '/' handling is built into getSuggestions calls).
// interface AutocompleteItem { value; label; description? }  interface AutocompleteSuggestions { items; prefix }
// interface AutocompleteProvider { triggerCharacters?; getSuggestions(lines, cursorLine, cursorCol, {signal, force?}): Promise<AutocompleteSuggestions|null>; applyCompletion(lines,cursorLine,cursorCol,item,prefix): {lines;cursorLine;cursorCol}; shouldTriggerFileCompletion?(…): boolean }
// Enter on a '/'-prefixed completion applies AND falls through to submit (editor.js:564).
// SelectList: constructor(items: SelectItem[], maxVisible, theme: SelectListTheme, layout?) — items are constructor-only (rebuild to change);
//   handleInput consumes up/down (wrap), enter→onSelect, escape/ctrl+c→onCancel; NO paging keys. Selected row style = theme.selectedText (supply reverse video).
//   theme: { selectedPrefix (dead but required), selectedText, description, scrollInfo, noMatch }.
// Input: single-line editor; getValue/setValue/handleInput/render; onSubmit?, onEscape?; implements Focusable {focused}.
// fuzzyFilter(items, query, getText) exported (all tokens must match; best first). matchesKey(data, '1'|'c'|'space'|'tab'|'shift+tab'|'pageUp'|'pageDown'|…) covers raw bytes AND Kitty CSI-u.
// Input dispatch order: addInputListener listeners FIRST (can consume), then focused component only. Keystrokes auto-trigger an immediate render.
// Component.invalidate() is REQUIRED. Spacer(n) renders n empty strings.
```

---

### Task 1: Coverage gate (per-file 100%) + turn-end reason table tests

Carryover items 9 and 5. Establishes the gate FIRST so every later T2 task lands under it.

**Files:**
- Modify: `package.json` (add devDep `@vitest/coverage-v8@3.2.7` — 4.x is incompatible with vitest 3, verified), `vitest.config.ts`
- Modify: `tests/translate.spec.ts`, `tests/controller.spec.ts`, `tests/headless-terminal.spec.ts`, `tests/boot.spec.ts`, `tests/index.spec.ts`
- Modify: `src/index.ts`, `src/ui/composer/composer.ts` (v8-ignore annotations only)

**Interfaces:**
- Produces: `pnpm test` enforces v8 per-file 100% (statements/branches/functions/lines) over `src/**`, excluding the type-only `src/backend/app-events.ts`.

Measured baseline (2026-08-14): boot.ts 12.9%, index.ts 62%, translate branches 74%, headless-terminal funcs 64%, minor branch gaps in composer/streaming/transcript/cells.

- [ ] **Step 1: Install the coverage provider and configure the gate**

```bash
pnpm add -D @vitest/coverage-v8@3.2.7
```

In `vitest.config.ts`, extend `test`:

```ts
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.snapshot.ts'],
    pool: 'forks',
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/backend/app-events.ts'], // type-only module: erases to an empty runtime file, v8 reports 0/0
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
```

- [ ] **Step 2: Run to see the gate fail with the measured gaps**

Run: `pnpm test`
Expected: FAIL — threshold errors naming boot.ts, index.ts, translate.ts, headless-terminal.ts, composer.ts, streaming.ts, transcript.ts, cells.ts.

- [ ] **Step 3: Table-driven turn-end reason tests (carryover 5) + translate branch backfill**

Append to `tests/translate.spec.ts`:

```ts
describe('turn-end reason table (spec §3.2 exhaustive-with-named-default)', () => {
  const cases: [string, unknown, { text: string; tone: string } | undefined][] = [
    ['completed', { kind: 'completed' }, undefined],
    ['aborted', { kind: 'aborted', reason: { kind: 'user' } }, { text: 'Turn cancelled.', tone: 'warning' }],
    ['interrupted', { kind: 'interrupted' }, { text: 'Turn cancelled.', tone: 'warning' }],
    ['max-tokens', { kind: 'max-tokens' }, { text: 'Turn stopped: max tokens reached.', tone: 'warning' }],
    ['blocked', { kind: 'blocked' }, { text: 'Turn blocked.', tone: 'warning' }],
    ['error', { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, { text: 'boom', tone: 'error' }],
    ['error-no-message', { kind: 'error', error: {} }, { text: 'Turn failed.', tone: 'error' }],
    ['future-kind', { kind: 'paused-by-plugin' }, { text: 'Turn ended: paused-by-plugin.', tone: 'warning' }],
  ]
  for (const [name, reason, notice] of cases) {
    it(`maps ${name}`, () => {
      const events = translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason } })
      expect(events).toEqual([{ kind: 'turn-end', turn: 1, notice }])
    })
  }
})
```

Also add small cases pinning `textOf` fallbacks: `user/message` with `content: undefined`, a text block with `text: undefined`, an `assistant/chunk` with unknown chunk type, `assistant/message` with `message: undefined`, and a `stream-delta` chunk with `index`/`text` undefined (covers the `?? 0`/`?? ''` branches).

- [ ] **Step 4: Backfill controller, composer, streaming, transcript, cells, headless-terminal gaps**

Add to `tests/controller.spec.ts` (covers controller.ts:107-108, the running-exit wait path):

```ts
  it('Ctrl+C exit while running cancels first, then exits after idle', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    let resolveIdle!: () => void
    agent.whenIdle = () => new Promise<void>((r) => { resolveIdle = r })
    terminal.input('\x03') // cancels
    terminal.input('\x03') // second press while still running: requests exit, waits for idle
    expect(exit).not.toHaveBeenCalled()
    resolveIdle()
    await new Promise((r) => setTimeout(r, 10))
    expect(exit).toHaveBeenCalledWith(0)
    await controller.dispose()
  })
```

In `tests/headless-terminal.spec.ts`, add one test invoking the pass-through Terminal methods (`moveBy`, `clearLine`, `clearFromCursor`, `clearScreen`, `drainInput`, `triggerResize`, `kittyProtocolActive`, `setTitle`, `setProgress`, hide/show cursor) and asserting the snapshot header reflects title/progress/cursor; and one test with two `waitForFrame` waiters where only one is satisfied by the next frame (covers the waiter-filter branch at headless-terminal.ts:71).

For `streaming.ts:64` (`b.text ?? ''` on settle) settle with `[{ type: 'text' }]` and assert render shows only the header plus an empty line. For `transcript.ts:72,101` drive a `turn-end` notice as the FIRST event (no spacer branch) and a `stream-delta` arriving when a live cell already exists for a different key. For `cells.ts` branch gaps, render a NoticeCell of each tone and a UserMessageCell at width 1.

In `src/ui/composer/composer.ts`, annotate the defensive guard (removed by Task 4):

```ts
    /* v8 ignore next 2 -- defensive: upstream Editor always frames content with 2 border rows (verified 0.84.1); rewritten by T2 Task 4 */
    if (rows.length >= 2) return rows.slice(1, -1)
    return rows
```

- [ ] **Step 5: boot.ts run() tests via vi.mock of the dynamic import**

Append to `tests/boot.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/boot.ts'

vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn(() => () => {}) }))

function bootCtx(overrides: Partial<{ roots: unknown[]; services: Record<string, unknown> }> = {}) {
  const created: unknown[] = []
  const ctx = {
    created,
    agents: {
      roots: () => overrides.roots ?? [],
      create: vi.fn(async (opts: unknown) => { created.push(opts); return { agent: { id: (opts as any).sessionId }, dispose: async () => {} } }),
    },
    get: (name: string) => (overrides.services ?? {
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    })[name],
  }
  return ctx
}

describe('talon-boot run()', () => {
  afterEach(() => vi.restoreAllMocks())
  it('creates the root agent with cwd meta and the default model selection', async () => {
    const ctx = bootCtx()
    apply(ctx as never, {})
    await vi.waitFor(() => expect(ctx.agents.create).toHaveBeenCalledOnce())
    const opts = (ctx.created[0] as { sessionId: string; meta: { cwd: string }; agentOptions: { provider: string; model: string }; setup: (c: unknown) => void })
    expect(opts.sessionId).toMatch(/^session-/)
    expect(opts.meta.cwd).toBe(process.cwd())
    expect(opts.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    opts.setup({}) // exercises installModelSelection wiring
  })
  it('skips creation when the configured session already exists', async () => {
    const ctx = bootCtx({ roots: [{ id: 'pinned' }] })
    apply(ctx as never, { sessionId: 'pinned' })
    await new Promise((r) => setTimeout(r, 10))
    expect(ctx.agents.create).not.toHaveBeenCalled()
  })
  it('awaits the loader before creating', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const ctx = bootCtx({ services: {
      loader: { await: () => gate },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    } })
    apply(ctx as never, {})
    await new Promise((r) => setTimeout(r, 10))
    expect(ctx.agents.create).not.toHaveBeenCalled()
    release()
    await vi.waitFor(() => expect(ctx.agents.create).toHaveBeenCalledOnce())
  })
  it('fails loud (stderr + exit 1) when agentDefaultModel is missing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    apply(bootCtx({ services: {} }) as never, {})
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    expect(stderr.mock.calls.some(([s]) => String(s).includes('agentDefaultModel'))).toBe(true)
  })
})
```

- [ ] **Step 6: index.ts apply() TTY-guard test + justified ignore for the live mount body**

Append to `tests/index.spec.ts`:

```ts
  it('apply refuses a non-TTY stdin/stdout with the documented message', () => {
    const stdin = vi.spyOn(process.stdin, 'isTTY', 'get').mockReturnValue(false as never)
    const stdout = vi.spyOn(process.stdout, 'isTTY', 'get').mockReturnValue(true as never)
    expect(() => apply({ agents: { roots: () => [] } } as never, {})).toThrow(/interactive terminal/)
    stdin.mockRestore(); stdout.mockRestore()
  })
```

In `src/index.ts`, wrap the live-mount internals that require a real TTY/ProcessTerminal:

```ts
  /* v8 ignore start -- live TTY mount: ProcessTerminal + Cordis effect wiring cannot run off-TTY; exercised end-to-end by tests/e2e/tty-smoke (real PTY boot, T2 Task 20) */
  const start = (agent: any): void => {
    …existing body unchanged…
  }
  /* v8 ignore stop */
```

Cover `matches`/`agent/created` selection by extracting nothing — instead add a test driving `apply` with mocked TTY getters returning true and a fake ctx whose `effect` records the mount, emitting `agent/created` for a non-matching then matching agent. If `ProcessTerminal` construction inside `start` still executes under the fake (it does — it only touches process streams on `start()`), assert the effect ran once for the matching agent; otherwise keep `start` under the ignore block and assert only listener detach behavior (`off()` called once — expose nothing; assert via the fake's listener list length returning to zero after match).

- [ ] **Step 7: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS — coverage table all-100 for every file under src/ (app-events.ts excluded).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "test: per-file 100% v8 coverage gate + turn-end reason tables (T2 carryover 5, 9)"
```

### Task 2: Snapshot checkpoint helper + closed manifest (carryover 4)

**Files:**
- Create: `tests/helpers/checkpoint.ts`
- Create: `tests/manifest.spec.ts`
- Modify: `tests/app.snapshot.ts`

**Interfaces:**
- Produces: `CHECKPOINTS: readonly string[]` (the single declared universe of snapshot names), `checkpoint(name, terminal): Promise<void>` (embeds themeViolations — the invariant lives in the helper, not in each test), `observedCheckpoints: string[]`, `expectObserved(owned: readonly string[]): void` for per-file afterAll. Every later snapshot task ADDS its name to `CHECKPOINTS` and calls `checkpoint()`.

Fork-pool note: test files run in separate processes, so "observed" is tracked per file and the three-way equality decomposes into (a) per-file: observed === that file's declared subset, (b) global: `CHECKPOINTS` === the `.expected.txt` files on disk (manifest.spec.ts), (c) per-call: name must be declared. Together they pin declared = observed = disk.

- [ ] **Step 1: Write the helper**

```ts
// tests/helpers/checkpoint.ts
/** Semantic-snapshot checkpoint discipline (spec §7.1): the theme invariant
 * is embedded HERE so no checkpoint can forget it, and the name must be
 * pre-declared so the manifest spec can prove declared = observed = disk. */
import { expect } from 'vitest'
import type { HeadlessTerminal } from '../../src/testing/headless-terminal.ts'

export const CHECKPOINTS = [
  'conversation-roundtrip',
] as const

export type CheckpointName = (typeof CHECKPOINTS)[number]

export const observedCheckpoints: string[] = []

export async function checkpoint(name: CheckpointName, terminal: HeadlessTerminal): Promise<void> {
  expect(CHECKPOINTS, `checkpoint "${name}" must be declared in CHECKPOINTS`).toContain(name)
  observedCheckpoints.push(name)
  expect(terminal.themeViolations(), `theme violations at checkpoint "${name}"`).toEqual([])
  await expect(terminal.snapshot()).toMatchFileSnapshot(`snapshots/${name}.expected.txt`)
}

/** Call from afterAll in every file that snapshots: pins observed === owned. */
export function expectObserved(owned: readonly CheckpointName[]): void {
  expect([...observedCheckpoints].sort()).toEqual([...owned].sort())
}
```

Note: `toMatchFileSnapshot` resolves relative to the CALLING test file, so snapshot spec files must live directly in `tests/` (they do; keep it that way).

- [ ] **Step 2: Write the manifest spec**

```ts
// tests/manifest.spec.ts
/** Closed-manifest law (spec §7.1): the declared checkpoint universe and the
 * .expected.txt files on disk are the same set — no orphan snapshots, no
 * undeclared checkpoints. */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKPOINTS } from './helpers/checkpoint.ts'

describe('snapshot manifest', () => {
  it('declared checkpoints and .expected.txt files are the same set', () => {
    const dir = fileURLToPath(new URL('./snapshots', import.meta.url))
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.expected.txt')).map((f) => f.replace(/\.expected\.txt$/, '')).sort()
    expect(onDisk).toEqual([...CHECKPOINTS].sort())
  })
})
```

- [ ] **Step 3: Migrate app.snapshot.ts to the helper**

Replace its local `CHECKPOINTS` const and inline assertions:

```ts
import { afterAll, describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'
import { checkpoint, expectObserved } from './helpers/checkpoint.ts'

const OWNED = ['conversation-roundtrip'] as const
afterAll(() => expectObserved(OWNED))
```

…and in the test body replace the `themeViolations` + `toMatchFileSnapshot` pair with `await checkpoint('conversation-roundtrip', terminal)`.

- [ ] **Step 4: Verify green, then verify the manifest actually bites**

Run: `pnpm test`
Expected: PASS. Then temporarily drop a stray file `tests/snapshots/orphan.expected.txt`, run `pnpm vitest run tests/manifest.spec.ts` — expected FAIL naming the orphan; delete it, rerun, PASS. (Manual red-proof; do not commit the orphan.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: checkpoint helper with embedded theme invariant + closed snapshot manifest (T2 carryover 4)"
```

---

### Task 3: Transcript housekeeping — spaceBeforeNewCell + narrow-width trim pin (carryover 6, 7)

**Files:**
- Modify: `src/ui/transcript/transcript.ts`
- Modify: `tests/transcript.spec.ts`

**Interfaces:**
- Produces: private `spaceBeforeNewCell(): void` replacing the four duplicated spacer guards; the mount-cap accounting comment corrected to state the CONTENT-line law (the trim marker counts as 1 content line by definition — the "wrap underestimate" concern from the carryover dissolves under that law, and the test pins it).

- [ ] **Step 1: Write the failing tests**

```ts
  it('extracts one spacer rule: a spacer precedes every new cell except the first', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'user-message', text: 'a' })                       // no spacer before the first
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'x' })
    t.apply({ kind: 'turn-end', turn: 1, notice: { text: 'Turn blocked.', tone: 'warning' } })
    const rows = t.container.render(40)
    expect(rows.filter((r) => r === '').length).toBe(2)                // exactly one blank between each pair
  })
  it('trim at narrow width: marker accounts as 1 content line and the cap keeps bounding', () => {
    const t = new Transcript(createPalette(false), { mountCapLines: 12 })
    for (let i = 0; i < 30; i++) t.apply({ kind: 'user-message', text: `message number ${i} that is long` })
    // content-line accounting is width-free; at width 24 the marker wraps to 2 visual rows — allowed
    const rows = t.container.render(24)
    expect(rows.join('\n')).toContain('… earlier history')
    expect(t.mountedLines(200)).toBeLessThanOrEqual(12 + 2)            // cap respected in content terms (+marker, +trailing spacer slack)
  })
```

- [ ] **Step 2: Run to verify the first fails**

Run: `pnpm vitest run tests/transcript.spec.ts`
Expected: the spacer test FAILS only if current behavior differs — if both pass immediately, they are pins; proceed (the refactor must keep them green).

- [ ] **Step 3: Refactor**

In `transcript.ts` add and use:

```ts
  /** One rule, four former call sites: every new cell is preceded by a
   * one-line spacer unless it is the very first child (spec §4.1 spacing). */
  private spaceBeforeNewCell(): void {
    if (this.container.children.length > 0) this.addChild(new Spacer(1), SPACER_LINES)
  }
```

Replace all four `if (this.container.children.length > 0) this.addChild(new Spacer(1), SPACER_LINES)` occurrences. Update the stale header comment ("Running total mirroring container.render(width).length") to state the real law: *the running total mirrors CONTENT lines (logical, pre-wrap); visual rows may exceed it by the wrap factor — bounded, by design (D10). The trim marker is one content line.*

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS (including the `.toBe` cache-identity pins already in the suite).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: single spaceBeforeNewCell rule + content-line trim accounting pin (T2 carryover 6, 7)"
```

---

### Task 4: FramelessEditor — autocomplete-safe frame stripping (carryover 1, HARD PREREQUISITE)

No autocompleteProvider may be wired anywhere before this task lands.

**Files:**
- Modify: `src/ui/composer/composer.ts`
- Modify: `tests/composer.spec.ts`

**Interfaces:**
- Produces: `FramelessEditor.render()` that survives `autocompleteState` being active. Mechanism (Ruling 2): constructor sets `this.borderColor = (s) => BORDER_SENTINEL + s`; render filters `rows.filter((r) => !r.startsWith(BORDER_SENTINEL))`. Border rows are built as `borderColor('─').repeat(width)` (plain) or `borderColor(scrollBorder)` (scrolled) — both start with the sentinel; content/autocomplete rows are padding+text and cannot start with `\x00` (Editor only inserts charCode >= 32).

- [ ] **Step 1: Write the failing test**

```ts
  it('keeps autocomplete rows and drops exactly the two border rows (T2 carryover 1)', async () => {
    const term = new HeadlessTerminal(60, 20)
    const tui = new TuiMainScreen(term)
    const palette = createPalette(false)
    const composer = new Composer(tui, palette)
    composer.editor.setAutocompleteProvider({
      async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
        const before = (lines[cursorLine] ?? '').slice(0, cursorCol)
        if (!before.startsWith('/')) return null
        return { items: [{ value: 'help', label: 'help', description: 'list commands' }, { value: 'status', label: 'status' }], prefix: before }
      },
      applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
    })
    tui.setFocus(composer.editor)
    tui.start()
    term.input('/')
    await vi.waitFor(() => expect(composer.editor.isShowingAutocomplete()).toBe(true))
    const rows = composer.editor.render(58)
    const text = rows.join('\n')
    expect(text).toContain('help')                    // completion rows survive
    expect(text).toContain('status')
    expect(rows.some((r) => /─{10,}/.test(r))).toBe(false) // no border row leaked into the middle
    expect(text).not.toContain('\x00')                // sentinel never escapes
    tui.stop()
  })
```

Also keep/adjust the existing no-completion pin test: closed-menu render still has no `─` runs and no top/bottom border.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/composer.spec.ts`
Expected: FAIL — with `slice(1, -1)` the bottom border remains mid-array (the `─{10,}` assertion) and the last completion row is cut.

- [ ] **Step 3: Implement**

```ts
/** Marks upstream border rows for removal. Border rows are the ONLY output
 * borderColor touches (verified pi-tui 0.84.1 editor.js:382,410,461), and
 * content rows cannot start with \x00 (Editor inserts only charCode >= 32),
 * so filtering by leading sentinel strips exactly the frame — with or
 * without autocomplete rows appended after the bottom border. */
const BORDER_SENTINEL = '\x00'

class FramelessEditor extends Editor {
  render(width: number): string[] {
    return super.render(width).filter((row) => !row.startsWith(BORDER_SENTINEL))
  }
}
```

In the `Composer` constructor change the theme to `borderColor: (s) => BORDER_SENTINEL + s` (replacing the identity note). Delete the old slice logic and its v8-ignore from Task 1.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: FramelessEditor strips frame by border sentinel, autocomplete-safe (T2 carryover 1)"
```

### Task 5: PanelManager (FIFO + guarded) + controller integration

**Files:**
- Create: `src/ui/panels/panel-manager.ts`, `src/ui/panels/panel-rule.ts`
- Modify: `src/app/controller.ts`, `src/index.ts`
- Create: `tests/panel-manager.spec.ts`

**Interfaces:**
- Produces:

```ts
// src/ui/panels/panel-manager.ts
export type PanelForcedReason = 'owner-disposed' | 'aborted'
export interface PanelSpec<T> {
  /** Build the panel; call finish(outcome) exactly once to close it. */
  create(finish: (outcome: T) => void): Component
  /** Outcome/error to settle with when the MANAGER closes the panel (teardown, signal abort). */
  forced(reason: PanelForcedReason): { outcome: T } | { error: unknown }
}
export class PanelManager {
  readonly container: Container                  // mount between transcript and composer
  constructor(host: { setFocus(c: Component | null): void; focusHome(): Component; requestRender(): void; onActiveChange?(active: boolean): void })
  enqueue<T>(spec: PanelSpec<T>, opts?: { signal?: AbortSignal }): Promise<T>
  get active(): Component | undefined            // the GUARDED wrapper (controller's hasPanel probe)
  disposeAll(): void                             // settle everything with forced('owner-disposed')
}
// src/ui/panels/panel-rule.ts
export function panelRule(title: string, width: number, palette: Palette): string
```

- Behavior contract: single active panel; later enqueues queue FIFO. Activation mounts the guarded component into `container` and takes focus; close (finish/forced/crash) unmounts, settles, then activates the next queued panel or returns focus to `focusHome()` (NEVER `setFocus(null)` — Ruling/landmine). A crash in the active panel's render/handleInput settles that panel's promise as rejected and CONTINUES the queue (guarded law, spec §4.4). `opts.signal` abort: active → close + settle `forced('aborted')`; queued → remove + settle the same. `onActiveChange` fires on every active↔inactive transition (drives the composer's waiting state).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/panel-manager.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { Container, Text, type Component } from '@earendil-works/pi-tui'
import { PanelManager } from '../src/ui/panels/panel-manager.ts'
import { panelRule } from '../src/ui/panels/panel-rule.ts'
import { createPalette } from '../src/theme/palette.ts'

function host() {
  const home = new Text('', 0, 0)
  const focus: (Component | null)[] = []
  const activeChanges: boolean[] = []
  return {
    home, focus, activeChanges,
    api: {
      setFocus: (c: Component | null) => focus.push(c),
      focusHome: () => home,
      requestRender: () => {},
      onActiveChange: (a: boolean) => activeChanges.push(a),
    },
  }
}
const textPanel = (label: string) => (finish: (o: string) => void): Component =>
  new (class extends Text { handleInput(data: string): void { finish(`${label}:${data}`) } })(label, 0, 0)

describe('PanelManager', () => {
  it('FIFO: second panel activates only after the first finishes; focus returns home at the end', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const first = pm.enqueue({ create: textPanel('a'), forced: () => ({ outcome: 'forced-a' }) })
    const second = pm.enqueue({ create: textPanel('b'), forced: () => ({ outcome: 'forced-b' }) })
    expect(pm.container.render(20).join('\n')).toContain('a')
    expect(pm.container.render(20).join('\n')).not.toContain('b')
    pm.active!.handleInput!('x')
    expect(await first).toBe('a:x')
    expect(pm.container.render(20).join('\n')).toContain('b')
    pm.active!.handleInput!('y')
    expect(await second).toBe('b:y')
    expect(pm.active).toBeUndefined()
    expect(h.focus.at(-1)).toBe(h.home)                       // never null
    expect(h.focus).not.toContain(null)
    expect(h.activeChanges).toEqual([true, false])            // one active window spanning both panels
  })
  it('a crashing panel settles as rejected and the queue continues (guarded law)', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const bad = pm.enqueue<string>({
      create: () => new (class extends Text { render(): string[] { throw new Error('panel boom') } })('x', 0, 0),
      forced: () => ({ outcome: 'never' }),
    })
    const good = pm.enqueue({ create: textPanel('ok'), forced: () => ({ outcome: 'forced' }) })
    expect(pm.container.render(20).join('\n')).toContain('ok') // crash happened during this render; queue advanced
    await expect(bad).rejects.toThrow('panel boom')
    pm.active!.handleInput!('z')
    expect(await good).toBe('ok:z')
  })
  it('signal abort settles active and queued panels with forced("aborted")', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const ctl = new AbortController()
    const active = pm.enqueue({ create: textPanel('a'), forced: (r) => ({ outcome: `a-${r}` }) }, { signal: ctl.signal })
    const queued = pm.enqueue({ create: textPanel('b'), forced: (r) => ({ outcome: `b-${r}` }) }, { signal: ctl.signal })
    ctl.abort()
    expect(await active).toBe('a-aborted')
    expect(await queued).toBe('b-aborted')
    expect(pm.active).toBeUndefined()
  })
  it('pre-aborted signal settles immediately without mounting', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const ctl = new AbortController(); ctl.abort()
    expect(await pm.enqueue({ create: textPanel('a'), forced: (r) => ({ outcome: r }) }, { signal: ctl.signal })).toBe('aborted')
    expect(pm.active).toBeUndefined()
  })
  it('disposeAll settles with owner-disposed, supporting error results', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    const p = pm.enqueue<string>({ create: textPanel('a'), forced: () => ({ error: new Error('torn down') }) })
    pm.disposeAll()
    await expect(p).rejects.toThrow('torn down')
  })
  it('finish is idempotent — a second call is ignored', async () => {
    const h = host()
    const pm = new PanelManager(h.api)
    let close!: (o: string) => void
    const p = pm.enqueue<string>({ create: (finish) => { close = finish; return new Text('a', 0, 0) }, forced: () => ({ outcome: 'f' }) })
    close('one'); close('two')
    expect(await p).toBe('one')
    expect(pm.active).toBeUndefined()
  })
  it('panelRule renders a width-exact dim rule with the title', () => {
    const line = panelRule('approval', 30, createPalette(false))
    expect(line).toBe('─ approval ' + '─'.repeat(19))
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/panel-manager.spec.ts`
Expected: FAIL — modules do not exist.

- [ ] **Step 3: Implement**

```ts
// src/ui/panels/panel-rule.ts
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'

/** Shared inline-panel title rule: `─ title ────…` exactly `width` cols (spec §4.4). */
export function panelRule(title: string, width: number, palette: Palette): string {
  const safe = Math.max(1, width)
  const label = truncateToWidth(`─ ${displayText(title)} `, safe, '…')
  return palette.dim(label + '─'.repeat(Math.max(0, safe - visibleWidth(label))))
}
```

```ts
// src/ui/panels/panel-manager.ts
/** Inline bottom-anchored panel system (spec §4.4): ONE active panel, FIFO
 * queue, guarded execution (a crashing panel closes only itself), focus held
 * for the panel's lifetime and returned to focusHome() — never to null (the
 * pi-tui overlay-restore landmine). Panels own 100% of the keyboard while
 * active (spec D5): the controller's global listener checks `active`. */
import { Container, type Component } from '@earendil-works/pi-tui'

export type PanelForcedReason = 'owner-disposed' | 'aborted'
export interface PanelSpec<T> {
  create(finish: (outcome: T) => void): Component
  forced(reason: PanelForcedReason): { outcome: T } | { error: unknown }
}
interface Entry<T> {
  spec: PanelSpec<T>
  resolve(v: T): void
  reject(e: unknown): void
  signal: AbortSignal | undefined
  onAbort: (() => void) | undefined
  settled: boolean
}

/** Crash barrier: any throw from the wrapped panel settles its entry and the
 * queue continues (spec §4.4 guarded law). Focus flag forwards so an inner
 * Input still shows its cursor. */
class GuardedPanel implements Component {
  constructor(private readonly inner: Component, private readonly onCrash: (error: unknown) => void) {}
  get focused(): boolean { return (this.inner as { focused?: boolean }).focused ?? false }
  set focused(value: boolean) { const i = this.inner as { focused?: boolean }; if ('focused' in i) i.focused = value }
  render(width: number): string[] {
    try { return this.inner.render(width) } catch (error) { this.onCrash(error); return [] }
  }
  handleInput(data: string): void {
    try { this.inner.handleInput?.(data) } catch (error) { this.onCrash(error) }
  }
  invalidate(): void {
    try { this.inner.invalidate() } catch { /* surfaces on next render */ }
  }
}

export class PanelManager {
  readonly container = new Container()
  private queue: Entry<never>[] = []
  private current: { entry: Entry<never>; guarded: GuardedPanel } | undefined

  constructor(private readonly host: {
    setFocus(c: Component | null): void
    focusHome(): Component
    requestRender(): void
    onActiveChange?(active: boolean): void
  }) {}

  get active(): Component | undefined { return this.current?.guarded }

  enqueue<T>(spec: PanelSpec<T>, opts?: { signal?: AbortSignal }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry<T> = { spec, resolve, reject, signal: opts?.signal, onAbort: undefined, settled: false }
      if (entry.signal?.aborted) { this.settleForced(entry, 'aborted'); return }
      if (entry.signal) {
        entry.onAbort = () => this.forceClose(entry as Entry<never>, 'aborted')
        entry.signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.queue.push(entry as Entry<never>)
      this.activateNext()
    })
  }

  disposeAll(): void {
    const current = this.current
    this.current = undefined
    const drained = [...(current ? [current.entry] : []), ...this.queue.splice(0)]
    this.container.clear()
    for (const entry of drained) this.settleForced(entry, 'owner-disposed')
    // No focus restore here: teardown callers are unmounting the whole tree.
  }

  private activateNext(): void {
    if (this.current) return
    const entry = this.queue.shift()
    if (!entry) return
    const wasIdle = true
    const guarded = new GuardedPanel(
      this.buildOrCrash(entry),
      (error) => this.settleAndAdvance(entry, () => { if (!entry.settled) { entry.settled = true; entry.reject(error) } }),
    )
    this.current = { entry, guarded }
    this.container.addChild(guarded)
    this.host.setFocus(guarded)
    if (wasIdle) this.host.onActiveChange?.(true)
    this.host.requestRender()
  }

  private buildOrCrash(entry: Entry<never>): Component {
    return entry.spec.create(((outcome: never) => {
      this.settleAndAdvance(entry, () => { if (!entry.settled) { entry.settled = true; entry.resolve(outcome) } })
    }) as never)
  }

  private settleAndAdvance(entry: Entry<never>, settle: () => void): void {
    entry.signal?.removeEventListener('abort', entry.onAbort!)
    settle()
    if (this.current?.entry === entry) {
      this.container.removeChild(this.current.guarded)
      this.current = undefined
      if (this.queue.length > 0) {
        this.activateNext()
        return
      }
      this.host.setFocus(this.host.focusHome())
      this.host.onActiveChange?.(false)
      this.host.requestRender()
    }
  }

  private forceClose(entry: Entry<never>, reason: PanelForcedReason): void {
    if (entry.settled) return
    if (this.current?.entry !== entry) {
      const i = this.queue.indexOf(entry)
      if (i >= 0) this.queue.splice(i, 1)
      this.settleForced(entry, reason)
      return
    }
    this.settleAndAdvance(entry, () => this.settleForced(entry, reason))
  }

  private settleForced(entry: Entry<never>, reason: PanelForcedReason): void {
    if (entry.settled) return
    entry.settled = true
    entry.signal?.removeEventListener('abort', entry.onAbort!)
    const result = entry.spec.forced(reason)
    if ('outcome' in result) entry.resolve(result.outcome as never)
    else entry.reject(result.error)
  }
}
```

Implementation note: the `onActiveChange` transition pairing in `settleAndAdvance`/`activateNext` must produce exactly one `true` when the manager goes non-empty and one `false` when it drains (the FIFO test pins `[true, false]` across two back-to-back panels) — gate the `true` on "no current AND queue was empty before push" or track an `activeWindow` boolean; the pinned test is the contract.

- [ ] **Step 4: Wire into the controller**

In `src/app/controller.ts`:
- Add a `panelSlot`/manager and mount order: transcript, panels, composer:

```ts
  const panels = new PanelManager({
    setFocus: (c) => tui.setFocus(c),
    focusHome: () => composer.editor,
    requestRender: () => tui.requestRender(),
    onActiveChange: (active) => {
      composer.setState(active ? 'waiting' : running ? 'streaming' : 'idle')
      tui.requestRender()
    },
  })
  tui.addChild(transcript.container)
  tui.addChild(panels.container)
  tui.addChild(composer.container)
```

- Replace `const hasPanel = (): boolean => false` with `const hasPanel = (): boolean => panels.active !== undefined`.
- `agent/status` handler: when a panel is active keep the waiting rule color (`composer.setState(panels.active ? 'waiting' : …)`).
- `dispose()` calls `panels.disposeAll()` before `tui.stop()`.
- **Root-ctx flip (Ruling 3):** in `src/index.ts` `start()`, pass `ctx: anyCtx` (the plugin root ctx) instead of `agent.ctx ?? ctx`, and keep the existing session-identity filter in the controller (it becomes the ONLY filter — required for D8 rebinding later). Update the `ControllerDeps.ctx` doc comment accordingly.
- Return `panels` from `createController`'s closure scope for later tasks (add it to the returned object: `return { dispose, panels }` and widen the return type to `{ dispose(): Promise<void>; panels: PanelManager }`).

Add a controller test:

```ts
  it('global keys yield while a panel is active (spec D5)', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    void controller.panels.enqueue({ create: () => new Text('panel', 0, 0), forced: () => ({ outcome: undefined }) })
    terminal.input('\x03')                       // Ctrl+C must NOT reach the exit path
    await new Promise((r) => setTimeout(r, 10))
    expect(exit).not.toHaveBeenCalled()
    expect(agent.cancelled.length).toBe(0)
    await controller.dispose()
  })
```

- [ ] **Step 5: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: PanelManager (FIFO + guarded + focus discipline) wired into the controller"
```

### Task 6: dsh type plumbing + ApprovalPanel component

**Files:**
- Modify: `tsconfig.json`, `vitest.config.ts`
- Create: `src/ui/panels/approval-panel.ts`
- Create: `tests/approval-panel.spec.ts`

**Interfaces:**
- Produces: tsconfig paths flipped/added to `lib/types/index.d.ts` for `dsh-user-approval`, `dsh-user-questions`, `dsh-commands`, plus new `dsh-session-query`, `dsh-session-projection`, `dsh-session-projection-cache` (Ruling 11 — all six `lib/types` files verified present). Vitest runtime aliases for the two value-imported packages. And:

```ts
// src/ui/panels/approval-panel.ts
export interface ApprovalPrompt { toolName: string; preview?: string; reason?: string; cwd: string }
export class ApprovalPanel implements Component {
  constructor(prompt: ApprovalPrompt, finish: (outcome: ApprovalOutcome) => void, palette: Palette)
}
```

Rendered shape (spec §4.4 sketch; every row width-truncated):

```
<blank>
─ approval ─────────────────────────────
◇ bash · rm -rf node_modules && pnpm install
  ~/proj/app · model asked to escalate
  [1] allow once   [2] reject   esc cancel
```

Keys: `1`/`2` direct-decide; `up`/`down`/`left`/`right` move the highlight; `enter` confirms the highlighted option; `escape` → `'cancelled'`. Options render from a table (`allow once` → `'allowed-once'`, `reject` → `'rejected'`) so future outcome vocabulary extends by adding rows. Head glyph `◇` + toolName in warning; preview plain; meta line dim; highlighted option accent+bold, others dim.

- [ ] **Step 1: tsconfig + vitest plumbing**

In `tsconfig.json` `paths`, replace the three src-plane interaction rows and add the query/projection rows:

```json
      "@deepseek-ai/dsh-commands": ["../deepseek-harness/packages/interaction/commands/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-user-approval": ["../deepseek-harness/packages/interaction/user-approval/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-user-questions": ["../deepseek-harness/packages/interaction/user-questions/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-session-query": ["../deepseek-harness/packages/session-query/session-query/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-session-projection": ["../deepseek-harness/packages/session/session-projection/lib/types/index.d.ts"],
      "@deepseek-ai/dsh-session-projection-cache": ["../deepseek-harness/packages/session/session-projection-cache/lib/types/index.d.ts"],
```

In `vitest.config.ts` `resolve.alias`, add the value-import packages (package DIRS so their `main` → built `lib` resolves, the proven dsh-session pattern):

```ts
      '@deepseek-ai/dsh-user-questions': fileURLToPath(new URL('../deepseek-harness/packages/interaction/user-questions', import.meta.url)),
      '@deepseek-ai/dsh-commands': fileURLToPath(new URL('../deepseek-harness/packages/interaction/commands', import.meta.url)),
```

Sanity: `pnpm typecheck` must stay green after adding a scratch `import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'` to approval-panel.ts (the real import lands in Step 3).

- [ ] **Step 2: Write the failing tests**

```ts
// tests/approval-panel.spec.ts
import { describe, expect, it } from 'vitest'
import { ApprovalPanel } from '../src/ui/panels/approval-panel.ts'
import { createPalette } from '../src/theme/palette.ts'

function mount(prompt = {}) {
  const outcomes: string[] = []
  const panel = new ApprovalPanel(
    { toolName: 'bash', preview: 'rm -rf node_modules && pnpm install', reason: 'sandbox escalation', cwd: '/workspace', ...prompt },
    (o) => outcomes.push(o),
    createPalette(false),
  )
  return { panel, outcomes }
}

describe('ApprovalPanel', () => {
  it('renders rule, tool head, meta, and options within width', () => {
    const { panel } = mount()
    const rows = panel.render(44)
    const text = rows.join('\n')
    expect(rows[0]).toBe('')
    expect(text).toContain('─ approval ')
    expect(text).toContain('◇ bash · rm -rf node_modules && pnpm install')
    expect(text).toContain('/workspace · sandbox escalation')
    expect(text).toContain('[1] allow once')
    expect(text).toContain('[2] reject')
    expect(text).toContain('esc cancel')
    for (const row of rows) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(44)
  })
  it('neutralizes hostile tool text at the display boundary (D7.8)', () => {
    const { panel } = mount({ toolName: 'bash\x1b]0;evil\x07', preview: 'echo \x1b[31mred' })
    const text = panel.render(60).join('\n')
    expect(text).toContain('\\x1b]0;evil\\x07')
    expect(text).toContain('echo \\x1b[31mred')
  })
  it('digit keys decide directly', () => {
    const a = mount(); a.panel.handleInput!('1'); expect(a.outcomes).toEqual(['allowed-once'])
    const b = mount(); b.panel.handleInput!('2'); expect(b.outcomes).toEqual(['rejected'])
  })
  it('arrows move the highlight; enter confirms; finish fires once', () => {
    const { panel, outcomes } = mount()
    panel.handleInput!('\x1b[C')   // right → highlight "reject"
    panel.handleInput!('\r')
    panel.handleInput!('\r')
    expect(outcomes).toEqual(['rejected'])
  })
  it('escape cancels', () => {
    const { panel, outcomes } = mount()
    panel.handleInput!('\x1b')
    expect(outcomes).toEqual(['cancelled'])
  })
  it('renders without preview/reason (callId-less requests still prompt)', () => {
    const { panel } = mount({ preview: undefined, reason: undefined })
    const text = panel.render(44).join('\n')
    expect(text).toContain('◇ bash')
    expect(text).toContain('/workspace')
  })
})
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `pnpm vitest run tests/approval-panel.spec.ts` → FAIL (module missing). Implement:

```ts
// src/ui/panels/approval-panel.ts
/** The approval prompt (spec §4.4, D9): dsh's FIRST terminal approval UI.
 * Live panel — renders fresh every frame (it is the mutating tail; the
 * committed-cell cache law does not apply). Every row is width-truncated:
 * an over-wide row crashes TuiMainScreen (hard constraint). */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { displayText, type Palette } from '../../theme/palette.js'
import { panelRule } from './panel-rule.js'

export interface ApprovalPrompt { toolName: string; preview?: string; reason?: string; cwd: string }

const OPTIONS: { key: string; label: string; outcome: ApprovalOutcome }[] = [
  { key: '1', label: 'allow once', outcome: 'allowed-once' },
  { key: '2', label: 'reject', outcome: 'rejected' },
]
const CANCEL_HINT = 'esc cancel'

export class ApprovalPanel implements Component {
  private highlighted = 0
  private done = false

  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly finish: (outcome: ApprovalOutcome) => void,
    private readonly palette: Palette,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.done) return
    for (const [i, option] of OPTIONS.entries()) {
      if (matchesKey(data, option.key as never)) { this.decide(OPTIONS[i]!.outcome); return }
    }
    if (matchesKey(data, 'escape')) { this.decide('cancelled'); return }
    if (matchesKey(data, 'enter')) { this.decide(OPTIONS[this.highlighted]!.outcome); return }
    if (matchesKey(data, 'left') || matchesKey(data, 'up')) this.highlighted = (this.highlighted + OPTIONS.length - 1) % OPTIONS.length
    else if (matchesKey(data, 'right') || matchesKey(data, 'down')) this.highlighted = (this.highlighted + 1) % OPTIONS.length
  }

  private decide(outcome: ApprovalOutcome): void {
    this.done = true
    this.finish(outcome)
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const head = `◇ ${displayText(this.prompt.toolName)}${this.prompt.preview === undefined ? '' : ` · ${displayText(this.prompt.preview)}`}`
    const meta = `  ${displayText(this.prompt.cwd)}${this.prompt.reason === undefined ? '' : ` · ${displayText(this.prompt.reason)}`}`
    const options = OPTIONS.map((option, i) => {
      const cell = `[${option.key}] ${option.label}`
      return i === this.highlighted ? p.bold(p.accent(cell)) : p.dim(cell)
    }).join('   ')
    return [
      '',
      panelRule('approval', safe, p),
      truncateToWidth(p.warning(head), safe, '…'),
      p.dim(truncateToWidth(meta, safe, '…')),
      truncateToWidth(`  ${options}   ${p.dim(CANCEL_HINT)}`, safe, '…'),
    ]
  }
}
```

Note on `truncateToWidth` + SGR: pi-tui's truncate/visibleWidth are ANSI-aware (they are what the framework itself uses); styling before truncation is fine. If the styled-head truncation misbehaves at execution time, truncate the plain string first, then style — adjust and keep the width assertion green.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: ApprovalPanel component + dsh lib/types path plumbing (D9 groundwork)"
```

---

### Task 7: Approval responder + audit lines + tool-call preview (D9 — dsh's first terminal approval)

**Files:**
- Create: `src/backend/approval.ts`
- Modify: `src/backend/app-events.ts`, `src/backend/translate.ts`, `src/ui/transcript/transcript.ts`, `src/app/controller.ts`
- Create: `tests/approval.spec.ts`
- Modify: `tests/translate.spec.ts`, `tests/app.snapshot.ts`, `tests/helpers/checkpoint.ts`

**Interfaces:**
- Consumes: `PanelManager.enqueue` (Task 5), `ApprovalPanel` (Task 6).
- Produces:

```ts
// src/backend/approval.ts
export interface ApprovalRequestLike { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }
export function attachApprovalResponder(
  events: { on(event: string, fn: (...args: never[]) => unknown): () => void },
  deps: { isBound(agent: unknown): boolean; present(req: ApprovalRequestLike): Promise<ApprovalOutcome> },
): () => void
```

- New AppEvents: `{ kind: 'tool-call'; callId: string; name: string; preview: string | undefined }`, `{ kind: 'approval-asked'; id: string; toolName: string }`, `{ kind: 'approval-decided'; id: string; outcome: string }`.
- Transcript: keeps `askedTools: Map<id, toolName>`; `approval-decided` appends one dim audit line `◆ approval · <tool> · <outcome word>` (outcome word toned: allowed-once → success, rejected/unavailable → error, cancelled → warning). `tool-call` is transcript-ignored (cards are T3).
- Controller: keeps `pendingCalls: Map<callId, preview>` fed by `tool-call` events, cleared on `turn-end`; wires the responder: attribution filter → pre-aborted → `panels.enqueue(ApprovalPanel …, { signal })` with `forced: aborted → { outcome: 'cancelled' }`, `owner-disposed → { error }` (service normalizes to `'unavailable'`, fail-closed — Ruling 7).

- [ ] **Step 1: Write the failing responder tests**

```ts
// tests/approval.spec.ts
import { describe, expect, it } from 'vitest'
import { attachApprovalResponder } from '../src/backend/approval.ts'

type Listener = (req: unknown, next: () => Promise<string>) => unknown
function bus() {
  const listeners: Listener[] = []
  return {
    on: (_e: string, fn: Listener) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1) },
    dispatch: (req: unknown) => {
      const chain = [...listeners]
      const next = (): Promise<string> => Promise.resolve(chain.shift() ? (chain[0], 'unavailable') : 'unavailable')
      // simplified waterfall: first listener, terminal next() → 'unavailable'
      const first = listeners[0]!
      return Promise.resolve(first(req, () => Promise.resolve('unavailable')))
    },
  }
}
const AGENT = { id: 'main' }

describe('approval responder (D9)', () => {
  it('claims requests for the bound agent and presents them', async () => {
    const b = bus()
    const presented: unknown[] = []
    attachApprovalResponder(b, { isBound: (a) => a === AGENT, present: async (req) => { presented.push(req); return 'allowed-once' } })
    await expect(b.dispatch({ agent: AGENT, toolName: 'bash' })).resolves.toBe('allowed-once')
    expect(presented.length).toBe(1)
  })
  it('passes foreign-agent requests down the waterfall untouched (attribution filter)', async () => {
    const b = bus()
    let presented = 0
    attachApprovalResponder(b, { isBound: (a) => a === AGENT, present: async () => { presented += 1; return 'allowed-once' } })
    await expect(b.dispatch({ agent: { id: 'other' }, toolName: 'bash' })).resolves.toBe('unavailable')
    expect(presented).toBe(0)
  })
  it('answers cancelled for a pre-aborted signal without presenting', async () => {
    const b = bus()
    let presented = 0
    const ctl = new AbortController(); ctl.abort()
    attachApprovalResponder(b, { isBound: () => true, present: async () => { presented += 1; return 'allowed-once' } })
    await expect(b.dispatch({ agent: AGENT, toolName: 'bash', signal: ctl.signal })).resolves.toBe('cancelled')
    expect(presented).toBe(0)
  })
  it('detaches cleanly', () => {
    const b = bus()
    const off = attachApprovalResponder(b, { isBound: () => true, present: async () => 'allowed-once' })
    off()
    expect(() => off()).not.toThrow()
  })
})
```

And controller-level tests in the same file. Extend the shared fake ctx with a waterfall dispatcher (the real service resolves listener return values; the fake mirrors that):

```ts
// added to the fakeCtx factory used by controller tests:
    emitWaterfall(event: string, ...args: unknown[]): Promise<unknown> {
      const listener = (listeners.get(event) ?? [])[0]
      if (!listener) return Promise.resolve('unavailable')
      return Promise.resolve(listener(...args, () => Promise.resolve('unavailable')))
    },

describe('approval through the controller', () => {
  it('FIFO-serializes two requests and enriches the preview from tool/call', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    ctx.emit('session/event', agent.session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'rm -rf /tmp/x' } } })
    const first = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', callId: 'c1' })
    const second = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', callId: 'c2' })
    await terminal.waitForFrame(terminal.frames)
    expect(terminal.snapshot()).toContain('rm -rf /tmp/x')      // enriched from tool/call by callId
    terminal.input('1')
    await expect(first).resolves.toBe('allowed-once')
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()               // second request activated FIFO
    terminal.input('2')
    await expect(second).resolves.toBe('rejected')
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('signal abort mid-display closes the panel and answers cancelled', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const ctl = new AbortController()
    const outcome = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash', signal: ctl.signal })
    await terminal.waitForFrame(terminal.frames)
    expect(controller.panels.active).toBeDefined()
    ctl.abort()
    await expect(outcome).resolves.toBe('cancelled')
    expect(controller.panels.active).toBeUndefined()
    await controller.dispose()
  })
  it('teardown while a request is open rejects it (service normalizes to unavailable)', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const outcome = ctx.emitWaterfall('approval/request', { agent, toolName: 'bash' })
    await terminal.waitForFrame(terminal.frames)
    await controller.dispose()
    await expect(outcome).rejects.toThrow('torn down')
  })
})
```

- [ ] **Step 2: translate + transcript audit tests**

Append to `tests/translate.spec.ts`:

```ts
  it('translates tool/call with a bash command preview', () => {
    expect(translateSessionEvent({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: { command: 'ls -la' } } }))
      .toEqual([{ kind: 'tool-call', callId: 'c1', name: 'bash', preview: 'ls -la' }])
  })
  it('translates tool/call without a string command to an undefined preview', () => {
    expect(translateSessionEvent({ type: 'tool/call', data: { callId: 'c2', name: 'read', arguments: { path: '/x' } } }))
      .toEqual([{ kind: 'tool-call', callId: 'c2', name: 'read', preview: undefined }])
  })
  it('translates the approval audit pair', () => {
    expect(translateSessionEvent({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c1' } }))
      .toEqual([{ kind: 'approval-asked', id: 'a1', toolName: 'bash' }])
    expect(translateSessionEvent({ type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } }))
      .toEqual([{ kind: 'approval-decided', id: 'a1', outcome: 'allowed-once' }])
  })
```

And to `tests/transcript.spec.ts`:

```ts
  it('renders one audit line per decision, correlated by id (replay-safe)', () => {
    const t = new Transcript(createPalette(false))
    t.apply({ kind: 'approval-asked', id: 'a1', toolName: 'bash' })
    expect(t.container.render(60).length).toBe(0)                      // asked alone renders nothing
    t.apply({ kind: 'approval-decided', id: 'a1', outcome: 'allowed-once' })
    expect(t.container.render(60).join('\n')).toContain('◆ approval · bash · allowed once')
    t.apply({ kind: 'approval-decided', id: 'ghost', outcome: 'rejected' })
    expect(t.container.render(60).join('\n')).toContain('◆ approval · (unknown tool) · rejected')
  })
```

- [ ] **Step 3: Implement**

`app-events.ts`: extend the union with the three new kinds (exact shapes above). `translate.ts`:

```ts
    case 'tool/call': {
      const args = d.arguments as Record<string, unknown> | undefined
      const command = args?.command
      return [{ kind: 'tool-call', callId: String(d.callId ?? ''), name: String(d.name ?? ''), preview: typeof command === 'string' ? command : undefined }]
    }
    case 'approval/asked':
      return [{ kind: 'approval-asked', id: String(d.id), toolName: String(d.toolName ?? '') }]
    case 'approval/decided':
      return [{ kind: 'approval-decided', id: String(d.id), outcome: String(d.outcome) }]
```

`transcript.ts`: add `private readonly askedTools = new Map<string, string>()`; cases:

```ts
      case 'tool-call':
        break // cards land in T3; the controller consumes previews
      case 'approval-asked':
        this.askedTools.set(event.id, event.toolName)
        break
      case 'approval-decided': {
        const tool = this.askedTools.get(event.id) ?? '(unknown tool)'
        this.askedTools.delete(event.id)
        this.spaceBeforeNewCell()
        const c = new ApprovalAuditCell(tool, event.outcome, this.palette)
        this.addChild(c, c.contentLineCount())
        break
      }
```

`ApprovalAuditCell` in `cells.ts` (a CachedCell — committed, immutable):

```ts
const OUTCOME_WORDS: Record<string, string> = { 'allowed-once': 'allowed once', rejected: 'rejected', cancelled: 'cancelled', unavailable: 'unavailable' }

export class ApprovalAuditCell extends CachedCell {
  constructor(private readonly tool: string, private readonly outcome: string, private readonly palette: Palette) { super() }
  contentLineCount(): number { return 1 }
  protected renderLines(width: number): string[] {
    const word = OUTCOME_WORDS[this.outcome] ?? this.outcome
    const tone = this.outcome === 'allowed-once' ? this.palette.success : this.outcome === 'cancelled' ? this.palette.warning : this.palette.error
    const line = `${this.palette.dim(`◆ approval · ${displayText(this.tool)} · `)}${tone(displayText(word))}`
    return [truncateToWidth(line, Math.max(1, width), '…')]
  }
}
```

`approval.ts` (the exact D9 shape from spec §3.3):

```ts
// src/backend/approval.ts
/** The approval/request waterfall responder (spec D9): claim only the bound
 * agent's requests by OBJECT IDENTITY (the ACP attribution pattern); pass
 * everything else with next(). Pre-aborted requests answer 'cancelled'
 * before any UI mounts. Presentation rejection is fine: the service
 * normalizes throws to 'unavailable' (fail-closed, verified). */
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

export interface ApprovalRequestLike { agent: unknown; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }

export function attachApprovalResponder(
  events: { on(event: string, fn: (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => unknown): () => void },
  deps: {
    isBound(agent: unknown): boolean
    present(req: ApprovalRequestLike): Promise<ApprovalOutcome>
  },
): () => void {
  return events.on('approval/request', (req, next) => {
    if (!deps.isBound(req.agent)) return next()
    if (req.signal?.aborted) return 'cancelled'
    return deps.present(req)
  })
}
```

Controller wiring:

```ts
  const pendingCalls = new Map<string, string>()
  // inside the session/event handler's translate loop:
  //   if (appEvent.kind === 'tool-call' && appEvent.preview !== undefined) pendingCalls.set(appEvent.callId, appEvent.preview)
  //   if (appEvent.kind === 'turn-end') pendingCalls.clear()
  detachers.push(attachApprovalResponder(ctx as never, {
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
```

(`bound` is the `let`-bound agent variable this task introduces in place of destructured `agent` where identity checks happen — full rebinding lands in Task 16; here it is initialized `const bound = agent` equivalent via `let bound = agent`.)

- [ ] **Step 4: Snapshot checkpoint**

Add `'approval-panel'` to `CHECKPOINTS` and to app.snapshot.ts `OWNED`; new test: mount the controller, emit a `tool/call` + dispatch an `approval/request` via the fake waterfall, `await terminal.waitForFrame(before)`, `await checkpoint('approval-panel', terminal)`, then answer `'1'` and assert the audit line appears after emitting the durable `approval/asked`/`approval/decided` pair (mirroring what the service logs).

- [ ] **Step 5: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: approval responder + panel flow + durable audit lines (D9 — dsh's first terminal approval UI)"
```

### Task 8: Question provider + QuestionPanel core (options mode, single-select)

**Files:**
- Create: `src/backend/questions.ts`, `src/ui/panels/question-panel.ts`
- Modify: `src/app/controller.ts`, `src/index.ts` (inject `userQuestions`)
- Create: `tests/questions.spec.ts`, `tests/question-panel.spec.ts`

**Interfaces:**
- Consumes: `PanelManager.enqueue`, `panelRule`, dsh types from Task 6.
- Produces:

```ts
// src/backend/questions.ts
export function attachQuestionProvider(
  userQuestions: { registerProvider(p: { ask(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void },
  deps: { present(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> },
): () => void
// Dismissal/teardown MUST reject with UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED') — Ruling 7.

// src/ui/panels/question-panel.ts
export class QuestionPanel implements Component {
  constructor(
    request: { questions: AskUserQuestionItem[] },
    finish: (answer: AskUserQuestionAnswer) => void,
    cancel: () => void,                      // panel-level dismissal; backend maps to ASK_CANCELLED
    palette: Palette,
    maxHeight: () => number,                 // live row budget (pagination lands in Task 10)
  )
  // Walks questions serially inside ONE panel session (counter needs request
  // context; PanelManager FIFO stays one-entry-per-request).
}
```

Rendered shape this task (options mode; borrowed line-for-line from the recovered QuestionDialog, spec §4.4):

```
<blank>
─ question ─────────────────────────────
Question 2/5 (4 unanswered) · Mode        ← dim; header suffix only when item.header set
Which mode should we use?                  ← plain, wrapped
<blank>
 › 1. Fast                                 ← selected: bold accent; cursor ›
      builds without checks                ← option.description, dim, indented
   2. Careful
<blank>
Tab custom answer • ↑/↓ navigate • Enter submit • Esc interrupt   ← dim
Select at least one option, or press Tab for a custom answer.     ← error tone, only when set
```

Keys (options mode, this task): `up`/`down` wrap-move; digit `1..9` moves the cursor to that option; `enter` submits `{ id, selected: [labels[cursor]] }`; `escape` → `cancel()`. Counter: `Question ${position}/${total} (${unanswered} unanswered)` where unanswered = remaining INCLUDING current (old-TUI exact).

- [ ] **Step 1: Write the failing provider tests**

```ts
// tests/questions.spec.ts
import { describe, expect, it } from 'vitest'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { attachQuestionProvider } from '../src/backend/questions.ts'

function fakeService() {
  let provider: { ask(req: unknown): Promise<unknown> } | undefined
  return {
    get provider() { return provider },
    registerProvider(p: { ask(req: unknown): Promise<unknown> }) {
      if (provider !== undefined) throw new UserQuestionError('a user-questions provider is already registered', 'DUPLICATE_PROVIDER')
      provider = p
      return () => { provider = undefined }
    },
  }
}

describe('question provider wiring', () => {
  it('registers and forwards ask() to the presenter', async () => {
    const svc = fakeService()
    const answer = { answers: [{ id: 'q1', selected: ['A'] }] }
    attachQuestionProvider(svc as never, { present: async () => answer as never })
    await expect(svc.provider!.ask({ questions: [] })).resolves.toBe(answer)
  })
  it('unregisters on dispose', () => {
    const svc = fakeService()
    const off = attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })
    off()
    expect(svc.provider).toBeUndefined()
    expect(() => attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })).not.toThrow()
  })
  it('propagates DUPLICATE_PROVIDER loudly (composition error, fail loud)', () => {
    const svc = fakeService()
    attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })
    expect(() => attachQuestionProvider(svc as never, { present: async () => ({ answers: [] }) as never })).toThrow(UserQuestionError)
  })
})
```

- [ ] **Step 2: Write the failing panel-core tests**

```ts
// tests/question-panel.spec.ts
import { describe, expect, it } from 'vitest'
import { QuestionPanel } from '../src/ui/panels/question-panel.ts'
import { createPalette } from '../src/theme/palette.ts'

export function mountQuestions(questions: unknown[], overrides: Partial<{ maxHeight: number }> = {}) {
  const answers: unknown[] = []
  let cancelled = 0
  const panel = new QuestionPanel(
    { questions: questions as never },
    (a) => answers.push(a),
    () => { cancelled += 1 },
    createPalette(false),
    () => overrides.maxHeight ?? 18,
  )
  return { panel, answers, cancelled: () => cancelled }
}
const q = (over: Record<string, unknown> = {}) => ({
  id: 'q1', question: 'Which mode should we use?',
  options: [{ label: 'Fast', description: 'builds without checks' }, { label: 'Careful' }], ...over,
})

describe('QuestionPanel core', () => {
  it('renders counter, question, options, descriptions, and hints', () => {
    const { panel } = mountQuestions([q({ header: 'Mode' }), q({ id: 'q2' })])
    const text = panel.render(52).join('\n')
    expect(text).toContain('─ question ')
    expect(text).toContain('Question 1/2 (2 unanswered) · Mode')
    expect(text).toContain('Which mode should we use?')
    expect(text).toContain('› 1. Fast')
    expect(text).toContain('builds without checks')
    expect(text).toContain('  2. Careful')
    expect(text).toContain('Enter submit')
  })
  it('arrow keys wrap; digits jump; enter answers and advances to the next question', () => {
    const { panel, answers } = mountQuestions([q(), q({ id: 'q2', question: 'Second?' })])
    panel.handleInput!('\x1b[B')                    // down → Careful
    panel.handleInput!('\x1b[B')                    // wraps → Fast
    panel.handleInput!('2')                         // digit jump → Careful
    panel.handleInput!('\r')
    expect(answers).toEqual([])                     // not finished yet — question 2 is showing
    expect(panel.render(52).join('\n')).toContain('Question 2/2 (1 unanswered)')
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Careful'] }, { id: 'q2', selected: ['Fast'] }] }])
  })
  it('escape cancels the whole request', () => {
    const { panel, answers, cancelled } = mountQuestions([q()])
    panel.handleInput!('\x1b')
    expect(cancelled()).toBe(1)
    expect(answers).toEqual([])
  })
  it('neutralizes hostile question metadata (D7.8)', () => {
    const { panel } = mountQuestions([q({ question: 'evil\x1b]0;t\x07?', header: 'h\x1bx', options: [{ label: 'ok\x07' }] })])
    const text = panel.render(60).join('\n')
    expect(text).toContain('evil\\x1b]0;t\\x07?')
    expect(text).toContain('h\\x1bx')
    expect(text).toContain('ok\\x07')
  })
  it('every row stays within width', () => {
    const { panel } = mountQuestions([q({ question: 'long '.repeat(40), options: [{ label: 'x'.repeat(120) }] })])
    for (const row of panel.render(30)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(30)
  })
})
```

- [ ] **Step 3: Run to verify failure, then implement**

`questions.ts`:

```ts
// src/backend/questions.ts
/** The user-questions provider (spec §3.4). Registration is single-provider;
 * DUPLICATE_PROVIDER is a composition error and propagates loudly. Dismissal
 * rejects with the exact code plan-mode narrows on (Ruling 7). */
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

export function cancelledError(): UserQuestionError {
  return new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
}

export function attachQuestionProvider(
  userQuestions: { registerProvider(p: { ask(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void },
  deps: { present(req: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> },
): () => void {
  return userQuestions.registerProvider({ ask: (request) => deps.present(request) })
}
```

`question-panel.ts` core (state machine; pagination budget hooks are stubbed to "render all" until Task 10 — implement `visibleWindow()` returning everything, NO placeholder comment markers, just the simple total window this task):

```ts
// src/ui/panels/question-panel.ts
/** Inline question panel (spec §4.4, ported from the recovered QuestionDialog):
 * one panel session walks the whole request's questions serially; the FIFO
 * queue above it stays one-entry-per-request so the counter can say
 * "Question 2/5". Live panel — re-renders freely. */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { displayText, type Palette } from '../../theme/palette.js'
import { wrapPlain } from '../transcript/cells.js'
import { panelRule } from './panel-rule.js'

const HINT_OPTIONS = ['Tab custom answer', '↑/↓ navigate', 'Enter submit', 'Esc interrupt']
const ERROR_SELECT = 'Select at least one option, or press Tab for a custom answer.'

export class QuestionPanel implements Component {
  private index = 0
  private cursor = 0
  private readonly answers: AskUserQuestionAnswerItem[] = []
  private error = ''

  constructor(
    private readonly request: { questions: AskUserQuestionItem[] },
    private readonly finish: (answer: AskUserQuestionAnswer) => void,
    private readonly cancel: () => void,
    private readonly palette: Palette,
    private readonly maxHeight: () => number,
  ) {}

  invalidate(): void {}
  private get question(): AskUserQuestionItem { return this.request.questions[this.index]! }
  private get options(): { label: string; description?: string }[] { return this.question.options ?? [] }

  handleInput(data: string): void {
    const options = this.options
    if (matchesKey(data, 'escape')) { this.cancel(); return }
    if (matchesKey(data, 'up')) { this.cursor = (this.cursor + options.length - 1) % Math.max(1, options.length); return }
    if (matchesKey(data, 'down')) { this.cursor = (this.cursor + 1) % Math.max(1, options.length); return }
    if (/^[1-9]$/.test(data) && Number(data) <= options.length) { this.cursor = Number(data) - 1; return }
    if (matchesKey(data, 'enter')) { this.submitOptions(); return }
  }

  private submitOptions(): void {
    const label = this.options[this.cursor]?.label
    if (label === undefined) { this.error = ERROR_SELECT; return }
    this.pushAnswer({ id: this.question.id, selected: [label] })
  }

  private pushAnswer(item: AskUserQuestionAnswerItem): void {
    this.answers.push(item)
    this.index += 1
    this.cursor = 0
    this.error = ''
    if (this.index >= this.request.questions.length) this.finish({ answers: this.answers })
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const total = this.request.questions.length
    const unanswered = total - this.answers.length
    const headerSuffix = this.question.header === undefined ? '' : ` · ${displayText(this.question.header)}`
    const rows: string[] = ['', panelRule('question', safe, p)]
    rows.push(...wrapPlain(`Question ${this.index + 1}/${total} (${unanswered} unanswered)${headerSuffix}`, safe).map((r) => p.dim(r)))
    rows.push(...wrapPlain(displayText(this.question.question), safe))
    if (this.question.detail !== undefined) { rows.push(''); rows.push(...wrapPlain(displayText(this.question.detail), safe)) }
    rows.push('')
    for (const [i, option] of this.options.entries()) rows.push(...this.optionRows(i, option, safe))
    rows.push('')
    rows.push(p.dim(truncateToWidth(HINT_OPTIONS.join(' • '), safe, '…')))
    if (this.error !== '') rows.push(p.error(truncateToWidth(this.error, safe, '…')))
    return rows
  }

  private optionRows(i: number, option: { label: string; description?: string }, width: number): string[] {
    const p = this.palette
    const cursor = i === this.cursor ? '›' : ' '
    const prefix = ` ${cursor} ${i + 1}. `
    const indent = ' '.repeat(prefix.length)
    const labelLines = wrapPlain(displayText(option.label), Math.max(1, width - prefix.length))
    const rows = labelLines.map((line, n) => {
      const composed = (n === 0 ? prefix : indent) + line
      return i === this.cursor ? p.bold(p.accent(composed)) : composed
    })
    if (option.description !== undefined) {
      rows.push(...wrapPlain(displayText(option.description), Math.max(1, width - indent.length)).map((l) => p.dim(indent + l)))
    }
    return rows
  }
}
```

Controller wiring (`present` enqueues one panel per request; forced/dismissal both reject ASK_CANCELLED):

```ts
  detachers.push(attachQuestionProvider((deps.userQuestions as never), {
    present: (request) => panels.enqueue<AskUserQuestionAnswer>({
      create: (finish) => new QuestionPanel(request as never, finish, () => { throw cancelledError() }, palette, () => Math.max(6, Math.min(20, terminal.rows - 6))),
      forced: () => ({ error: cancelledError() }),
    }, request.signal === undefined ? {} : { signal: request.signal }),
  }))
```

Wait — `cancel` cannot `throw` inside handleInput (GuardedPanel would treat it as a crash — acceptable? No: crash-settling REJECTS the promise, which IS the wanted semantics, but it would be indistinguishable from a bug). Cleaner: `PanelSpec.create` receives only `finish`; give QuestionPanel's `cancel` a rejection path by enqueueing with a wrapper outcome. Use a discriminated outcome: `panels.enqueue<{ kind: 'answered'; answer: AskUserQuestionAnswer } | { kind: 'cancelled' }>` and map after:

```ts
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
```

Use this discriminated form (it is the one to implement; the earlier snippet is superseded). `src/index.ts`: add `'userQuestions'`, `'approval'` to the plugin `inject` array and pass `userQuestions: anyCtx.userQuestions` through `ControllerDeps` (typed as the minimal facet).

Controller test (question flow end-to-end through the fake ctx): present a 2-question request via `deps.userQuestions` fake capturing the provider, drive keys through the terminal, assert the resolved answer array and that Esc rejects with `.code === 'ASK_CANCELLED'`.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: user-questions provider + QuestionPanel options core (spec §3.4/§4.4)"
```

---

### Task 9: QuestionPanel — multiSelect, custom mode, validation

**Files:**
- Modify: `src/ui/panels/question-panel.ts`
- Modify: `tests/question-panel.spec.ts`

**Interfaces:**
- Produces: full old-TUI submission semantics (verified from the recovered dialog):
  - `multiSelect`: `space` toggles `[x]` marks; Enter submits checked labels in OPTION ORDER (not click order); custom text typed earlier MERGES into the options-mode submit (`{ selected, custom? }`, custom omitted when empty).
  - Custom mode: `tab` or bare `c`/`C` switches to a pi-tui `Input` row; Enter submits `{ selected: multiSelect ? checkedLabels : [], custom }`; empty custom → error `Enter an answer before submitting.`; `escape` returns to options (or cancels the request when the question HAS no options — a no-options question STARTS in custom mode).
  - Options-mode Enter with nothing selected and no custom → error `Select at least one option, or press Tab for a custom answer.`
  - Hints switch per mode; custom-mode hint shows `${selected.size} selected` for multiSelect, and `Esc options` vs `Esc cancel` by options presence.

- [ ] **Step 1: Write the failing tests**

```ts
const mq = (over: Record<string, unknown> = {}) => q({ multiSelect: true, ...over })

describe('QuestionPanel multiSelect + custom', () => {
  it('space toggles marks; enter submits checked labels in option order', () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!('\x1b[B')      // cursor → Careful
    panel.handleInput!(' ')           // check Careful
    panel.handleInput!('\x1b[A')      // cursor → Fast
    panel.handleInput!(' ')           // check Fast
    expect(panel.render(52).join('\n')).toContain('[x] Fast')
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Fast', 'Careful'] }] }])  // option order, not click order
  })
  it('empty submit shows the validation error and stays open', () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!('\r')
    expect(panel.render(52).join('\n')).toContain('Select at least one option')
    expect(answers).toEqual([])
  })
  it('tab enters custom mode; typed text submits as custom', () => {
    const { panel, answers } = mountQuestions([q()])
    panel.handleInput!('\t')
    for (const ch of 'my own way') panel.handleInput!(ch)
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: [], custom: 'my own way' }] }])
  })
  it("bare 'c' also enters custom mode; esc returns to options and keeps the draft", () => {
    const { panel, answers } = mountQuestions([mq()])
    panel.handleInput!('c')
    for (const ch of 'keep this') panel.handleInput!(ch)
    panel.handleInput!('\x1b')                    // back to options, draft retained
    panel.handleInput!(' ')                       // check Fast
    panel.handleInput!('\r')
    expect(answers).toEqual([{ answers: [{ id: 'q1', selected: ['Fast'], custom: 'keep this' }] }])  // old-TUI merge law
  })
  it('custom-mode empty submit errors', () => {
    const { panel } = mountQuestions([q()])
    panel.handleInput!('\t')
    panel.handleInput!('\r')
    expect(panel.render(52).join('\n')).toContain('Enter an answer before submitting.')
  })
  it('a question with no options starts in custom mode and esc cancels the request', () => {
    const { panel, cancelled } = mountQuestions([q({ options: undefined })])
    expect(panel.render(52).join('\n')).toContain('Esc cancel')
    panel.handleInput!('\x1b')
    expect(cancelled()).toBe(1)
  })
  it('single-select ignores space', () => {
    const { panel } = mountQuestions([q()])
    panel.handleInput!(' ')
    expect(panel.render(52).join('\n')).not.toContain('[x]')
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Panel additions (exact old-TUI semantics):

```ts
  private mode: 'options' | 'custom'
  private readonly selected = new Set<number>()
  private readonly input = new Input()
  // constructor: this.mode = this.options.length > 0 ? 'options' : 'custom'
  //   this.input.onSubmit = (value) => this.submitCustom(value)
  //   this.input.onEscape = () => { if (this.options.length > 0) { this.mode = 'options'; this.error = '' } else this.cancel() }
  // Focusable forwarding so the Input caret shows: `focused` get/set proxying this.input.focused when mode === 'custom'.
```

- `handleInput` order: `escape` FIRST only in options mode (custom mode forwards to `this.input.handleInput(data)` for everything except mode-global keys); `space` toggles only when `question.multiSelect`; `tab` or `data.toLowerCase() === 'c'` (single char) enters custom mode.
- Question advance resets per-question state: `selected.clear()`, `input.setValue('')`, mode recomputed from the NEXT question's options.
- `submitOptions` (replaces Task 8's):

```ts
  private submitOptions(): void {
    const labels = this.question.multiSelect
      ? [...this.selected].sort((a, b) => a - b).map((i) => this.options[i]!.label)
      : [this.options[this.cursor]?.label].filter((l): l is string => l !== undefined)
    const custom = this.question.multiSelect ? this.input.getValue().trim() : ''
    if (labels.length === 0 && custom === '') { this.error = ERROR_SELECT; return }
    this.pushAnswer({ id: this.question.id, selected: labels, ...(custom === '' ? {} : { custom }) })
  }
  private submitCustom(value: string): void {
    const custom = value.trim()
    if (custom === '') { this.error = 'Enter an answer before submitting.'; return }
    const labels = this.question.multiSelect ? [...this.selected].sort((a, b) => a - b).map((i) => this.options[i]!.label) : []
    this.pushAnswer({ id: this.question.id, selected: labels, ...(custom === '' ? {} : { custom }) })
  }
```

- Option rows gain the multiSelect mark: `` `${cursor} ${i + 1}. ${multiSelect ? (selected.has(i) ? '[x] ' : '[ ] ') : ''}${label}` `` (mark before the label, old-TUI exact).
- Custom-mode render: replace option rows with the Input's rendered row(s) (width-truncated) and the custom hint line `[N selected • ]Enter submit • Esc options|Esc cancel`.

- [ ] **Step 3: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: QuestionPanel multiSelect + custom mode + validation (old-TUI submission semantics)"
```

### Task 10: QuestionPanel — two-level pagination and windowing

**Files:**
- Create: `src/ui/panels/question-layout.ts`
- Modify: `src/ui/panels/question-panel.ts`
- Create: `tests/question-layout.spec.ts`
- Modify: `tests/question-panel.spec.ts`

**Interfaces:**
- Produces pure, panel-independent layout helpers (testable without a component):

```ts
// src/ui/panels/question-layout.ts
export interface BlockPage { offset: number; size: number; maxOffset: number }
export const IDLE_PAGE: BlockPage = { offset: 0, size: 1, maxOffset: 0 }
/** Window option BLOCKS (each an array of pre-wrapped rows) around the
 * selected index: grow forward first, then backward; reserve marker rows;
 * if the selected block alone exceeds the budget, page WITHIN it. */
export function windowBlocks(blocks: string[][], selectedIndex: number, budget: number, maxVisible: number, page: BlockPage):
  { visible: string[][]; hiddenBefore: number; hiddenAfter: number; page: BlockPage }
/** Compact an over-tall header (question+detail rows) to a page window with
 * a status row: `… lines a-b/total • PgUp/PgDn`. */
export function compactHeader(rows: string[], budget: number, page: BlockPage): { rows: string[]; page: BlockPage }
```

- Panel behavior (the recovered dialog's exact two-level rule, spec §4.4):
  - **PgDn pages the question/detail header first**, then (options mode only) the oversized selected block.
  - **PgUp rewinds the oversized selected block first**, then the header.
  - `↑/↓` and mode switches reset the selected-block page; header paging exists only while compaction is active (total rows > budget resets to IDLE_PAGE otherwise).
  - `↑ N more` / `↓ N more` dim markers for hidden blocks; `${cursor + 1}/${options.length}` dim position line when options overflow `maxVisible` (8).

- [ ] **Step 1: Write the failing layout tests**

```ts
// tests/question-layout.spec.ts
import { describe, expect, it } from 'vitest'
import { IDLE_PAGE, compactHeader, windowBlocks } from '../src/ui/panels/question-layout.ts'

const block = (label: string, lines: number) => Array.from({ length: lines }, (_, i) => `${label}${i}`)

describe('windowBlocks', () => {
  it('shows everything when it fits', () => {
    const r = windowBlocks([block('a', 2), block('b', 2)], 0, 10, 8, IDLE_PAGE)
    expect(r.visible.length).toBe(2)
    expect(r.hiddenBefore).toBe(0)
    expect(r.hiddenAfter).toBe(0)
  })
  it('grows forward from the selection first, then backward, reserving marker rows', () => {
    const blocks = [block('a', 3), block('b', 3), block('c', 3), block('d', 3)]
    const r = windowBlocks(blocks, 1, 8, 8, IDLE_PAGE)
    expect(r.visible).toContainEqual(block('b', 3))
    expect(r.visible).toContainEqual(block('c', 3))          // forward-first
    expect(r.hiddenBefore + r.hiddenAfter).toBeGreaterThan(0)
  })
  it('caps the window at maxVisible blocks', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => block(`x${i}-`, 1))
    const r = windowBlocks(blocks, 6, 100, 8, IDLE_PAGE)
    expect(r.visible.length).toBe(8)
  })
  it('pages within an individually oversized selected block', () => {
    const r1 = windowBlocks([block('big', 30)], 0, 10, 8, IDLE_PAGE)
    expect(r1.visible[0]!.length).toBeLessThanOrEqual(10)
    expect(r1.page.maxOffset).toBeGreaterThan(0)
    const r2 = windowBlocks([block('big', 30)], 0, 10, 8, { ...r1.page, offset: r1.page.size })
    expect(r2.visible[0]![0]).not.toBe(r1.visible[0]![0])    // advanced into the block
  })
})

describe('compactHeader', () => {
  it('passes short headers through untouched with an idle page', () => {
    const r = compactHeader(block('h', 3), 10, IDLE_PAGE)
    expect(r.rows).toEqual(block('h', 3))
    expect(r.page).toEqual(IDLE_PAGE)
  })
  it('windows tall headers and appends the pager status row', () => {
    const r = compactHeader(block('h', 40), 6, IDLE_PAGE)
    expect(r.rows.length).toBeLessThanOrEqual(6)
    expect(r.rows.at(-1)).toMatch(/lines 1-\d+\/40 • PgUp\/PgDn/)
    expect(r.page.maxOffset).toBeGreaterThan(0)
  })
  it('honors a forwarded offset', () => {
    const first = compactHeader(block('h', 40), 6, IDLE_PAGE)
    const second = compactHeader(block('h', 40), 6, { ...first.page, offset: first.page.size })
    expect(second.rows[0]).not.toBe(first.rows[0])
  })
})
```

- [ ] **Step 2: Panel-level two-level rule tests**

```ts
describe('QuestionPanel pagination (two-level rule, spec §4.4)', () => {
  const tall = () => mountQuestions([q({ detail: Array.from({ length: 40 }, (_, i) => `detail line ${i}`).join('\n') })], { maxHeight: 14 })
  it('PgDn pages the header first', () => {
    const { panel } = tall()
    const before = panel.render(60).join('\n')
    expect(before).toContain('detail line 0')
    panel.handleInput!('\x1b[6~')                    // PgDn
    const after = panel.render(60).join('\n')
    expect(after).not.toContain('detail line 0')
    expect(after).toMatch(/lines \d+-\d+\/\d+/)
  })
  it('PgUp rewinds the header after PgDn', () => {
    const { panel } = tall()
    panel.handleInput!('\x1b[6~')
    panel.handleInput!('\x1b[5~')                    // PgUp
    expect(panel.render(60).join('\n')).toContain('detail line 0')
  })
  it('renders hidden-block markers and the position line for many options', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `Option ${i}` }))
    const { panel } = mountQuestions([q({ options })], { maxHeight: 12 })
    const text = panel.render(60).join('\n')
    expect(text).toMatch(/↓ \d+ more/)
    expect(text).toContain('1/12')
  })
  it('arrow movement resets selected-block paging', () => {
    const options = [{ label: 'x'.repeat(400) }, { label: 'small' }]
    const { panel } = mountQuestions([q({ options })], { maxHeight: 10 })
    panel.handleInput!('\x1b[6~')                    // page into the oversized selected block (header is short → falls through)
    panel.handleInput!('\x1b[B')                     // move → reset
    const text = panel.render(40).join('\n')
    expect(text).toContain('small')
  })
})
```

- [ ] **Step 3: Implement**

`question-layout.ts` — port the recovered algorithm as pure functions (forward-first growth with `fits()` checking `blockCount <= maxVisible && usedRows + markerRows <= budget`; marker reservation of one row per shown `↑/↓ N more`; oversized-selected degradation `pageSize = budget - selectedMarkers - 1`, clamp offset to `maxOffset = blockLines - pageSize`, keep `… ↑ n lines hidden` head row when offset > 0). `compactHeader`: `pageSize = max(1, budget - 1)`, window `rows.slice(offset, offset + pageSize)`, append dim-agnostic status text `… lines ${offset + 1}-${Math.min(rows.length, offset + pageSize)}/${rows.length} • PgUp/PgDn` (caller dims it).

Panel integration:
- Split `render` into `headerRows()` (counter+question+detail, pre-wrapped plain strings; styles applied AFTER windowing so slicing never splits SGR pairs — build rows as `{ text, style }` pairs or apply dim/tone per-row post-window; the simple route: keep header rows unstyled-with-displayText, dim them after `compactHeader`), `optionBlocks()` (styled per block), `footerRows()`.
- Budget: `availableForOptions = max(mode === 'options' ? 4 : 1, maxHeight() - 2 - headerRows.length - positionRows - footerRows.length)` (old-TUI formula).
- Keys (both modes, checked BEFORE mode dispatch): `pageUp` → selected-block page back else header back; `pageDown` → header forward else (options mode) selected-block forward. `↑/↓`, mode switches, and question advance reset `selectedPage = IDLE_PAGE`; a render whose total fits resets `headerPage`.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: QuestionPanel two-level pagination + block windowing (recovered dialog algorithm)"
```

---

### Task 11: plan-review intent + question snapshot checkpoints

**Files:**
- Modify: `src/ui/panels/question-panel.ts`
- Modify: `tests/question-panel.spec.ts`, `tests/app.snapshot.ts`, `tests/helpers/checkpoint.ts`

**Interfaces:**
- Produces: `intent: { kind: 'plan-review', approve }` renders the panel rule as `─ plan review ─…`, marks the approve-labeled option `▸ <label>` in success tone as the primary action, and guarantees the approve answer is `{ selected: [approve] }` with NO custom key (plan-mode's verified check: `selected.length === 1 && selected[0] === approve && custom === undefined`). Unrecognized intent kinds render as a generic question (wire shape untouched, spec §3.4).

- [ ] **Step 1: Write the failing tests**

```ts
describe('plan-review intent (spec §3.4)', () => {
  const planQ = () => q({
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: '# The plan\n1. do things',
    options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  })
  it('renders the plan-review rule and highlights the approve option as primary', () => {
    const { panel } = mountQuestions([planQ()])
    const text = panel.render(60).join('\n')
    expect(text).toContain('─ plan review ')
    expect(text).toContain('▸ Approve')
    expect(text).not.toContain('▸ Keep planning')
  })
  it('approve answers exactly { selected: [approve] } with no custom key', () => {
    const { panel, answers } = mountQuestions([planQ()])
    panel.handleInput!('\r')                                   // cursor starts on Approve
    const item = (answers[0] as { answers: Record<string, unknown>[] }).answers[0]!
    expect(item).toEqual({ id: 'q1', selected: ['Approve'] })
    expect('custom' in item).toBe(false)
  })
  it('unknown intent kinds fall back to the generic panel', () => {
    const { panel } = mountQuestions([q({ intent: { kind: 'future-thing', approve: 'x' } as never })])
    expect(panel.render(60).join('\n')).toContain('─ question ')
  })
})
```

- [ ] **Step 2: Implement**

- `private get planReview(): string | undefined { const i = this.question.intent; return i !== undefined && i.kind === 'plan-review' ? i.approve : undefined }`
- Rule title: `this.planReview !== undefined ? 'plan review' : 'question'`.
- In `optionRows`, when `planReview === option.label`, prefix the label with `▸ ` and tone the row `palette.success` (bold accent still wins when it is ALSO the cursor row — cursor styling takes precedence).
- Single-select submit already omits `custom` (Task 9's `custom === '' ? {} : …` spread) — the test pins it.

- [ ] **Step 3: Snapshot checkpoints**

Add `'question-multiselect'` and `'plan-review'` to `CHECKPOINTS` + `OWNED`, with two new app.snapshot.ts tests driving the controller through the fake userQuestions provider: (a) a multiSelect question with one option checked and a custom draft (`[x]` marks visible), (b) the plan-review question above. `await checkpoint(...)` at the settled frame; answer afterward so `dispose` finds no open panel.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: plan-review intent rendering + wire-exact approve answers"
```

### Task 12: Commands backend — /help /status /exit /quit, submit routing, durable-event rendering

**Files:**
- Create: `src/backend/commands.ts`
- Modify: `src/backend/app-events.ts`, `src/backend/translate.ts`, `src/ui/transcript/transcript.ts`, `src/app/controller.ts`, `src/index.ts`
- Create: `tests/commands.spec.ts`
- Modify: `tests/translate.spec.ts`, `tests/controller.spec.ts`

**Interfaces:**
- Consumes: dsh `CommandDefinition`/`CommandResult` types (Task 6 plumbing), `parseCommand` (value import, vitest alias in place).
- Produces:

```ts
// src/backend/commands.ts
export interface TalonCommandDeps {
  requestExit(): void
  statusLines(): string[]
  list(): readonly { name: string; description: string; input?: { hint: string } }[]
}
/** Register talon's T2 command set GLOBALLY (root ctx — Ruling 3). Returns one disposer. */
export function registerTalonCommands(
  commands: { register(def: CommandDefinition): () => void },
  deps: TalonCommandDeps,
): () => void
export { parseCommand } from '@deepseek-ai/dsh-commands'
```

- Commands this task: `help` (success text: one `/${name} — ${description}` line per `deps.list()` entry), `status` (success text from `deps.statusLines()`), `exit` + `quit` (same handler: `deps.requestExit()`, `{ kind: 'success' }`). `/resume`/`/clear` land in Task 16; `/model`/`/details`/`/palette`/`/agents` belong to T3/T4 milestones.
- Controller submit routing: input starting with `/` goes to `executeSlash(line)`, never to the model. Per-execution `AbortController` kept in a set; `dispose()` aborts all (spec §3.5). `execute → undefined` appends a LOCAL notice `Unknown command: /<token>` (warning); a rejected execute appends an error notice with `displayText`-neutralized message. Successful results render via DURABLE events (Ruling 5), not the return value.
- New AppEvents + rendering: `command/run {name, args?}` → dim line `/name args` (`CommandRunCell`-free: reuse `NoticeCell` info tone); `command/done {kind, text?}` → success text as info notice (only when text present), error as error notice.
- `statusLines()` (wired in controller): `session <id>`, `workspace <cwd>`, `agent <idle|running>`.

- [ ] **Step 1: Write the failing backend tests**

```ts
// tests/commands.spec.ts
import { describe, expect, it } from 'vitest'
import { registerTalonCommands } from '../src/backend/commands.ts'

function fakeCommands() {
  const defs = new Map<string, { name: string; description: string; handler: (i: { commandId: string; agent: unknown; rawInput: string; signal: AbortSignal }) => unknown }>()
  return {
    defs,
    register(def: never) {
      const d = def as never as { name: string }
      defs.set(d.name, def as never)
      return () => defs.delete(d.name)
    },
  }
}

describe('registerTalonCommands', () => {
  const deps = () => ({
    exits: 0,
    requestExit() { this.exits += 1 },
    statusLines: () => ['session s1', 'workspace /w', 'agent idle'],
    list: () => [{ name: 'help', description: 'List commands' }, { name: 'status', description: 'Show session status' }],
  })
  const invoke = { commandId: 'c', agent: {}, rawInput: '', signal: new AbortController().signal }
  it('registers the T2 set and disposes as one', () => {
    const svc = fakeCommands()
    const d = deps()
    const off = registerTalonCommands(svc as never, d)
    expect([...svc.defs.keys()].sort()).toEqual(['exit', 'help', 'quit', 'status'])
    off()
    expect(svc.defs.size).toBe(0)
  })
  it('help lists /name — description lines from deps.list()', async () => {
    const svc = fakeCommands()
    registerTalonCommands(svc as never, deps())
    const result = await svc.defs.get('help')!.handler(invoke) as { kind: string; text?: string }
    expect(result.kind).toBe('success')
    expect(result.text).toContain('/help — List commands')
    expect(result.text).toContain('/status — Show session status')
  })
  it('status returns deps.statusLines()', async () => {
    const svc = fakeCommands()
    registerTalonCommands(svc as never, deps())
    const result = await svc.defs.get('status')!.handler(invoke) as { kind: string; text?: string }
    expect(result).toEqual({ kind: 'success', text: 'session s1\nworkspace /w\nagent idle' })
  })
  it('exit and quit share the requestExit handler', async () => {
    const svc = fakeCommands()
    const d = deps()
    registerTalonCommands(svc as never, d)
    await svc.defs.get('exit')!.handler(invoke)
    await svc.defs.get('quit')!.handler(invoke)
    expect(d.exits).toBe(2)
  })
})
```

- [ ] **Step 2: translate + controller routing tests**

`tests/translate.spec.ts`:

```ts
  it('translates command/run and command/done', () => {
    expect(translateSessionEvent({ type: 'command/run', data: { commandId: 'c1', name: 'status', args: undefined, source: { kind: 'user' } } }))
      .toEqual([{ kind: 'command-run', name: 'status', args: undefined }])
    expect(translateSessionEvent({ type: 'command/run', data: { commandId: 'c1', name: 'help', args: 'verbose', source: { kind: 'user' } } }))
      .toEqual([{ kind: 'command-run', name: 'help', args: 'verbose' }])
    expect(translateSessionEvent({ type: 'command/done', data: { commandId: 'c1', kind: 'success', text: 'ok' } }))
      .toEqual([{ kind: 'command-done', result: 'success', text: 'ok' }])
    expect(translateSessionEvent({ type: 'command/done', data: { commandId: 'c1', kind: 'error', text: 'nope' } }))
      .toEqual([{ kind: 'command-done', result: 'error', text: 'nope' }])
    expect(translateSessionEvent({ type: 'command/done', data: { commandId: 'c1', kind: 'success' } }))
      .toEqual([{ kind: 'command-done', result: 'success', text: undefined }])
  })
```

`tests/controller.spec.ts` — `setup()` gains a commands facet passed through `ControllerDeps` (see Step 3), overridable per test:

```ts
// in setup(): const commands = { register: () => () => {}, list: () => [], execute: vi.fn(async () => ({ commandId: 'c', result: { kind: 'success' } })), ...overrides.commands }
// createController({ …, commands }) — and setup returns { …, commands }

  it('slash input routes to commands.execute, never to the model', async () => {
    const { agent, terminal, commands, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(commands.execute).toHaveBeenCalledOnce())
    expect(commands.execute.mock.calls[0]![1]).toBe('/status')
    expect(agent.followups.length).toBe(0)
    await controller.dispose()
  })
  it('unknown command renders a local warning notice', async () => {
    const { terminal, controller } = setup({ commands: { execute: vi.fn(async () => undefined) } })
    await terminal.waitForFrame(0)
    terminal.input('/nope extra args')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('Unknown command: /nope'))
    await controller.dispose()
  })
  it('rejected execute renders a neutralized error notice', async () => {
    const { terminal, controller } = setup({ commands: { execute: vi.fn(async () => { throw new Error('handler exploded \x1b[31m') }) } })
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(terminal.snapshot()).toContain('handler exploded \\x1b[31m'))
    await controller.dispose()
  })
  it('dispose aborts in-flight command signals', async () => {
    let captured: AbortSignal | undefined
    const { terminal, controller } = setup({ commands: { execute: vi.fn((_a: unknown, _l: string, signal: AbortSignal) => { captured = signal; return new Promise(() => {}) }) } })
    await terminal.waitForFrame(0)
    terminal.input('/status')
    terminal.input('\r')
    await vi.waitFor(() => expect(captured).toBeDefined())
    await controller.dispose()
    expect(captured!.aborted).toBe(true)
  })
```

- [ ] **Step 3: Implement**

`commands.ts`:

```ts
// src/backend/commands.ts
/** talon's own slash commands, registered GLOBALLY on the root ctx (Ruling 3:
 * survives D8 rebinding; single-UI process makes global ≡ agent-scoped).
 * Handlers stay thin: everything stateful comes in through deps. */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

export interface TalonCommandDeps {
  requestExit(): void
  statusLines(): string[]
  list(): readonly { name: string; description: string; input?: { hint: string } }[]
}

export function registerTalonCommands(
  commands: { register(def: CommandDefinition): () => void },
  deps: TalonCommandDeps,
): () => void {
  const exitHandler = (): { kind: 'success' } => { deps.requestExit(); return { kind: 'success' } }
  const disposers = [
    commands.register({
      name: 'help', description: 'List available commands',
      handler: () => ({ kind: 'success', text: deps.list().map((c) => `/${c.name} — ${c.description}`).join('\n') }),
    }),
    commands.register({
      name: 'status', description: 'Show session status',
      handler: () => ({ kind: 'success', text: deps.statusLines().join('\n') }),
    }),
    commands.register({ name: 'exit', description: 'Exit talon', handler: exitHandler }),
    commands.register({ name: 'quit', description: 'Exit talon (alias of /exit)', handler: exitHandler }),
  ]
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
```

`app-events.ts`: add `{ kind: 'command-run'; name: string; args: string | undefined }` and `{ kind: 'command-done'; result: 'success' | 'error'; text: string | undefined }`. `translate.ts`: the two cases (data fields per the crib; `args` passes through as-is). `transcript.ts`:

```ts
      case 'command-run': {
        this.spaceBeforeNewCell()
        const c = new NoticeCell({ text: `/${event.name}${event.args === undefined ? '' : ` ${event.args}`}`, tone: 'info' }, this.palette)
        this.addChild(c, c.contentLineCount())
        break
      }
      case 'command-done':
        if (event.text !== undefined && event.text !== '') {
          this.spaceBeforeNewCell()
          const c = new NoticeCell({ text: event.text, tone: event.result === 'error' ? 'error' : 'info' }, this.palette)
          this.addChild(c, c.contentLineCount())
        }
        break
```

Controller: extend `ControllerDeps` with `commands: { register: …; list(agent: unknown): readonly CommandDescriptorLike[]; execute(agent: unknown, line: string, signal: AbortSignal): Promise<unknown> }`; wire in `src/index.ts` (`inject` gains `'commands'`; pass `anyCtx.commands`). In the controller:

```ts
  const commandRuns = new Set<AbortController>()
  const executeSlash = (line: string): void => {
    const controllerAbort = new AbortController()
    commandRuns.add(controllerAbort)
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
  }
```

`appendLocalNotice` = spacer + NoticeCell + `tui.requestRender()` (NoticeCell already displayText-neutralizes). `composer.onSubmit` routes: `text.startsWith('/') ? executeSlash(text) : existing followup/steer path` — still `addToHistory(text)` + clear. `dispose()` runs `for (const c of commandRuns) c.abort()`. Register commands (root ctx service) with deps: `requestExit`, `statusLines: () => [`session ${bound.id}`, `workspace ${process.cwd()}`, `agent ${running ? 'running' : 'idle'}`]`, `list: () => deps.commands.list(bound)`; push the disposer into `detachers`.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: slash command set + routing + durable-event result rendering (spec §3.5)"
```

---

### Task 13: Slash autocomplete (talon provider + composer wiring)

**Files:**
- Create: `src/ui/composer/slash-provider.ts`
- Modify: `src/ui/composer/composer.ts`, `src/app/controller.ts`
- Create: `tests/slash-provider.spec.ts`
- Modify: `tests/app.snapshot.ts`, `tests/helpers/checkpoint.ts`

**Interfaces:**
- Consumes: FramelessEditor sentinel stripping (Task 4 — HARD prerequisite), `deps.commands.list` (Task 12).
- Produces:

```ts
// src/ui/composer/slash-provider.ts
export function createSlashProvider(list: () => readonly { name: string; description: string; input?: { hint: string } }[]): AutocompleteProvider
// Composer gains: attachSlashCompletion(provider): void  (calls editor.setAutocompleteProvider)
// Controller: on 'commands/change' → if editor.isShowingAutocomplete() re-query via editor.handleInput('\t') (the recovered refresh nudge).
```

- Semantics (upstream `/`-branch mirrored exactly — Ruling 4): trigger only when the text before the cursor on line 0 starts with `/` and contains no space; fuzzy-filter over command names; item description = `hint — description` when a hint exists; returned `prefix` INCLUDES the leading `/`; accept rewrites the line to `/name ` with the cursor after the space (upstream applyCompletion contract), so Enter-accept falls through to submit (editor.js:564 behavior).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/slash-provider.spec.ts
import { describe, expect, it } from 'vitest'
import { createSlashProvider } from '../src/ui/composer/slash-provider.ts'

const provider = () => createSlashProvider(() => [
  { name: 'help', description: 'List available commands' },
  { name: 'status', description: 'Show session status' },
  { name: 'resume', description: 'Resume a session', input: { hint: '[filter]' } },
])
const opts = { signal: new AbortController().signal }

describe('createSlashProvider', () => {
  it('suggests fuzzy-matched commands with the /-inclusive prefix', async () => {
    const s = await provider().getSuggestions(['/st'], 0, 3, opts)
    expect(s).not.toBeNull()
    expect(s!.prefix).toBe('/st')
    expect(s!.items.map((i) => i.value)).toEqual(['status'])
  })
  it('lists everything for a bare slash', async () => {
    const s = await provider().getSuggestions(['/'], 0, 1, opts)
    expect(s!.items.map((i) => i.value)).toEqual(['help', 'status', 'resume'])
  })
  it('folds the argument hint into the description', async () => {
    const s = await provider().getSuggestions(['/re'], 0, 3, opts)
    expect(s!.items[0]!.description).toBe('[filter] — Resume a session')
  })
  it('stays silent off-trigger: no leading slash, after a space, off line 0, or no match', async () => {
    expect(await provider().getSuggestions(['hi'], 0, 2, opts)).toBeNull()
    expect(await provider().getSuggestions(['/help now'], 0, 9, opts)).toBeNull()
    expect(await provider().getSuggestions(['x', '/h'], 1, 2, opts)).toBeNull()
    expect(await provider().getSuggestions(['/zzz'], 0, 4, opts)).toBeNull()
  })
  it('applyCompletion rewrites the line to /name␣ with the cursor after the space', () => {
    const r = provider().applyCompletion(['/st tail'], 0, 3, { value: 'status', label: 'status' }, '/st')
    expect(r.lines).toEqual(['/status tail'])
    expect(r.cursorLine).toBe(0)
    expect(r.cursorCol).toBe('/status '.length)
  })
})
```

- [ ] **Step 2: Implement**

```ts
// src/ui/composer/slash-provider.ts
/** Slash-command completion: mirrors pi-tui CombinedAutocompleteProvider's
 * '/'-branch exactly (fuzzy over names, prefix includes '/', accept inserts
 * '/name '), but reads the live command list through a closure — so
 * commands/change needs no provider rebuild (Ruling 4). File/@ completion is
 * deliberately absent until T4. */
import { fuzzyFilter } from '@earendil-works/pi-tui'
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'

export function createSlashProvider(
  list: () => readonly { name: string; description: string; input?: { hint: string } }[],
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol): Promise<AutocompleteSuggestions | null> {
      if (cursorLine !== 0) return null
      const before = (lines[0] ?? '').slice(0, cursorCol)
      if (!before.startsWith('/') || before.includes(' ')) return null
      const prefix = before.slice(1)
      const items: AutocompleteItem[] = fuzzyFilter([...list()], prefix, (c) => c.name).map((c) => ({
        value: c.name,
        label: c.name,
        ...((): { description?: string } => {
          const description = c.input?.hint !== undefined ? `${c.input.hint} — ${c.description}` : c.description
          return description === '' ? {} : { description }
        })(),
      }))
      return items.length === 0 ? null : { items, prefix: before }
    },
    applyCompletion(lines, cursorLine, cursorCol, item) {
      const line = lines[cursorLine] ?? ''
      const after = line.slice(cursorCol)
      const next = [...lines]
      next[cursorLine] = `/${item.value} ${after.startsWith(' ') ? after.slice(1) : after}`
      return { lines: next, cursorLine, cursorCol: item.value.length + 2 }
    },
  }
}
```

Composer: `attachSlashCompletion(provider: AutocompleteProvider): void { this.editor.setAutocompleteProvider(provider) }`. Controller: after registering commands, `composer.attachSlashCompletion(createSlashProvider(() => deps.commands.list(bound)))`; subscribe `detachers.push(ctx.on('commands/change', () => { if (composer.editor.isShowingAutocomplete()) composer.editor.handleInput('\t') }))`.

- [ ] **Step 3: Snapshot checkpoint**

Add `'slash-autocomplete'` to `CHECKPOINTS`/`OWNED`; test: controller with the fake commands facet listing the T2 set, `terminal.input('/')`, wait for `isShowingAutocomplete()` (vi.waitFor) then the settled frame, `checkpoint('slash-autocomplete', terminal)` — proves the menu renders below the composer with borders stripped (Task 4 payoff).

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: slash-command autocomplete via closure-backed talon provider"
```

### Task 14: Sessions backend — resume candidates + title ladder

**Files:**
- Create: `src/backend/sessions.ts`
- Create: `tests/sessions.spec.ts`

**Interfaces:**
- Produces (all service handles come in as minimal facets so tests run on fakes — the *Deps pattern):

```ts
// src/backend/sessions.ts
export interface SessionRecordLike { header: { id: string; createdAt: number; cwd?: string }; live: boolean; persisted: boolean }
export interface ResumeCandidate {
  id: string; title: string; lastActivityAt: number; cwd: string | undefined
  live: boolean; persisted: boolean; currentWorkspace: boolean; disabledReason?: string
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
export function summarizeCandidate(record: SessionRecordLike, title: string | undefined, lastActivityAt: number | undefined, currentId: string, cwd: string): ResumeCandidate
export async function buildResumeCandidates(services: SessionServices, opts: { currentId: string; cwd: string; concurrency?: number; signal?: AbortSignal }): Promise<ResumeCandidate[]>
```

- Laws (recovered + spec §3.6): disable ladder is `else if` ordered — `current session` → `session is already live in this runtime` → `session has no recorded workspace`; workspace mismatch is a SCOPE, never a disable. Title ladder per record: live session → `liveTitle` (nullish → fallback) → `cachedSnapshot` (when its values carry a `title` key) → `coldSnapshot` (write-back is the cache's own business). NO cache service (`cachedSnapshot`/`coldSnapshot` absent) → ONE `readTitleSnapshots` batch for all non-live records. Per-record failures isolate into `title: 'Unreadable session'` + `disabledReason: 'session cannot be loaded: <chain>'`. `lastActivityAt`: live tail event time → header.createdAt (no mtime probing in v1 — sessionPersistence.locate stays out of scope; ruling: createdAt is an honest lower bound and the ISO row makes staleness visible). Untitled → `'Untitled session'`. Sort: `lastActivityAt` desc, id asc. Worker pool caps ladder concurrency at `opts.concurrency ?? 4` (spec §3.6).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sessions.spec.ts
import { describe, expect, it } from 'vitest'
import { buildResumeCandidates, summarizeCandidate } from '../src/backend/sessions.ts'

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
```

- [ ] **Step 2: Run to verify failure, then implement**

Implementation notes (hand-written worker pool, spec §3.6):

```ts
export async function buildResumeCandidates(services, opts) {
  const records = await services.listSessions(opts.signal)
  const titles = new Map<string, string | undefined>()
  const failures = new Map<string, string>()
  const hasCacheLadder = services.cachedSnapshot !== undefined || services.coldSnapshot !== undefined
  const pending: SessionRecordLike[] = []
  for (const record of records) {
    const live = services.liveSession(record.header.id)
    if (live !== undefined && services.liveTitle !== undefined) { titles.set(record.header.id, services.liveTitle(live) ?? undefined); continue }
    const cached = services.cachedSnapshot?.(record.header)
    if (cached !== undefined && 'title' in cached.values) { titles.set(record.header.id, cached.values.title ?? undefined); continue }
    pending.push(record)
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
```

(`summarizeCandidate` is the recovered function adapted to the flat `ResumeCandidate` shape; unreadable overlay REPLACES an ordinary disable reason — failure wins, old-TUI precedent.)

- [ ] **Step 3: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: resume candidates — disable ladder, title ladder, batch fallback, worker pool (spec §3.6)"
```

---

### Task 15: Resume selector panel

**Files:**
- Create: `src/ui/panels/resume-panel.ts`
- Create: `tests/resume-panel.spec.ts`
- Modify: `tests/app.snapshot.ts`, `tests/helpers/checkpoint.ts`

**Interfaces:**
- Consumes: `ResumeCandidate` (Task 14), pi-tui `SelectList` + `Input` + `fuzzyFilter`, `panelRule`.
- Produces:

```ts
// src/ui/panels/resume-panel.ts
export class ResumePanel implements Component {
  constructor(finish: (picked: ResumeCandidate | undefined) => void, palette: Palette, formatWorkspace: (cwd: string | undefined) => string)
  setCandidates(candidates: ResumeCandidate[]): void   // loading → loaded swap without replacing the panel
}
```

Rendered shape (SelectList single-line rows — Ruling 9):

```
<blank>
─ resume ───────────────────────────────────────
⌕ type to filter                                 ← Input row (dim placeholder when empty)
this workspace ~/w  ⇥ all workspaces (4)         ← scope line: active accent, other dim
→ Fix the login flow      2026-08-14T09:00:00.000Z · live · persisted · s-abc
  Untitled session        2026-08-13T10:00:00.000Z · persisted · s-def · unavailable: session has no recorded workspace
  (2/4)                                          ← SelectList scrollInfo when scrolled
↑/↓ · tab scope · enter resume · esc clear/cancel ← dim hint
Sessions are still loading. / <error>            ← dim while loading; error tone on failed Enter
```

- Behavior: default scope `'workspace'` (candidates with `currentWorkspace`), `tab` toggles to `'all'` and RESETS query+selection (old-TUI exact); fuzzy filter over `title + id (+ workspace label in 'all' scope only)`; `up`/`down` forward to the SelectList; `enter` on a disabled row shows its `disabledReason` as the error line, on an enabled row calls `finish(candidate)`; `escape` clears a non-empty query else `finish(undefined)`; all other keys go to the Input; a query change rebuilds the SelectList (items are constructor-only). Row description = `` `${iso} · ${flags} · ${id}${scope === 'all' ? ` · ${workspaceLabel}` : ''}${disabled ? ` · unavailable: ${reason}` : ''}` `` where flags = `live`/`persisted` joined by ` · `. SelectList theme: `selectedText: palette.selected` (reverse video — spec: selectors only), `description/scrollInfo/noMatch: palette.dim`, `selectedPrefix: identity` (dead upstream, required field). `maxVisible` 8.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/resume-panel.spec.ts
import { describe, expect, it } from 'vitest'
import { ResumePanel } from '../src/ui/panels/resume-panel.ts'
import { createPalette } from '../src/theme/palette.ts'
import type { ResumeCandidate } from '../src/backend/sessions.ts'

const cand = (id: string, over: Partial<ResumeCandidate> = {}): ResumeCandidate => ({
  id, title: `Session ${id}`, lastActivityAt: 1_755_100_000_000, cwd: '/w',
  live: false, persisted: true, currentWorkspace: true, ...over,
})
function mount(candidates?: ResumeCandidate[]) {
  const picks: (ResumeCandidate | undefined)[] = []
  const panel = new ResumePanel((p) => picks.push(p), createPalette(false), (cwd) => cwd ?? 'cwd unset')
  if (candidates) panel.setCandidates(candidates)
  return { panel, picks }
}

describe('ResumePanel', () => {
  it('shows the loading state until candidates arrive', () => {
    const { panel } = mount()
    expect(panel.render(60).join('\n')).toContain('Loading sessions')
    panel.handleInput!('\r')
    expect(panel.render(60).join('\n')).toContain('Sessions are still loading.')
  })
  it('lists current-workspace candidates by default; tab reveals all-workspaces rows', () => {
    const { panel } = mount([cand('a'), cand('b', { currentWorkspace: false, cwd: '/elsewhere', title: 'Foreign' })])
    const text = panel.render(80).join('\n')
    expect(text).toContain('Session a')
    expect(text).not.toContain('Foreign')
    panel.handleInput!('\t')
    const all = panel.render(80).join('\n')
    expect(all).toContain('Foreign')
    expect(all).toContain('/elsewhere')
  })
  it('enter picks the selected enabled candidate', () => {
    const { panel, picks } = mount([cand('a'), cand('b', { title: 'Second' })])
    panel.handleInput!('\x1b[B')
    panel.handleInput!('\r')
    expect(picks).toEqual([expect.objectContaining({ id: 'b' })])
  })
  it('enter on a disabled row surfaces the reason instead of picking', () => {
    const { panel, picks } = mount([cand('a', { disabledReason: 'session is already live in this runtime' })])
    panel.handleInput!('\r')
    expect(picks).toEqual([])
    expect(panel.render(80).join('\n')).toContain('session is already live in this runtime')
  })
  it('typing filters fuzzily; esc clears the query first, then cancels', () => {
    const { panel, picks } = mount([cand('a', { title: 'Fix login' }), cand('b', { title: 'Write docs' })])
    for (const ch of 'docs') panel.handleInput!(ch)
    const text = panel.render(80).join('\n')
    expect(text).toContain('Write docs')
    expect(text).not.toContain('Fix login')
    panel.handleInput!('\x1b')
    expect(panel.render(80).join('\n')).toContain('Fix login')   // query cleared, list restored
    expect(picks).toEqual([])
    panel.handleInput!('\x1b')
    expect(picks).toEqual([undefined])                            // second esc cancels
  })
  it('filter matches the workspace label only in the all scope', () => {
    const { panel } = mount([cand('a'), cand('b', { currentWorkspace: false, cwd: '/elsewhere', title: 'Foreign' })])
    panel.handleInput!('\t')
    for (const ch of 'elsewhere') panel.handleInput!(ch)
    const text = panel.render(80).join('\n')
    expect(text).toContain('Foreign')
    expect(text).not.toContain('Session a')
  })
  it('every row stays within width', () => {
    const { panel } = mount([cand('a', { title: 'x'.repeat(200), disabledReason: 'session has no recorded workspace' })])
    for (const row of panel.render(40)) expect(row.replace(/\x1b\[[0-9;]*m/g, '').length).toBeLessThanOrEqual(40)
  })
  it('neutralizes hostile titles (D7.8)', () => {
    const { panel } = mount([cand('a', { title: 'evil\x1b]2;t\x07' })])
    expect(panel.render(80).join('\n')).toContain('evil\\x1b]2;t\\x07')
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement**

Implementation skeleton:

```ts
// src/ui/panels/resume-panel.ts
/** Resume selector (spec §3.6/§4.4): SelectList + fuzzy filter + scope
 * toggle. SelectList items are constructor-only, so every query/scope/
 * candidate change REBUILDS the list (the Editor does the same per query).
 * Disabled rows stay visible and explain themselves; Enter refuses them. */
import { Input, SelectList, fuzzyFilter, matchesKey, truncateToWidth, type Component, type SelectItem } from '@earendil-works/pi-tui'
…
export class ResumePanel implements Component {
  private candidates: ResumeCandidate[] | undefined
  private scope: 'workspace' | 'all' = 'workspace'
  private readonly input = new Input()
  private list: SelectList | undefined
  private error = ''
  get focused() / set focused  → forward to this.input
  // scoped(): candidates filtered by scope; filtered(): fuzzyFilter(scoped, query, c => `${c.title} ${c.id}${scope === 'all' ? ` ${label(c.cwd)}` : ''}`)
  // rebuild(): this.list = new SelectList(filtered.map(toItem), 8, theme, { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 }); keep list.onSelect = () => this.pick()
  // handleInput: enter → pick(); tab → toggle scope + input.setValue('') + rebuild; esc → query ? (input.setValue(''), rebuild) : finish(undefined);
  //   up/down → list?.handleInput(data); else → input.handleInput(data) + if query changed rebuild()
  // pick(): candidates undefined → error 'Sessions are still loading.'; none selected → error 'No session matches this search.';
  //   disabledReason → error = reason; else finish(candidate)  (map SelectItem.value → candidate by id)
  // render(width): rule, input row (placeholder '⌕ type to filter' dim when empty, else '⌕ ' + input row), scope line, list rows (or loading/dim 'No matching sessions.'), hint, error — every row truncateToWidth'd.
}
```

Selection state note: rebuilding SelectList resets its cursor — acceptable (query changes re-anchor to the best match, upstream Editor behavior). `pick()` uses `this.list?.getSelectedItem()`.

- [ ] **Step 3: Snapshot checkpoint**

Add `'resume-selector'` to `CHECKPOINTS`/`OWNED`: mount ResumePanel THROUGH the controller's PanelManager (enqueue directly in the test), `setCandidates` with three fixed candidates (one foreign-workspace, one disabled-live), settled frame → `checkpoint('resume-selector', terminal)`; then Esc to close before dispose.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: resume selector panel — SelectList + fuzzy filter + scope toggle"
```

### Task 16: In-process resume — preflight, rebind, /resume, /clear (D8)

**Files:**
- Modify: `src/backend/sessions.ts` (preflight + resumeRoute), `src/backend/commands.ts` (second registration fn), `src/app/controller.ts`, `src/boot.ts` (extract `createRootAgent`), `src/index.ts`
- Modify: `tests/sessions.spec.ts`, `tests/controller.spec.ts`, `tests/boot.spec.ts`

**Interfaces:**
- Produces:

```ts
// src/backend/sessions.ts additions
export interface PreflightServices {
  agentStatus(): 'idle' | 'running'
  listSessions(): Promise<SessionRecordLike[]>
  readSession(id: string): Promise<{ events: readonly { type: string; data: unknown }[] }>
  listProviders(): { id: string }[]
}
/** Latest request/header else latest assistant/message → {provider, model}; undefined when the log names neither. */
export function resumeRoute(events: readonly { type: string; data: unknown }[]): { provider: string; model: string } | undefined
/** The recovered preflight, verbatim semantics: idle at entry AND exit, record re-read, full readSession, route provider present, cwd recorded. Throws Error with the exact recovered message on each failure. */
export async function preflightResume(services: PreflightServices, id: string, opts: { currentId: string; cwd: string }): Promise<{ id: string; cwd: string }>

// src/backend/commands.ts addition
export function registerSessionCommands(
  commands: { register(def: CommandDefinition): () => void },
  deps: { openResume(): void; newSession(): void },
): () => void   // registers 'resume' (Resume a previous session) + 'clear' (Start a fresh session)

// src/boot.ts extraction
export async function createRootAgent(ctx: BootContext, sessionId?: string): Promise<unknown /* AgentHandle */>

// controller return widens: createController(deps) → { dispose(): Promise<void>; panels: PanelManager; bindAgent(next: AgentFacet): void }
bindAgent(next: AgentFacet): void   // rebind subscription identity, rebuild transcript from next.session.events, reset composer/panels-adjacent state
```

- Flow (D8 exact order): `/resume` → guard (running → error notice; sessionQuery absent → error notice) → enqueue ResumePanel + async `buildResumeCandidates` fills it (candidate build failure closes the panel with an error notice) → picked → `preflightResume` → `process.chdir(cwd)` (BEFORE any teardown; a chdir throw leaves everything intact) → `agents.resume({ resumeSessionId })` → `bindAgent(handle.agent)` → local notice `Resumed session <id> · <cwd>`. Old agent stays alive; only the binding moves (Ruling 8). `/clear` → guard running → `createRootAgent(ctx, undefined)` → `bindAgent(handle.agent)` → notice `Started a fresh session <id>`.
- `bindAgent`: `bound = next`; `running = next.status === 'running'`; transcript slot cleared and a NEW `Transcript` mounted; `pendingCalls.clear()`; replay `for (const e of next.session.events) for (const a of translateSessionEvent(e)) transcript.apply(a)`; composer state/hint reset; `tui.requestRender()`. The Task 5 root-ctx flip + identity filters make all live subscriptions follow `bound` automatically.
- Controller restructures the transcript mount as a slot: `const transcriptSlot = new Container()` mounted first; `transcriptSlot.addChild(transcript.container)`; rebind = `transcriptSlot.clear()` + remount. (Container children order is the render order; the slot keeps position 0 stable across rebinds.)

- [ ] **Step 1: Write the failing preflight/route tests**

```ts
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
})
```

- [ ] **Step 2: Write the failing controller rebind tests**

```ts
describe('bindAgent / resume wiring', () => {
  it('rebind replays the new session and routes input to the new agent', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const next = fakeAgent('next')
    next.session = { id: 'next', events: [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'old prompt' }], source: { kind: 'user' } } },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'old reply' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ] }
    controller.bindAgent(next as never)
    const before = terminal.frames
    await terminal.waitForFrame(before - 1)
    expect(terminal.snapshot()).toContain('old reply')
    ctx.emit('session/event', next.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'live after rebind' }], source: { kind: 'user' } } })
    await terminal.waitForFrame(terminal.frames)
    expect(terminal.snapshot()).toContain('live after rebind')
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'stale old-agent event' }], source: { kind: 'user' } } })
    await new Promise((r) => setTimeout(r, 30))
    expect(terminal.snapshot()).not.toContain('stale old-agent event')
    terminal.input('hello'); terminal.input('\r')
    expect(next.followups.length).toBe(1)
    expect(agent.followups.length).toBe(0)
    await controller.dispose()
  })
})
```

(Adjust the waitForFrame bookkeeping to the helper's semantics at implementation time; the assertions are the contract.)

- [ ] **Step 3: Implement backend + controller + commands + boot extraction**

`sessions.ts` — `resumeRoute` and `preflightResume` exactly as the recovered code (messages verbatim: `Resume requires an idle agent (status: ${s}).`, `` `Session "${id}" is no longer available.` ``, `` `session cannot be loaded: ${chain}` ``, `` `session is complete, but route is currently unavailable (${route.provider}/${route.model})` ``, `` `Session "${id}" has no recorded workspace to resume in.` `` — reusing `summarizeCandidate` for the fresh-record disable re-derivation).

`boot.ts`: extract the body of `run()` after the loader await into:

```ts
export async function createRootAgent(ctx: BootContext, sessionId?: string): Promise<{ agent: { id: string } }> {
  const id = SessionId(sessionId ?? `session-${crypto.randomUUID()}`)
  const existing = ctx.agents.roots().find(agent => agent.id === id)
  if (existing) return { agent: existing as { id: string } }
  …defaultModel lookup + installModelSelection + agents.create exactly as today, returning the handle…
}
```

`run()` becomes `await createRootAgent(ctx, config.sessionId)` (existing boot tests keep passing; add one direct `createRootAgent` reuse test). `agents.create` RETURNS the handle — return it.

`commands.ts` — `registerSessionCommands` registering `resume` (`Resume a previous session`, handler: `deps.openResume(); return { kind: 'success' }`) and `clear` (`Start a fresh session`, handler: `deps.newSession(); return { kind: 'success' }`). Both handlers fire-and-forget into controller async flows — the interesting output arrives as local notices, keeping command/done noise-free.

Controller — `openResume` (guards, panel, candidate fill via `buildResumeCandidates` with facets from `deps.services`, pick → `preflightResume` → `process.chdir` → `deps.agents.resume` → `bindAgent` → notice; every failure path → error notice with `displayText`) and `newSession` (`deps.createRootAgent()` → `bindAgent`). `ControllerDeps` gains:

```ts
  agents: { resume(opts: { resumeSessionId: string }): Promise<{ agent: AgentFacet }> }
  createRootAgent(): Promise<{ agent: AgentFacet }>
  services: {
    sessionQuery?: { listSessions(signal?: AbortSignal): Promise<SessionRecordLike[]>; readSession(id: string): Promise<{ events: readonly { type: string; data: unknown }[] }>; readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<never[]> }
    sessions: { get(id: string): { events: readonly { time?: number }[] } | undefined }
    projections?: { snapshot(s: unknown): { values: { title?: string | null } } }
    projectionCache?: { cachedSnapshot(h: never): never; coldSnapshot(id: string, signal?: AbortSignal): Promise<never> }
    llm?: { listProviders(): { id: string }[] }
  }
```

`src/index.ts`: `inject` gains `'llm'` (sessionQuery/projections/cache stay `ctx.get` optionals per spec §3.1); wire the facets (`anyCtx.get('sessionQuery')` etc.) and `createRootAgent: () => createRootAgent(ctx as never)` (import from `./boot.js`).

Controller test additions: `/resume` while running → warning notice, `/resume` without sessionQuery → `Resume is not available: session query is not mounted.`, successful picked-flow with fakes (chdir spied via `vi.spyOn(process, 'chdir').mockImplementation(() => {})` — REQUIRED so tests never actually chdir), chdir-throw path leaves the old binding intact and renders the error.

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: in-process resume — preflight, chdir-first, UI rebind, /resume + /clear (D8)"
```

---

### Task 17: ContextCard — injected context stops rendering as 'You' (carryover 11)

**Files:**
- Modify: `src/backend/app-events.ts`, `src/backend/translate.ts`, `src/ui/transcript/cells.ts`, `src/ui/transcript/transcript.ts`
- Modify: `tests/translate.spec.ts`, `tests/cells.spec.ts`, `tests/app.snapshot.ts`, `tests/helpers/checkpoint.ts`

**Interfaces:**
- Produces: `user/message` translation branches on `data.source.kind` (crib: `'user'` ⇔ real prompt; absent source defaults to `'user'` for fixture/legacy compat): non-user kinds become `{ kind: 'context-card'; label: string; summary: string | undefined; lines: number }` (label = source.kind; summary = `source.form === 'notice' ? source.summary : undefined`). `ContextCardCell` renders ONE dim line: `◇ context · <label>[ · <summary>] · <n> lines` (collapsed presentation, old-TUI precedent; expansion arrives with T3's visibility cycling).

- [ ] **Step 1: Write the failing tests**

```ts
// translate.spec.ts
  it('routes non-user sources to context cards (T2 carryover 11)', () => {
    expect(translateSessionEvent({ type: 'user/message', data: {
      content: [{ type: 'text', text: 'entry one\nentry two\nentry three' }],
      source: { kind: 'skill-catalog', form: 'catalog' },
    } })).toEqual([{ kind: 'context-card', label: 'skill-catalog', summary: undefined, lines: 3 }])
    expect(translateSessionEvent({ type: 'user/message', data: {
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'subagent finished' },
    } })).toEqual([{ kind: 'context-card', label: 'subagent-settled', summary: 'subagent finished', lines: 1 }])
  })
  it('keeps real user prompts as user messages — including sourceless fixtures', () => {
    expect(translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }))
      .toEqual([{ kind: 'user-message', text: 'hi' }])
    expect(translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }))
      .toEqual([{ kind: 'user-message', text: 'hi' }])
  })
// cells.spec.ts
  it('ContextCardCell renders one dim collapsed line with neutralized metadata', () => {
    const cell = new ContextCardCell('skill\x1bcatalog', 'sum\x07mary', 12, createPalette(false))
    expect(cell.contentLineCount()).toBe(1)
    const rows = cell.render(60)
    expect(rows).toEqual([expect.stringContaining('◇ context · skill\\x1bcatalog · sum\\x07mary · 12 lines')])
    expect(cell.render(60)).toBe(rows)   // width-keyed cache identity (.toBe law)
  })
```

- [ ] **Step 2: Implement**

translate `user/message` case:

```ts
    case 'user/message': {
      const kind = (d.source as { kind?: string } | undefined)?.kind ?? 'user'
      if (kind === 'user') return [{ kind: 'user-message', text: textOf(d.content) }]
      const source = d.source as { form?: string; summary?: string }
      const text = textOf(d.content)
      return [{
        kind: 'context-card',
        label: kind,
        summary: source.form === 'notice' ? source.summary : undefined,
        lines: text === '' ? 0 : text.split('\n').length,
      }]
    }
```

`ContextCardCell` (CachedCell; one dim truncated line; `· <summary>` segment only when present). Transcript case mirrors the other single-line cells (spacer + addChild with contentLineCount 1). Snapshot: add `'context-card'` checkpoint — controller test emits the skill-catalog event between two normal messages.

- [ ] **Step 3: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: ContextCard for injected non-user context (T2 carryover 11)"
```

### Task 18: Exit summary line + Ctrl+D running hint + doc carryovers (carryover 3, 2, 10)

**Files:**
- Modify: `src/app/controller.ts`, `src/ui/composer/composer.ts`
- Modify: `cordis.patch.yml`, `docs/superpowers/specs/2026-08-13-talon-ui-design.md`
- Modify: `tests/controller.spec.ts`, `tests/composer.spec.ts`

**Interfaces:**
- Produces:
  - Goodbye (Ruling 12): the user-exit path (`requestExit` only — never teardown/failLoud) writes `To resume: dsh --profile talon, then /resume — session <bound.id>` via `terminal.write(palette.dim(displayText(line)) + '\n')` AFTER `dispose()` (terminal restored) and before `exit(0)`.
  - Ctrl+D while running (spec §6, carryover 3): instead of the current silent swallow, flash the composer hint `Agent is running — press Esc to interrupt, then Ctrl+D to exit.` in warning tone; any later status transition restores the normal hint (already re-set on every `agent/status`).
  - Composer gains `flashHint(text: string, tone: 'warning'): void` (sets the hint with the tone instead of dim).
  - `cordis.patch.yml`: comment on the talon-boot/talon rows documenting the sessionId pairing law (carryover 2): *set `sessionId` on BOTH rows or NEITHER — talon-boot mints a fresh UUID when unset and talon-ui binds the first root, so the defaults compose; a single-sided pin binds nothing.*
  - Spec §4 wording (carryover 10): in the visual-language table, change the talon accent cell to name the layering exactly — truecolor teal is ONLY the two brand exceptions (wordmark gradient, brand text); the ANSI accent role stays `95` per D6. Add one clarifying sentence to §3.5: command registration is global on the root ctx in the D8 in-process-rebind design (single-UI process; recorded T2 ruling).

- [ ] **Step 1: Write the failing tests**

```ts
// controller.spec.ts
  it('user exit prints the goodbye line after teardown, before exit(0)', async () => {
    const { terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('\x04')                       // idle + empty → requestExit
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    const snap = terminal.snapshot()
    expect(snap).toContain('stopped=1')
    expect(snap).toContain('To resume: dsh --profile talon, then /resume — session main')
    await controller.dispose()
  })
  it('plugin teardown prints NO goodbye', async () => {
    const { terminal, controller } = setup()
    await terminal.waitForFrame(0)
    await controller.dispose()
    expect(terminal.snapshot()).not.toContain('To resume:')
  })
  it('Ctrl+D while running flashes the interrupt-first hint instead of exiting (carryover 3)', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    const before = terminal.frames
    terminal.input('\x04')
    await terminal.waitForFrame(before)
    expect(exit).not.toHaveBeenCalled()
    expect(terminal.snapshot()).toContain('press Esc to interrupt, then Ctrl+D to exit')
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' })
    await terminal.waitForFrame(terminal.frames)
    expect(terminal.snapshot()).not.toContain('press Esc to interrupt')
    await controller.dispose()
  })
```

- [ ] **Step 2: Implement**

Controller constants + `requestExit` change:

```ts
const GOODBYE = (sessionId: string): string => `To resume: dsh --profile talon, then /resume — session ${sessionId}`
// in requestExit's completion path (both branches):
//   void dispose().then(() => { terminal.write(palette.dim(displayText(GOODBYE(bound.id))) + '\n'); exit(0) })
```

Ctrl+D branch: `if (matchesKey(data, 'ctrl+d') && composer.editor.getText() === '') { if (!running) requestExit(); else { composer.flashHint(HINT_INTERRUPT_FIRST, 'warning'); tui.requestRender() } return { consume: true } }` with `const HINT_INTERRUPT_FIRST = 'Agent is running — press Esc to interrupt, then Ctrl+D to exit.'`. Composer:

```ts
  flashHint(text: string, tone: 'warning'): void {
    this.hint.setText(tone === 'warning' ? this.palette.warning(text) : this.palette.dim(text))
  }
```

(`setHint` keeps its dim contract; status transitions already call it, restoring the normal hint.) Then the yml comment and the two spec edits (surgical, wording-only — quote D6 as the authority; do not renumber sections).

- [ ] **Step 3: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: goodbye line on user exit + Ctrl+D interrupt-first hint + doc carryovers (T2 carryover 2, 3, 10)"
```

---

### Task 19: Zero-scrollback-wipe gate (carryover 8, D10④)

**Files:**
- Modify: `src/testing/headless-terminal.ts`
- Create: `tests/redraw.spec.ts`
- Modify: `tests/headless-terminal.spec.ts`

**Interfaces:**
- Produces: `HeadlessTerminal.get scrollbackWipes(): number` — counts `\x1b[3J` occurrences across everything written (the signature of pi-tui's full-redraw scrollback wipe, D10). A flow spec drives the FULL interaction surface built in T2 and pins the count at ZERO. (`PI_DEBUG_REDRAW=1` remains the interactive diagnostic; the counter is the CI-stable oracle — same underlying signal.)

- [ ] **Step 1: Write the failing test (property first: the counter itself)**

```ts
// headless-terminal.spec.ts addition
  it('counts ED3 scrollback wipes', () => {
    const t = new HeadlessTerminal(20, 6)
    t.start(() => {}, () => {})
    expect(t.scrollbackWipes).toBe(0)
    t.write('hello \x1b[3J world \x1b[3J')
    expect(t.scrollbackWipes).toBe(2)
  })
```

- [ ] **Step 2: The flow gate**

```ts
// tests/redraw.spec.ts
/** D10④ (T2 carryover 8): normal interaction — streaming, panel open/close,
 * slash menu, notices — must trigger ZERO full redraws. A full redraw emits
 * ED3 (\x1b[3J), wiping terminal scrollback; resize is the ONLY tolerated
 * trigger and stays out of this flow. */
```

Drive one controller session end-to-end with the established fakes: user message → streaming deltas → settle → turn end; approval request → panel → answer '1' → audit pair; question request (multiSelect) → space + enter; `/` → slash menu open → esc; `/status` roundtrip (command/run + command/done events); rebind to a second fake agent with a 3-event replay. After each phase `await terminal.waitForFrame(…)`; final assertion:

```ts
    expect(terminal.scrollbackWipes).toBe(0)
```

- [ ] **Step 3: Implement**

In `HeadlessTerminal.write`, before passing to the emulator: `this.wipes += (data.split('\x1b[3J').length - 1)`; expose the getter. (Count on the RAW written stream, not post-parse.)

- [ ] **Step 4: Run the full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS — if the flow test reports wipes > 0, that is a REAL D10 regression: find the mutation-above-viewport or shrink path that triggered it (PI_DEBUG_REDRAW=1 locally) and fix the component, never the assertion.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: zero-scrollback-wipe gate across the full T2 interaction flow (D10, carryover 8)"
```

---

### Task 20: PTY e2e — live approval proof (carryover 12 + T2 DoD)

**Files:**
- Create: `tests/e2e/tty-smoke.py`, `tests/e2e/tty-smoke.e2e.ts`, `vitest.e2e.config.ts`
- Modify: `package.json` (script `test:e2e`), `docs/INSTALL.md` (one paragraph documenting the e2e preconditions)

**Interfaces:**
- Produces: `pnpm test:e2e` — a real-PTY smoke against `pnpm dsh --profile talon` in the sibling harness. Self-skips (vitest `describe.skipIf`) unless ALL hold: `DEEPSEEK_API_KEY` set, `python3` on PATH, `../deepseek-harness` present, `$DSH_HOME/profiles/talon` (default `~/.dsh/profiles/talon`) installed. The default `pnpm test` NEVER runs it (e2e lives under `tests/e2e/*.e2e.ts`, outside the main include glob; separate config carries no coverage and a 420s timeout).
- Python phases (each `[ok]`/`[FAIL]` printed; exit code 0 only if all hard phases pass):
  1. **Mount:** wait for `enter send` (idle hint) — 120s.
  2. **Roundtrip:** type `Reply with exactly the single word READY`, Enter; running hint (soft), fresh `READY` after the echo watermark, idle hint restored (existing scratchpad logic carried over verbatim).
  3. **Approval (HARD — the DoD):** type: `Use the bash tool to run exactly: touch <MARKER>. That path is outside the workspace, so the sandbox will deny it; retry the SAME command once with sandbox_permissions escalation, justification "talon T2 e2e smoke". Do not ask me any questions.` where `MARKER = $HOME/.talon-e2e-<pid>`. Wait for the panel: `─ approval` AND `[1] allow once` (180s). Send `1`. Wait for the audit line `approval · bash · allowed once` AND `os.path.exists(MARKER)` (120s). Cleanup: `os.remove(MARKER)` in `finally`.
  4. **Goodbye + exit:** type `/exit`, Enter (exercises slash dispatch live); process exits 0 within 15s and the captured output contains `To resume: dsh --profile talon`.
  - Teardown/report: SIGTERM→SIGKILL process-group cleanup and the ANSI-stripped transcript tail, both carried over from the scratchpad script.
- The wrapper spec spawns `python3 tests/e2e/tty-smoke.py`, streams stdout to the vitest console, and asserts exit code 0.

- [ ] **Step 1: Write vitest.e2e.config.ts + script + wrapper**

```ts
// vitest.e2e.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['tests/e2e/*.e2e.ts'], pool: 'forks', testTimeout: 420_000, hookTimeout: 60_000 },
})
```

```json
    "test:e2e": "vitest run --config vitest.e2e.config.ts"
```

```ts
// tests/e2e/tty-smoke.e2e.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const harness = fileURLToPath(new URL('../../../deepseek-harness', import.meta.url))
const profile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'talon')
const python = ((): string | undefined => {
  try { return execFileSync('which', ['python3']).toString().trim() || undefined } catch { return undefined }
})()
const ready = process.env.DEEPSEEK_API_KEY !== undefined && python !== undefined && existsSync(harness) && existsSync(profile)

describe.skipIf(!ready)('tty smoke (live model + real PTY)', () => {
  it('boots, streams, approves a sandbox escalation, and exits with the goodbye line', () => {
    const result = spawnSync(python!, [fileURLToPath(new URL('./tty-smoke.py', import.meta.url))], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      timeout: 400_000,
    })
    expect(result.status).toBe(0)
  })
})
```

- [ ] **Step 2: Port + extend the Python script**

Start from the proven scratchpad script (same pump/wait_for/send/report helpers, same process-group teardown). Replace phase 4 and append:

```python
MARKER = os.path.expanduser(f"~/.talon-e2e-{os.getpid()}")
APPROVAL_PROMPT = (
    f"Use the bash tool to run exactly: touch {MARKER} . That path is outside the workspace, "
    "so the sandbox will deny it; retry the SAME command once with sandbox_permissions escalation, "
    "justification 'talon T2 e2e smoke'. Do not ask me any questions."
)
# Phase 3: approval
send(APPROVAL_PROMPT.encode(), "approval prompt")
send(b"\r", "Enter (dispatch approval turn)")
ok = wait_for(b"\xe2\x94\x80 approval", 180, "approval panel rule")          # '─ approval'
ok = ok and wait_for(b"[1] allow once", 10, "approval options")
if ok:
    time.sleep(0.3)
    send(b"1", "approve once")
    ok = wait_for(b"allowed once", 120, "approval audit line")
    deadline = time.time() + 30
    while ok and not os.path.exists(MARKER) and time.time() < deadline:
        pump(0.25)
    if not os.path.exists(MARKER):
        print("[FAIL] approved command did not create the marker file")
        ok = False
    else:
        print("[ok] approved command executed (marker exists)")
# Phase 4: /exit + goodbye
if ok:
    send(b"/exit", "typed /exit")
    send(b"\r", "Enter (/exit)")
    deadline = time.time() + 20
    while time.time() < deadline and proc.poll() is None:
        pump(0.25)
    ok = proc.poll() is not None and proc.returncode == 0
    print(f"[{'ok' if ok else 'FAIL'}] exit code {proc.returncode}")
    ok = ok and (b"To resume: dsh --profile talon" in buf)
    print(f"[{'ok' if ok else 'FAIL'}] goodbye line present")
```

`finally` gains `os.path.exists(MARKER) and os.remove(MARKER)`. Keep the idle-restored check between phases 2 and 3 (the panel must appear over a RUNNING turn — the composer rule turns warning; do not wait for idle inside phase 3).

Execution-time adaptation allowance: if the profile's sandbox mode turns out to permit `$HOME` writes (no denial → no escalation → no panel), pick a target the mode DOES deny (probe manually first with `pnpm dsh --profile talon` + the same prompt); the assertion set stays identical. If bash escalation is entirely unavailable in the composition, STOP — that is an acceptance-blocking finding to surface, not to code around.

- [ ] **Step 3: Run it (with the key present) and the default suite (without)**

Run: `pnpm test` → e2e NOT executed (glob excludes it). Run: `DEEPSEEK_API_KEY=… pnpm test:e2e` → PASS with all `[ok]` lines. Also verify the skip: `env -u DEEPSEEK_API_KEY pnpm test:e2e` → suite reports skipped, exit 0.

- [ ] **Step 4: INSTALL.md paragraph + commit**

Document: preconditions (built harness, installed talon profile via `link:`, `DEEPSEEK_API_KEY`, python3), the command, and that the approval phase creates+removes `~/.talon-e2e-<pid>`.

```bash
git add -A
git commit -m "test: live PTY e2e — boot/stream/approval-escalation/goodbye (T2 carryover 12 + DoD)"
```

---

## Acceptance mapping (spec §8 T2 row)

| Acceptance line | Where proven |
|---|---|
| 审批一次危险命令(dsh 首次) | Task 20 live (sandbox escalation approved once, marker file created); Task 7 unit/snapshot |
| 答一次多选提问 | Task 9 unit (multiSelect merge law) + Task 11 snapshot; live best-effort during final acceptance |
| 跨工作区恢复一个会话 | Tasks 14–16 unit (foreign-workspace scope + preflight + chdir-first) + scripted live check during final acceptance |
| fail-closed 测试绿 | Task 5 (crash → reject → service-normalized unavailable), Task 7 teardown test |
| 中止测试绿 | Task 5 signal tests + Task 7 pre-aborted/mid-abort tests |
| 归属过滤测试绿 | Task 7 attribution test (foreign agent → next()) |
| PanelManager FIFO+Guarded | Task 5 |
| 斜杠命令集 + 补全 | Tasks 12–13 (+16 for /resume, /clear) |
| resume 选择器+进程内恢复 | Tasks 14–16 |
| 退出摘要行 | Task 18 (+ Task 20 live) |
| Carryover 1–12 | 1→T4; 2→T18; 3→T18; 4→T2; 5→T1; 6→T3; 7→T3; 8→T19; 9→T1; 10→T18; 11→T17; 12→T20 |

## Execution notes

- Branch: `feat/t2-interaction` off `main`; merge locally back to `main` when every task + the acceptance run is green (superpowers:finishing-a-development-branch).
- Task order is dependency order: 4 before 13; 5 before 6–11 and 19; 12 before 13 and 16; 14 before 15–16. Tasks 1–3 are pure hardening and go first so everything later lands under the gates.
- dsh checkout is read-only reference; `pnpm run build:lib:host` there must predate typecheck/tests here (lib/types paths).
- After any src change intended for live smoke: `pnpm build` (the profile links `lib/` via `link:`).

