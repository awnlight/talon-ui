# talon-ui T3 Rendering Implementation Plan

> **For agentic workers:** Execute task-by-task with a fresh subagent per task and a review between tasks (the T2 discipline). Steps use checkbox (`- [ ]`) syntax; progress is tracked by one conventional commit per task.

**Goal:** T3 rich rendering per spec §8: Markdown streaming + syntax highlighting (highlight.js → ANSI-16 singleton engine shared by markdown/diff/terminal), the six tool-card classes (D12) with Ctrl+O tri-state visibility, diff line numbers, paletteSpec+ (brand truecolor layer) + `/palette`, footer metrics + prompt-glyph animation, compaction/retry visualization. Acceptance: recorded real coding-session replay all green; every card class has a snapshot; untrusted-controls adversarial snapshots green.

**Architecture:** Rendering stays event-driven and replay-identical (the compaction-marker principle): every new surface renders from durable session events through `translateSessionEvent` → `Transcript.apply`, so a resumed screen equals the live screen byte-for-byte — the ONLY exceptions are the live compaction indicator and the prompt-glyph animation, which are controller-owned ephemeral UI state driven by live dispatch only and never reconstructed from replayed history (spec §4.1). Tool cards are transcript cells keyed by `callId` that mutate in place on `tool/result` (the StreamingAssistantCell precedent: live until settled, width-cached after). All visibility cycling (Ctrl+O tri-state, Ctrl+R reasoning) is ephemeral UI state — never persisted, never logged (spec §3.10).

**Tech Stack:** unchanged from T2 (TypeScript strict ESM, Node >=22.19, pnpm, `@earendil-works/pi-tui@0.84.1`, vitest 3 + v8 coverage per-file 100%, `@xterm/headless`, dsh source-linked from `../deepseek-harness`) **plus two net-new runtime deps sanctioned by the spec: `highlight.js` (spec §8) and `saxes` (D13)**. No other new dependencies.

**Spec:** `docs/specs/2026-08-13-talon-ui-design.md` (D6, D7, D11, D12, D13, §3.2, §3.8, §4.1–§4.3, §5, §6, §7, §8 T3 row). dsh ground truth verified against `deepseek-harness@528c682e06` (**0.1.1-rc.1**, 2026-08-25). The T2 plan's crib is superseded where they disagree.

## Global Constraints

- Everything from T2 still binds: relative imports carry `.js`; every untrusted string passes `displayText()` **before** styling (D7.8 — and highlighting counts as styling: escape first, then inject ANSI); any rendered row wider than the terminal CRASHES TuiMainScreen — every card row is truncated or wrapped; no component constructs Text/Markdown or wraps inside `render(width)` for committed cells (§5.1) — live cards are the mutating tail and render freely until settled; mount-cap counts CONTENT lines (logical, pre-wrap), O(1) per apply; `setClearOnShrink(false)` stays and `tests/redraw.spec.ts` must stay at zero wipes through every new interaction; close panels via `setFocus(composerEditor)`; UI copy English, constants in the rendering file; per task `pnpm test && pnpm typecheck && pnpm build` green then a conventional commit; v8 per-file 100% with reasoned `/* v8 ignore */` only.
- **ANSI-16 discipline is machine-enforced**: `themeViolations()` runs at every checkpoint. The highlighter and every card tone must emit palette roles only. The single exemption (added in Task 12) is the brand gradient and it must be all rgb-fg (spec §7.1).
- **Ephemeral UI state law** (spec §3.10): Ctrl+O/Ctrl+R state is never persisted and never enters the session log.
- **Live-vs-replay law** (spec §4.1): the permanent compaction marker renders identically on live and replay paths; the live indicator and glyph animation are driven only by live events — `bindAgent`'s replay loop must not feed them.
- dsh contract facts below were verified against `deepseek-harness@528c682e06` (2026-08-25). If a signature disagrees at execution time, STOP and re-verify against the checkout; do not guess. rc-period drift is real (the rc.1 `images` slot broke slash dispatch in T2's aftermath).
- The spec is the authority for rendered shapes; where the spec is silent and rc.1 introduced something new, the ruling below governs and is recorded here.

## T3 Rulings (recorded per the standing "TUI best practice + spec as authority" mandate)

1. **Card registry is name-keyed with six classes + an unregistered fallback.** Known names map to a class; unknown names take the D13 path. The table (from the verified dsh-base + talon composition):
   - `terminal`: `bash`, `pwsh`
   - `diff`: `edit`, `write`, `str_replace_editor`
   - `read`: `read`, `read_image`
   - `search`: `grep`, `glob`
   - `web`: `web_search`, `web_fetch`
   - `generic` (curated): `todo_write`, `skill`, `subagent`, `subagent_fork`, `report`, `workflow`, `ralph`, `job_output`, `job_list`, `job_kill`, `get_goal`, `create_goal`, `update_goal`, `list_agents`, `send_message`, `interrupt_agent`, `exit_plan_mode`, `ask_user_question`
   - anything else → **unregistered**: result content through `renderUnknownXml` (saxes real parser, explicit refusal → plain text; D13).
2. **No code-dispatch card.** `run_code`/code mode is not composed in this bundle (verified: base `tools` row keeps native presentation), and spec §8 fixes six classes. The gap-doc's PTC suggestion is a future spec change, not a T3 item.
3. **`/details` selector stays out of T3** (T4). Ctrl+O is the tri-state entry point; spec §8 does not name `/details` in the T3 row.
4. **One `ToolCardCell` owns the shared machinery** (header line, tone, tri-state, ≤6-line `preview()` fold, failed-forces-expanded, mount-cap accounting); per-class **pure body builders** (`(view, palette, width-free) => content lines`) supply the content. The cache law lives in exactly one place.
5. **Cards mutate in place on `tool/result`, keyed by `callId`.** Transcript keeps `Map<callId, ToolCardCell>`; a card renders live (uncached) while pending and settles into the width-keyed cache on result — the StreamingAssistantCell precedent. `turn/end` clears pending references (a call with no result stays rendered as `◇` running head — that is what the log says happened).
6. **Compact checkpoint detection precedes the context-card branch** in translate: a `user/message` whose `source.kind === 'plugin' && source.plugin === 'compact'` becomes the permanent dim compaction marker (spec §4.1), NEVER a ContextCard. All other non-user sources keep the T2 ContextCard path.
7. **The live compaction indicator is controller state**, driven by live `compaction/start`/`compaction/end` dispatch only; `bindAgent`'s replay loop bypasses it by construction (an orphan `compaction/start` in history is normal, not evidence of an in-flight compaction). Elapsed seconds render from `Date.now()` (frozen in tests).
8. **Retry visualization**: on `llm/retry` for the live streaming cell's `${turn}:${step}`, the transcript **withdraws** the live streaming cell (explicit `withdraw(key)` API — the one sanctioned removal of a mounted component, spec §5.3) and appends the warning notice `Retrying model request (n/limit) in Xms: <msg>` — `limit` = `maxRetries` in mode `normal`, `∞` in mode `always`. `llm/retry-started` renders nothing. Successful recovery renders nothing. Exhaustion arrives as an ordinary error turn-end.
9. **rc.1 `assistant/message.interrupted: true` renders as a normal settle** of the delivered prefix, no extra marker — the aborted turn-end notice (`Turn cancelled.`) already communicates the cut. Recorded against rc.1 (`packages/core/session/lib/types/types.d.ts:279-285`); the spec predates the field.
10. **Footer is a fourth child of the composer container** (rule → editor → hint → footer), so it survives D8 rebinds with the composer. Metrics are event-driven only (never per-key polling): token counts fold from `assistant/message.usage` **replace-not-accumulate keyed `${turn}:${step}`** (subtract old, add new — replay/resend safe, spec §3.8); model/contextWindow from `request/context`; cwd from `process.cwd()` re-read on bind; git branch read from `<cwd>/.git/HEAD` once per bind/chdir (no watcher — branch changes surface on the next resume/clear); queued badge from live inbox dispatch with a non-negative floor and a hard zero on any non-running transition (spec §3.2). cache% omits the segment entirely before any billed input — never `0%`.
11. **Glyph animation is composer-owned**, a single 50ms `setInterval` running **only while the agent is running** (zero idle CPU), `unref()`'d, driving `requestRender()` (the pi-tui `AltScreenFlashContainer` precedent — closure + unref; `Loader` is unsuitable: it self-starts, never unrefs, and costs 2 rows). Phases from live dispatch: `◌` model wait (step/start seen, no delta yet) → `◍` thinking (reasoning-delta) → `◉` responding (text-delta) → `⚙` tools (tool/call seen, result pending) → `⊙` compacting (live indicator active). Truecolor fade (300ms linear envelope × 1400ms cosine breathing, opacity < 0.12 → skip render) only when the terminal reports truecolor; otherwise envelope-gated steady glyph. Snapshots run non-truecolor and freeze `Date.now`, so goldens see the steady glyph.
12. **Brand truecolor layer**: exactly two surfaces (startup wordmark gradient, `brand` text), teal `#2DD4BF→#14B8A6→#0D9488`, **rgb-fg only**, ANSI fallback stays `36`; `themeViolations()` gains the narrow exemption branch (rgb-fg AND the whole styled run is the brand gradient) per spec §7.1. `/palette` self-prints the paletteSpec table (structure guarantees docs never drift, D6). The spec §4 wording touch-up from T2-carryover item 10 lands in the same task.
13. **Highlight engine scope→role table** (pinned by snapshot; ANSI-16 roles only): `keyword`→`code`, `string`→`success`, `comment`→`dim`, `number`/`literal`→`warning`, `title`/`function`→`accent`, everything else→`text`. Unknown or absent `lang` → whole block in the `code` role (pi-tui's fallback path). The engine is a pure module-level singleton `(code, lang?) => string[]`; input is already `displayText`-escaped by the caller; output must survive `themeViolations()`.
14. **Recorded-replay fixture** = one real talon coding session harvested from `~/.dsh/sessions` (zstd → plaintext `session.jsonl`, committed under `tests/replay/<scenario>/`). The replay harness drives the **decoded event log through the production translate → transcript path onto a HeadlessTerminal**, with hard-reject assertions (exact tool-call sequence, per-turn lifecycle completeness) before the terminal golden. Full in-process cordis assembly with `dsh-llm-replay` is attempted ONLY if this event-level harness cannot satisfy an acceptance line; if the assembly path is required and its binding cannot attach to talon's composition, STOP and surface — do not code around. (`DSH_SNAPSHOT=record|refresh|replay` semantics are honored: record = harvest anew from a live run; refresh = regenerate goldens from the committed fixture; replay = default.)
15. **Block-commit optimization is measurement-gated** (spec L59): the stress task records steady-state frame cost on a tool-heavy 100k-event log; implement the optimization only if the existing perf gate (<10ms/frame steady state) fails without it.
16. **Reasoning stays plain** (dim+italic wrapPlain) in both streaming and settled paths — Markdown rendering applies to `text` blocks only. Ctrl+R toggles reasoning visibility transcript-wide (ephemeral; settled cells recount lines on toggle so the mount cap stays honest).

## Signature crib (verified 2026-08-25 against dsh 0.1.1-rc.1 @ 528c682e06; cite-level facts)

```ts
// ── events (packages/core/session/lib/types/types.d.ts) ──
// envelope { type, seq, time, data, ignorable? }; SurfaceEventType = 'user/message'|'assistant/message'|'tool/result'
// carries sourceEventSeqs? / surfaceOp?; SurfaceOp = 'append' | { op:'replace'; start:number; end:number }
'tool/call':   { turn; step; callId: CallId; name: string; arguments: string /* RAW unparsed JSON */ }   // :291
'tool/result': { turn; step; message: ToolResultMessage; error?: { name: string; code: string }; meta?: JsonValue } // :309
'assistant/message': { turn; step; message: AssistantMessage; usage?: TokenUsage; interrupted?: true }   // :279 (interrupted NEW in rc.1)
'assistant/chunk': { turn; step; chunk: StreamChunk }
// StreamChunk (packages/llm/llm/lib/types/types.d.ts:287-317):
//   block-start{index,blockType} | text-delta{index,text} | reasoning-delta{index,text}
//   | tool-call-delta{index,id,name?,argumentsDelta} | block-end{index,block} | usage{usage: TokenUsage} | finish{reason}
// ContentBlock: text|reasoning|image|tool-call|tool-result (no "declared-reasoning" anywhere)
// TokenUsage { inputTokens; outputTokens; cacheReadTokens?; cacheWriteTokens?; reasoningTokens? } — buckets DISJOINT;
//   billed input = inputTokens + cacheReadTokens + cacheWriteTokens (llm types.d.ts:118-129)
'request/context': { provider: string; model: string; contextWindow?: number }                            // :202-209
'request/header':  { header: { config: { provider; model; reasoningEffort?; … }; system?; tools? }; reason: 'initial'|'resume'|'change' }
'llm/retry': { retryId; turn; step; provider; policyKey; retry: number; delayMs: number; failure: LlmFailure }
//   & ({ mode:'normal'; maxRetries: number } | { mode:'always' })     // llm-retry lib/types/types.d.ts:4-34
'llm/retry-started': { retryId; turn; step; retry: number }                                               // :36-41
// LlmFailure { message; code; status?; providerRetryAfterMs?; requestId? } (llm types.d.ts:26-37)
'compaction/start':   { compactionId; sourceCommandId?; turn: number|null }                                // compaction types.d.ts:20
'compaction/summary': { compactionId; summary: ContentBlock[]; shadowedRange:{start;end}; shadowedSeqs: number[];
                        shadowedTokenCount: number; provider; model; usage?; … }                           // :34-67
'compaction/end':     { compactionId; sourceCommandId?; turn: number|null; error?: string }                // :72-77
'compaction/prune':   { shadowedRange; shadowedSeqs; shadowedTokenCount }                                  // :87-97
// ALL compaction events are log-only. The surface fold is a SEPARATE user/message with surfaceOp {op:'replace'}
// appended synchronously right after (adjacency contractual), whose source is
//   { kind:'plugin', plugin:'compact', compactionId, sourceCommandId? }   (compaction checkpoint.d.ts:22-25)
'agent/inbox/spliced': { target:'next-turn'|'next-step'; start; removedCount?; inserted: UserMessage[]; outcome?: 'canceled' }
// user/message sources: MessageSourceMap user|plugin|model|tool; plugin carries ContextFormed
//   form: 'instructions'|'catalog'|'snapshot'|'notice'{summary}|'relay'|'recall' (llm message.d.ts:71-118)
// TurnEndReason unchanged from T2. NEW event types in rc.1 vs rc.5: team/* only (not composed in base). No renames.

// ── diffs (packages/fs/tool-fs/lib/types/diff.d.ts) ──
interface FileDiff { path: string; oldText: string | null; newText: string }   // one PER HUNK; oldText null = create
const DIFF_CONTEXT = 3
function computeHunkDiffs(path, before, after): FileDiff[]
function diffsFromMeta(meta: unknown): FileDiff[] | undefined                  // replay-safe narrowing of tool/result.meta
// edit presentationMeta → {diffs}; write create → diffs:[] then whole-file fallback from args;
// str_replace_editor: call-time args only (plain-string output, no meta)

// ── tool arg/result shapes the card bodies read (all verified in package src) ──
// bash args { command; description; timeoutMs?; workdir?; run_in_background?; sandbox_permissions?; justification? }
// bash result foreground { kind:'foreground'; exitCode: number|null; signal: string|null; timedOut; aborted;
//   stdout:{text;truncated;spillPath?}; stderr:{text;truncated;spillPath?}; sandbox?{mode;denied;…} } | { kind:'background'; jobId }
// read result { path; offset; lines:[{number,text}]; totalLines }; meta projects { path, offset, lines, totalLines, lang? }
// grep result { matches:[{path,…}] }; glob result { root; paths: string[] }
// write/edit args { file_path; … }; subagent args { description; prompt; run_in_background? }
// todo_write args { todos:[{content; status:'pending'|'in_progress'|'completed'}] }

// ── metrics (packages/llm/token-meter, IS composed in base) ──
// projection keys via session-projection registry: 'tokenUsage' | 'contextPressure' | 'contextBreakdown'
interface TokenUsageProjection { uncachedInputTokens; outputTokens; cacheReadTokens; cacheWriteTokens }
interface ContextPressureProjection { pressureTokens?; projectedTokens?; contextWindow? }
// spec §3.8 formulas: cache% = cacheRead/(uncached+cacheRead+cacheWrite); ctx% prefers measured totalTokens
//   over contextPressure.contextWindow alone (lags after model switch). ctx.tokenMeter is in the spec inject
//   list (§3.1) — the footer task VERIFIES its exact lib/types API before implementing (STOP on mismatch).
// sessionStats projection exists but is composed only in web-app — NOT available here; do not depend on it.

// ── pi-tui 0.84.1 rendering machinery ──
// Markdown(text, paddingX, paddingY /* REQUIRED, pass 0,0 */, theme: MarkdownTheme, defaultStyle?, options?)
//   .setText(t) sole mutator (invalidates); cache key = text+width; rows come back space-padded to full width
// MarkdownTheme { heading,link,linkUrl,code,codeBlock,codeBlockBorder,quote,quoteBorder,hr,listBullet,
//   bold,italic,strikethrough,underline: (s)=>string; highlightCode?: (code, lang?) => string[]; codeBlockIndent? }
//   highlightCode is the ENTIRE highlighting seam: gets the whole fence body, returns pre-split pre-ANSI lines,
//   pi-tui adds indent then wraps (markdown.js:382-403). Without it code renders plain via theme.codeBlock.
// trimPartialClosingFences: module-private, runs inside Markdown.render only — use the component, don't hand-roll.
// marked@18.0.5 is pi-tui's parser (re-exported); NO highlighter anywhere in talon's or the harness's reachable deps
//   (web uses shiki inside React ui-primitives — not a talon dep). highlight.js = net-new dependency.
// Loader: self-starts on construction, interval NOT unref'd, always renders 2 rows — DO NOT use for the footer.
// requestRender(): 16ms floor, coalesced; animation = own timer + mutate state + requestRender()
// getCapabilities(): { images, trueColor, hyperlinks }; hyperlink(text,url) = OSC8 (both barrel exports)

// ── talon internals the tasks extend ──
// CachedCell: width-only cache; renderLines() abstract; every mutator calls dropLines(); pinned by .toBe identity
// Transcript: addChild(component, lines) sole accounting point; lineCountOf() instanceof-dispatch — REGISTER new cells;
//   cell(`${turn}:${step}`) mints the live streaming cell; trim() evicts head + dim marker
// StreamingAssistantCell: blocks Map<index,…>; settle(content) replaces wholesale; uncached while live
// palette: roles text|dim|accent|brand|code|success|warning|error + attrs; displayText escapes C0/C1 except \n;
//   themeViolations() flags rgb/extended/bg per cell — NO exemption branch exists yet (Task 12 adds it)
// checkpoint law: CHECKPOINTS const = observed = snapshots/*.expected.txt (3-leg); themeViolations embedded
// session logs on disk: ~/.dsh/sessions/<projectKey>/<session-id>/session.jsonl[.zstd]; line 0 = header record;
//   delta runs may be PACKED as text-chunks/reasoning-chunks/tool-call-chunks storage rows —
//   decode with decodeStorageRecord from @deepseek-ai/dsh-session (llm-replay/src/index.ts:13 precedent)
```

---

### Task 1: Highlight engine — highlight.js → ANSI-16 singleton

**Files:** Create `src/theme/highlight.ts`, `tests/highlight.spec.ts`. Modify `package.json` (add `highlight.js`).

**Interfaces:** `highlightToAnsi(code: string, lang: string | undefined, palette: Palette): string[]` — module-level singleton engine (one hljs instance), pure and deterministic. Maps hljs scopes per Ruling 13; unknown/absent lang → every line through `palette.code`. Input arrives already `displayText`-escaped; output lines carry ONLY palette-role SGR (ANSI-16).

- [ ] Step 1: `pnpm add highlight.js` (pick current major; pin exact in package.json like other deps).
- [ ] Step 2 (failing tests first): a TypeScript snippet asserting keyword/string/comment/number/title land in their Ruling-13 roles (assert on the SGR opens from `paletteSpec`, not raw literals); unknown lang falls back to `code` role on every line; `NO_COLOR`-style disabled palette returns the input verbatim (identity roles); output joined contains no `38;2`/`48;`/extended-color sequences (property test over a corpus of fence bodies incl. hostile `\x1b` fragments — engine must not un-escape); multi-line input maps 1:1 to output lines.
- [ ] Step 3: implement. hljs `highlight(code, {language})` when the lang is registered, `.emitter`/token walk or the HTML-free `TokenTree` API — whichever hljs exposes for scope runs without HTML (verify at execution; if only HTML output is available, parse the emitted spans defensively — but prefer the token API). Compose role fns from the passed palette; never construct SGR literals here.
- [ ] Step 4: full gate. Commit: `feat: highlight.js→ANSI-16 singleton engine (T3 spec §8, ruling 13)`

### Task 2: Markdown theme + settled assistant Markdown

**Files:** Create `src/theme/markdown-theme.ts`. Modify `src/ui/transcript/streaming.ts`, `tests/streaming.spec.ts`, `tests/cells.spec.ts` (identity pins), `tests/app.snapshot.ts` + checkpoint `md-settled`.

**Interfaces:** `markdownTheme(palette: Palette): MarkdownTheme` — role-mapped theme (`code`→palette.code, `bold`→palette.bold, quote → dim italic, `link` → underline+accent, `linkUrl` → dim, hr/listBullet/codeBlockBorder → dim, headings via heading→bold) with `highlightCode: (code, lang) => highlightToAnsi(code, lang, palette)`. `StreamingAssistantCell.settle()` now builds ONE pi-tui `Markdown(joinedTextBlocks, 0, 0, theme)` child per settled cell (reasoning blocks stay plain dim+italic, Ruling 16); `renderLines(width)` delegates text-block rows to `md.render(width)` (construction happened at settle — §5.1 holds; the Markdown component's own text+width cache preserves row identity).

- [ ] Step 1 (failing): settle with markdown source (`# h`, fenced ts code, list, `**bold**`) → rendered rows show heading bold+underline, highlighted fence (role SGRs), bullet rows; `.toBe` identity pin across repeated same-width renders after settle; `contentLineCount` law unchanged (logical source lines — assert the mount-cap count did not become width-dependent); hostile control chars in markdown text render escaped (displayText before parse).
- [ ] Step 2: implement; `displayText` the source before `setText` (D7.8 order).
- [ ] Step 3: new checkpoint `md-settled` (declare in CHECKPOINTS + OWNED + golden). Full gate. Commit: `feat: settled assistant messages render Markdown with highlighted fences (D11/spec §4)`

### Task 3: Streaming Markdown live path

**Files:** Modify `src/ui/transcript/streaming.ts`, `tests/streaming.spec.ts`, `tests/app.snapshot.ts` + checkpoint `md-stream`.

Live path per D11: on every text-delta, `setText(accumulatedTextBlocks)` on the SAME live Markdown child and rebuild rows (no throttle; uncached while live — pi-tui's fence-trim keeps unclosed fences stable). Reasoning deltas stay on the plain path. Settle keeps Task 2's wholesale replacement (never trust the accumulation buffer, §5.3).

- [ ] Step 1 (failing): drive deltas that открывают a fence without closing it → no `─`-flicker rows, fence body renders highlighted-as-partial (assert stable row count between two consecutive deltas inside a fence — the trimPartialClosingFences behavior); settle replaces with authoritative content.
- [ ] Step 2: implement; keep the `lines` accounting incremental (mount cap).
- [ ] Step 3: checkpoint `md-stream` (mid-stream frame, frozen). Full gate. Commit: `feat: live Markdown streaming — per-chunk rebuild on the verified D11 baseline`

### Task 4: Ctrl+R reasoning visibility toggle

**Files:** Modify `src/app/controller.ts`, `src/ui/transcript/{transcript,streaming}.ts`, tests.

Global key Ctrl+R (spec §6; suspended while a panel is active) flips a transcript-wide `showReasoning` flag: streaming/settled cells re-derive rows without reasoning blocks (mutator invalidates cache + recounts lines through the accounting so the mount cap stays honest — recount = subtract old count, add new). Ephemeral (§3.10). Default ON (current behavior).

- [ ] Step 1 (failing): toggle hides reasoning rows in settled + live cells, mountedLines drops accordingly, second toggle restores; Ctrl+R while a panel is active does nothing; `.toBe` pins break/restore correctly across toggles (new cache after mutation, stable within a state).
- [ ] Step 2: implement (transcript owns the flag; cells take it as a mutator, not a render arg).
- [ ] Step 3: full gate. Commit: `feat: Ctrl+R reasoning visibility toggle (spec §6, ephemeral per §3.10)`

### Task 5: Tool events into the contract layer + ToolCardCell core

**Files:** Modify `src/backend/app-events.ts`, `src/backend/translate.ts`, `src/ui/transcript/transcript.ts`. Create `src/ui/transcript/tool-cards.ts` (ToolCardCell + registry + shared machinery). Tests: `tests/translate.spec.ts`, `tests/tool-cards.spec.ts`.

**Interfaces:**
- AppEvent additions: `{ kind:'tool-call-card'; turn; step; callId; name; args: unknown /* parsed or undefined */; rawArguments: string }` (replaces the T2 `tool-call` event — the controller's approval-preview consumer migrates to it) and `{ kind:'tool-result-card'; callId; isError: boolean; errorCode?: string; resultText: string; meta: unknown }`.
- `classifyTool(name): 'terminal'|'diff'|'read'|'search'|'web'|'generic'|'unregistered'` per Ruling 1 (exported table).
- `ToolCardCell` (in `tool-cards.ts`): constructed on call (pending: `◇ <name> · <key-arg>` warning head, dim `└ running…` body), `settle(result)` mutates in place (head `◆` + success/error tone; body from the class builder), uncached while pending, width-cached after settle; `preview()` single fold rule: ≤6 lines head/tail with a dim `… N more lines …` middle marker; failure forces expanded (Ruling 4/5). Registered in `Transcript.lineCountOf`. Header format `◇/◆ <name> · <关键参数>` — name deliberately NOT bold (spec §4.2); every row truncated/wrapped; all body text dim; displayText everywhere.
- Transcript: `Map<callId, ToolCardCell>`; `tool-call-card` appends + registers; `tool-result-card` settles the matching cell (unknown callId → append a settled orphan card — the log is the truth); `turn/end` drops pending refs.

- [ ] Step 1 (failing): translate table tests for both events (raw JSON args parse, malformed args → `args: undefined` + raw kept; result error/meta passthrough; resultText flattening: text blocks verbatim joined, non-text pretty-printed, empty+error → `<name>: <code>`); ToolCardCell pending→settle lifecycle, tone law (pending warning / ok success / fail error head; body all dim), preview fold at >6 lines, failure ignores fold, `.toBe` pins post-settle, orphan result, pending-at-turn-end stays `◇`.
- [ ] Step 2: implement; migrate the controller's `pendingCalls` consumer to `tool-call-card` (approval preview keeps working — pin with the existing approval tests).
- [ ] Step 3: full gate (redraw.spec must stay zero — cards append/mutate at the tail only). Commit: `feat: tool events land — ToolCardCell core, registry, pending→settle lifecycle (D12 groundwork)`

### Task 6: terminal card (bash/pwsh)

**Files:** `src/ui/transcript/tool-cards.ts` (+builder), tests, checkpoint `card-terminal`.

Body per spec §4.2: `$ <command>` + cwd prefix line (workdir arg or bound cwd; `~`-abbreviate home), the bash `description` on the head line, dim stdout/stderr preview (stdout first; stderr appended when non-empty), structured tail badge `[exit N]` / `[signal S]` (badge tone follows failure: non-zero exit or signal → error head even though `tool/result.error` is absent — the web's `terminalFailed` precedent); background result renders `└ background job <jobId>`; `truncated: true` or `spillPath` append a dim `output truncated` note.

**Crib delta, re-verified 2026-08-28 against the same checkout (528c682e06) per the rc-drift law:** the crib's structured bash result (`{kind:'foreground'; exitCode; signal; stdout:{text,truncated,spillPath}; …}`) is the tool's **execution-local `value`**, which `dsh-tools` documents as "deliberately omitted from durable events" (core/tools/src/index.ts:558) — and `tool-bash` defines **no `output.presentationMeta`**, so `tool/result.meta` is `undefined` for bash/pwsh. The durable terminal facts are therefore exactly two: the call `arguments` and the rendered result text from `renderResult` (tool-bash/src/render.ts). dsh states this itself: "Replay only retains the rendered content text, not the original `ShellRunResult`, so terminal presentation must recover the exit pill here" (shell/shell/src/render.ts:29-31). The card consequently recovers the badge from the **marker contract**, mirroring `parseExitStatus`'s anchored regexes (`\n[killed by signal: X]$` → signal, `\n[exit code: N]$` → exit, else clean) rather than reading structured fields; the truncation and sandbox-denial notes already sit **inside** the rendered body, so the card passes them through instead of appending its own (rendering them twice is exactly what the marker contract forbids). No new dependency is taken for six lines of regex.

- [x] Steps: failing tests (foreground ok / non-zero exit flips tone / signal / background / truncated / sandbox-denied row) → implement → checkpoint `card-terminal` → gate. Commit: `feat: terminal card — command, cwd, exit/signal badge, spill note (D12 terminal)`

### Task 7: diff card + shared diff renderer

**Files:** Create `src/ui/transcript/diff-render.ts`. Modify `tool-cards.ts`, tests, checkpoint `card-diff`.

`renderFileDiffs(diffs: FileDiff[], palette): string[]` — per-file bold path header (suppressed when single file AND the card head already carries the path); line-number column via dual counters walking a line diff of oldText/newText (dim, right-aligned); `+` success / `−` error / context dim, two-space indent; per-hunk input is already contextual (`FileDiff` is one hunk, DIFF_CONTEXT=3); beyond `maxDiffEditLength=1000` changed lines render the whole side approximate + `[exact line diff omitted: >N changed lines]`; summary `└ +a −r · n file(s)[ · approximate]`. Result cached by diffs-array object identity (Ruling/spec §4.2). Diff source: `diffsFromMeta(meta)` on result; write-create fallback whole-file from args; `str_replace_editor` builds call-time diffs from args (view/create/str_replace forms). Line diffing: hand-rolled LCS over hunk lines is acceptable at hunk scale — no new dependency; approximate path avoids Myers blowup (D7.6).

**Crib delta, verified 2026-08-28:** `meta = { diffs: FileDiff[] }` holds as written, but a `FileDiff` carries **no file offset** — `computeHunkDiffs` maps structuredPatch's hunks to `{path, oldText, newText}` and drops `oldStart`/`newStart` (tool-fs/src/diff.ts), and `edit`/`write` re-map the same three keys into `presentationMeta`. The dual counters are therefore **hunk-relative**: they number the rows a reader can see, not the file. Nothing else in the durable log recovers the offset, so this is the ceiling of the contract, not an implementation shortcut; a future absolute column needs `computeHunkDiffs` to persist the starts. Line diffing is a hand-rolled LCS as planned. The identity cache keys the FINAL lines (spec §4.2's wording) on the diffs array, with the palette and head path riding along because they change what the same hunks render as.

- [x] Steps: failing tests (edit hunk with line numbers both sides correct; create (oldText null) renders all `+` with numbers; multi-file summary; >1000 approximate; suppression rule; identity cache pin) → implement → checkpoint `card-diff` → gate. Commit: `feat: diff card — line-number column, hunk rendering, approximate guard (D12 diff)`

### Task 8: read + search cards

**Files:** `tool-cards.ts` builders, tests, checkpoints `card-read`, `card-search`.

read: head `<path>:<offset>`; body = line-number column source excerpt from `meta.lines` (≤6 fold), `meta.lang` feeds `highlightToAnsi`; `└ <totalLines> lines` tail. `read_image`: generic-ish single line (`image · <path>`) — no pixels in a terminal card (T4 owns images). search: grep groups matches by `path` — `path` line then indented `  L42: match text` rows; glob (`paths` shape) lists paths; `truncated/total` footnote when the result reports truncation.

**Crib delta, verified 2026-08-28:** `read`'s meta matches the crib (`{path, offset, lines:[{number,text}], totalLines, lang?}` — the numbers are the file's own, so no offset math is needed: the column prints `line.number`). The SEARCH crib (`grep result {matches:[{path,…}]}`, `glob result {root; paths}`) is again the execution-local `value`; the durable meta is the `SearchMeta` projection (fs-search/src/presentation.ts): `{shape:'matches', files:[{path, matches:[{lineNumber,line}]}], truncated, total}` and `{shape:'paths', paths, truncated, total}`, each carrying the **pre-cap** `total`, which the card's tail reports so a capped search never reads as complete. `read_image` publishes no meta at all, so rather than inventing an `image · <path>` line that would only repeat the head, it falls through to the model-facing text — the no-pixels rule holds either way, with no special case.

- [x] Steps: failing tests (offset math in the number column; lang-highlighted excerpt stays ANSI-16; grouping; glob; fold) → implement → checkpoints → gate. Commit: `feat: read + search cards — numbered excerpts with highlight, grouped matches (D12)`

### Task 9: web + generic cards

**Files:** `tool-cards.ts` builders, tests, checkpoint `card-generic` (+ web rows inside it).

web: `web_search` → source list rows `title` + dim url (OSC8 via pi-tui `hyperlink` when `getCapabilities().hyperlinks`, plain otherwise — snapshots run plain); `web_fetch` (not composed today, render anyway) → single `url · HTTP <status>` line. generic: head `◇/◆ <name> · <first-string-arg>`; body = result content through the shared Markdown theme then truncated by VISIBLE lines (truncate rendered rows, not source lines — old fix, spec §4.2); raw `arguments` stay literal (dim, fenced) when expanded.

**Two deviations, both recorded rather than coded around:**
1. **No OSC 8 links in T3.** pi-tui's `getCapabilities()` derives hyperlink support from the process ENVIRONMENT (`TERM_PROGRAM`, `KITTY_WINDOW_ID`, `TMUX`, … — terminal-image.js:34-89) and memoizes it, so the plan's "snapshots run plain" does not hold: a suite run from iTerm, VS Code or Ghostty would emit OSC 8 into the committed golden and CI would disagree with the developer's machine. talon has no capability seam to inject the answer through, and inventing one for two rows is not warranted — links wait for the capability seam **T4** introduces alongside images. The url renders as plain dim text meanwhile, which is the same fallback pi-tui itself takes on an unidentified terminal.
2. **Raw `arguments` when expanded is Task 11's**, not this task's: there is no expanded mode until Ctrl+O exists, so the literal-args row lands with the mode that reveals it.

The `markdown` body seam is what makes visible-line truncation real: the builder returns PROSE, the cell builds one `Markdown` at settle (§5.1) and folds the rows it renders at width, while `contentLineCount()` keeps counting SOURCE lines — the same width-free law `StreamingAssistantCell` follows.

- [x] Steps: failing tests (search list; fetch line; generic markdown body visible-line truncation with a fence spanning the cut; args literal; ask_user_question/todo_write/subagent land generic per Ruling 1) → implement → checkpoint → gate. Commit: `feat: web + generic cards — sources with links, Markdown bodies truncated by visible lines (D12)`

### Task 10: unregistered-tool XML fallback (D13)

**Files:** Create `src/ui/transcript/unknown-xml.ts`. Modify `package.json` (add `saxes`), `tool-cards.ts`, tests.

`renderUnknownXml(text): string[] | undefined` — saxes strict parse into an indented element tree (dim tags, text content per displayText); **explicit refusal** on malformed input (the 11 malformed classes reduce to: parser error → `undefined` → caller falls back to plain dim text). Injected-context wrappers are NEVER XML-parsed — that path was settled in T2 (ContextCard) and stays upstream of cards.

**Verified at execution:** saxes neutralizes hostile controls on the *refusal* route, not the escaping one — a raw ESC is not a legal XML character ("disallowed character") and `&#27;` is not a legal character reference ("malformed character entity"), so both classes are refused outright and reach the screen through the plain fallback, which `displayText`-escapes. Only controls XML actually permits (TAB, CR) survive the parser, and `displayText` catches those. Both routes are pinned. `fragment: true` accepts multi-root tool output; zero elements is itself a refusal, so ordinary text output stays plain rather than rendering as an empty "tree". Indentation caps at 8 levels: a hostile document nests arbitrarily deep and rows indented past the width are unreadable either way. Closing tags are dropped — indentation carries the structure and talon's visual language is zero decoration.

- [x] Steps: failing tests (well-formed tree; malformed → undefined; hostile entities/control chars neutralized; unregistered tool name routes here) → implement → gate. Commit: `feat: unregistered-tool XML tree fallback via saxes, refusal-to-plain (D13)`

### Task 11: Ctrl+O tri-state visibility cycling

**Files:** Modify `src/app/controller.ts`, `src/ui/transcript/{transcript,tool-cards,cells,streaming}.ts`, tests, checkpoint `cards-collapsed-hidden` (three-frame sequence golden or three checkpoints — decide by snapshot ergonomics at execution, keep the closed manifest law).

Global Ctrl+O cycles collapsed → expanded → hidden transcript-wide (spec §4.2): collapsed = head + `preview()` fold (the default); expanded = full body; hidden = card vanishes; in hidden mode a multi-step turn folds to a single Assistant header and a tool-only step renders zero output (old-TUI fold fix); failed cards render expanded in ALL modes; ContextCardCell joins (hidden ⇒ gone; expanded ⇒ its body lines — T2 promise). Mount-cap recount on every mode change (subtract/add per cell). Panel-active suspends the key. Ephemeral.

**Two things execution forced into the open:**
1. **The spacer had to become a cell.** Hidden mode removes cards, and a pi-tui `Spacer(1)` between two now-invisible cells still renders its blank row — a screen of hidden cards would have been a screen of blank rows. `SpacerCell` replaces it: mounted always (a later reflow can bring it back), rendered only BETWEEN two visible cells. The transcript owns the pairing in one ordered `reflow()` pass, which also does the hidden-mode header fold and the mount-cap recount — all three depend on what the cells around each cell now show.
2. **A transcript-wide visibility change over a SCROLLED transcript costs exactly one full redraw, and that is physically unavoidable.** Hiding cards rewrites rows that already live in the terminal's SCROLLBACK; pi-tui repaints in full whenever `firstChanged < viewportTop` (tui-main-screen.js:347), and no differential write can reach scrollback anyway. Verified: while the transcript FITS the viewport the whole Ctrl+O cycle costs zero wipes, and growth past the viewport also costs zero — only the shrink-from-scrolled does. `tests/redraw.spec.ts` therefore keeps its zero-wipe gate over the append-shaped flow (a full Ctrl+O cycle now included) and adds a second test pinning the scrolled shrink at exactly ONE redraw, so a regression that wipes per frame — or that starts wiping on plain appends — still fails. **Ctrl+R (Task 4) has always shared this property**; the gate simply never exercised it with an overflowing transcript.

Two checkpoints rather than one three-frame golden (`cards-expanded`, `cards-hidden`): the same driving events feed both, so the pair reads as one Ctrl+O sequence while each frame stays a plain closed-manifest golden.

- [x] Steps: failing tests (cycle order; per-mode line counts through mountedLines; failed card immune; hidden-mode turn folding incl. tool-only step; ContextCard expansion; panel suspension; cap recount) → implement (transcript-owned mode; cells expose `setVisibility(mode)` mutators) → checkpoint(s) → gate. Commit: `feat: Ctrl+O tri-state card visibility with hidden-mode turn folding (spec §4.2)`

### Task 12: paletteSpec+ — brand truecolor, themeViolations exemption, /palette

**Files:** Modify `src/theme/palette.ts`, `src/testing/headless-terminal.ts`, `src/backend/commands.ts`, `docs/specs/2026-08-13-talon-ui-design.md` (carryover-10 wording), tests, checkpoint `palette-table`.

Brand gradient helper `brandGradient(text): string` — per-char rgb-fg interpolation over the three teal stops, emitted ONLY when truecolor capability, fallback `palette.brand` (ANSI 36); applied to the wordmark surface (wherever `brand` renders today — verify at execution; if no wordmark surface exists yet, the gradient lands on the `/palette` header line as the brand text surface). `themeViolations()` exemption: a styled run is exempt iff every violation in it is rgb-fg AND the run's rgb sequence set ⊆ the brand-stop interpolation set (implement as: rgb-fg violations whose colors all lie on the teal gradient are dropped; anything else still flags). `/palette` command prints the live paletteSpec table (role, open, close, purpose — dim-aligned columns) as durable command output (Ruling 5 from T2: render from command/done via `sourceEventSeq`? — `/palette`'s output is deterministic; simplest compliant form: `recordInput` default, result `{kind:'success', text: <table>}` rendered by the existing command-done path).

**Three execution findings:**
1. **Truecolor became a palette field, not a render-time probe.** `getCapabilities()` derives truecolor from the process environment and memoizes it, so probing at render time would put the developer's terminal into every committed golden. `createPalette(enabled, scheme, trueColor)` carries the answer, read ONCE at boot. Task 15's glyph fade consumes the same field.
2. **`/palette` prints PLAIN text, and that is the correct outcome, not a shortfall.** Command output travels the same durable notice path every plugin's output travels, and that path `displayText`-escapes before styling (D7.8). Carving an ANSI exception for one command is precisely the hole D7.8 exists to close. The table is generated FROM `paletteSpec` — which is what D6 asks for ("结构上保证文档永不漂移") — and the SGR codes are IN the table, so it documents the colours exactly.
3. **The gradient therefore has no live surface yet.** D6 names two: the startup wordmark and `brand` text. talon has neither — `brand` is referenced by no rendering path, and no T1–T3 task creates a wordmark. The layer ships tested (gradient, both fallbacks, the exact-membership gate) and the first surface to want it picks it up. **The exemption is per-CELL rather than per-run**: an rgb foreground on the ramp is exempt, every other rgb foreground and EVERY rgb background still violates — same narrowness, no run-tracking.
4. **Carryover 10 needed no edit**: spec §4's table already reads "truecolor 仅限两处品牌例外:wordmark 渐变与 `brand` 文本;ANSI `accent` role 依 D6 保持 95" — the wording the carryover asked for is already there.

- [x] Steps: failing tests (gradient rgb-fg only + fallback; exemption narrowness — a stray rgb-fg NOT on the gradient still violates; /palette table content pins the spec table; spec wording diff) → implement → checkpoint `palette-table` → gate. Commit: `feat: brand truecolor layer + narrow snapshot exemption + /palette (D6, spec §7.1, carryover 10)`

### Task 13: compaction visualization

**Files:** Modify `src/backend/translate.ts`, `src/backend/app-events.ts`, `src/ui/transcript/{transcript,cells}.ts`, `src/app/controller.ts`, tests, checkpoint `compaction-marker`.

Translate: compact-checkpoint `user/message` (Ruling 6) → `{ kind:'compaction-marker' }` → permanent dim cell `… earlier context was compacted …` (byte-identical live/replay; shadowed history stays above — position bookmark). `compaction/start|end` → `{ kind:'compaction-live'; phase:'start'|'end' }` consumed ONLY by the controller's live path (bindAgent replay loop filters it out — Ruling 7): while active, composer shows `Context being compacted Xs` (hint-line flash territory; restored by the next status sync) and the glyph phase becomes `⊙` (Task 15 consumes the same state). `compaction/summary`/`prune` render nothing (v1 — the marker is the visualization; the web's fold UI is explicitly not talon's shape).

**Verified:** ruling 6's source shape is exact — `compaction/src/checkpoint.ts:19` freezes `{ kind: 'plugin', plugin: 'compact' }` as the marker every backend stamps on its replacement message. The marker reuses `NoticeCell` rather than adding a class: a permanent dim line IS a notice, `lineCountOf` already counts it, and Ctrl+O correctly leaves it alone (a bookmark is not a card). Ruling 7 holds **by construction**: the live indicator is set only inside the `session/event` listener, and `bindAgent`'s replay loop calls `transcript.apply` directly without passing through it — so an orphan `compaction/start` in history cannot light it, which the rebind test pins. Elapsed seconds advance off the events that keep arriving during a compaction (summary/prune), so the indicator needs no timer of its own; Task 15's glyph timer will refresh it more finely.

- [x] Steps: failing tests (checkpoint-source detection incl. NOT context-card; marker cell identity + wording; live indicator appears/disappears on start/end and NEVER from a replayed orphan start; elapsed uses frozen Date.now) → implement → checkpoint `compaction-marker` → gate. Commit: `feat: compaction marker + live indicator, live-driven only (spec §4.1)`

### Task 14: retry visualization + interrupted settle

**Files:** Modify `src/backend/{translate,app-events}.ts`, `src/ui/transcript/transcript.ts` (withdraw API), tests.

`llm/retry` → `{ kind:'retry-notice'; turn; step; retry; limit: number|'∞'; delayMs; message }`: transcript withdraws the live streaming cell for `${turn}:${step}` (subtract its lines from the cap; the cell had settled nothing) and appends the warning notice `Retrying model request (n/limit) in Xms: <msg>`. `llm/retry-started` → `[]`. `assistant/message.interrupted` → normal settle (Ruling 9; pin with a test).

**Verified:** the `llm/retry` union is exactly as cribbed (`mode: 'normal'` carries `maxRetries`, `mode: 'always'` carries none). `withdraw` takes the partial cell's **preceding spacer** with it — otherwise the withdrawal leaves a blank gap exactly where the text used to be — and clears the hidden-mode header owner, so the recovered step still prints its header. A SETTLED cell is never withdrawn: that content is real. `llm/retry-started` needs no case at all; translate's skip-safe default already answers `[]`, and a test pins it. Ruling 9 needed no code — `interrupted` was already ignored, so an interrupted prefix settles like any other message; a test now pins that it stays that way.

- [x] Steps: failing tests (withdraw removes rows + fixes accounting; notice format incl. ∞ arm; retry after partial stream then successful re-stream renders exactly one final message; interrupted settle) → implement → gate. Commit: `feat: retry withdraws the failed stream + warning notice; interrupted prefix settles plain (spec §4.1, rc.1)`

### Task 15: footer metrics line + prompt-glyph animation

**Files:** Create `src/ui/composer/footer.ts`, `src/backend/metrics.ts`. Modify `src/app/controller.ts`, `src/ui/composer/composer.ts`, tests (`tests/footer.spec.ts`, `tests/metrics.spec.ts`), checkpoint `footer-metrics`.

`metrics.ts`: fold `assistant/message.usage` replace-not-accumulate keyed `${turn}:${step}` (forward-scan accumulator law §5.2 — one cursor, replay-equivalent); `request/context` → model + contextWindow; expose `{ cachePercent?: number; contextPercent?: number; model?: string }`. **Step 0 of this task verifies `ctx.tokenMeter`'s lib/types API** (spec §3.1 inject list) — prefer meter-measured totals for ctx% per §3.8; if the API disagrees with the spec's sketch, STOP and record the delta here before coding. Footer component (4th composer child): left `${cwd}${git}${model}${cache}${context}` / right `${queued}`, absent values vanish with their separator, narrow width truncates left first; queued from live inbox dispatch (verify live event names at execution — durable log shows `agent/inbox/spliced`; floor 0, hard-clear on non-running). Glyph animation per Ruling 11 (phases from live dispatch; 50ms active-only unref'd timer; envelope math; non-truecolor steady). The `❯` prompt surface: verify where the prompt glyph renders today; if the composer has no `❯`, this task adds it to the state-rule/prompt row per spec §4.3 sketch.

**Step 0 answer (`ctx.tokenMeter`, verified 2026-08-28): the API matches the crib — nothing to STOP on — but talon does NOT inject it, and should not.** The projections are exactly as cribbed (`tokenUsage` → the four disjoint buckets; `contextPressure` → `{projectedTokens?, pressureTokens?, contextWindow?}`), and `TokenMeter.measure(session)` returns `{ totalTokens, surfaceTokens, baseline, … }`. But `ctx.tokenMeter` is absent from talon's `inject` list, `measure()` is documented O(surface) per call, and the plan's own design already folds the numbers from durable events — which IS the spec's §5.2 forward-scan accumulator, replay-equivalent by construction and O(1) per event. §3.8's preference for measured totals is a warning about reading the WINDOW off `contextPressure` (stale after a model switch); talon reads it from `request/context` directly, so that staleness cannot arise. Recorded rather than coded around: no new injected service.

**Three more things execution settled:**
1. **The `❯` prompt did not exist**, so this task added it: `FramelessEditor` lays the editor out two columns narrower and shifts every row right by that much, which puts the prompt ON the input line and moves pi-tui's positional cursor marker with it (the goldens now read `cursor … @row,2`).
2. **A frozen clock renders the fade's first, deliberately-blank instant forever.** Two consequences: the fade is skipped entirely when no timer is running (a static frame has no transition to smooth, and must show its glyph), and the glyph tests advance a mock clock between the event and the paint — which is what really happens in a terminal.
3. **Every checkpoint now freezes `process.cwd()`**, because the footer prints the workspace and reads the branch out of its `.git/HEAD`; without it the goldens embedded the developer's own path and branch. The redraw gate's viewport grew to 20 rows for the row the footer costs — its in-viewport phase must stay in-viewport, since the scrolled shrink has its own dedicated test.

- [x] Steps: failing tests (accumulator replace law incl. resend; cache% omitted before billed input; ctx%; separator collapse; narrow truncation; queued floor/clear; timer starts/stops with status — zero timers while idle; fake-timer phase transitions; steady glyph under non-truecolor) → implement → checkpoint `footer-metrics` (frozen, idle-with-metrics frame) → gate. Commit: `feat: footer metrics + prompt-glyph animation — event-driven, zero idle CPU (spec §3.8/§4.3)`

### Task 16: recorded real-session replay acceptance

**Files:** Create `tests/replay/<scenario>/session.jsonl`, `tests/replay/replay.spec.ts`, `tests/helpers/session-log.ts` (jsonl decode incl. packed chunk rows via `decodeStorageRecord`), checkpoint-style golden `tests/replay/<scenario>/terminal.expected.txt`. Modify `docs/INSTALL.md` (one paragraph: how to re-record).

Record (manual, once, at execution): run a real `pnpm dsh --profile talon` session performing a small coding task in a scratch dir (a read → an edit → a bash test run → a reply — touches terminal/diff/read cards + markdown); harvest `~/.dsh/sessions/<key>/<id>/session.jsonl.zstd`, decompress, commit plaintext. Replay: decode the log, feed every event through production `translateSessionEvent` → `Transcript.apply` onto a controller-mounted HeadlessTerminal (the bindAgent replay path, driven as a fixture); **hard-reject assertions before the golden**: exact ordered tool-call name sequence from the fixture, every turn reaches turn/end, every tool/call has its result or the turn ended, zero scrollback wipes, themeViolations empty; then the terminal golden. `DSH_SNAPSHOT=refresh` regenerates the golden; `record` documents the manual harvest. (Full cordis assembly with dsh-llm-replay: only if this cannot satisfy acceptance — Ruling 14; STOP on binding failure.)

- [ ] Steps: helper + failing replay spec against a committed fixture → record the real session → assertions green → gate. Commit: `test: recorded real-session replay acceptance — hard-reject + terminal golden (spec §7.3, T3 DoD)`

### Task 17: adversarial untrusted-controls snapshots + stress measurement

**Files:** `tests/adversarial.snapshot.ts` (+ checkpoint `untrusted-controls`), `tests/perf.spec.ts` extension.

Hostile corpus (C0/C1, ESC sequences, fake OSC8, RTL overrides, oversized lines, malformed XML, markdown bombs) through EVERY T3 surface: card head args, terminal output, diff paths+content, read excerpts, search matches, web titles/urls, generic markdown, retry message, compaction summary path, footer strings. Assert: displayText neutralization everywhere, zero theme violations, zero wipes, no row overflow crash. Stress: extend the perf spec with a tool-heavy 100k-event log (cards + markdown); record steady-state frame cost in the test output; if >10ms, THEN implement the block-commit optimization (Ruling 15) as a follow-up commit inside this task and re-measure.

- [ ] Steps: corpus + failing-if-unescaped assertions → fixes if any surface leaks → stress numbers recorded → gate. Commit: `test: untrusted-controls adversarial snapshots + tool-heavy stress gate (D7.8, spec §8 T3)`

---

## Acceptance mapping (spec §8 T3 row)

| Acceptance line | Where proven |
|---|---|
| 真实编码会话录制回放全绿 | Task 16 (hard-reject + golden over a real recorded session) |
| 所有卡片类型有快照 | Tasks 6–10 checkpoints (`card-terminal/diff/read/search/generic` + web rows) + Task 11 tri-state |
| untrusted-controls 对抗快照绿 | Task 17 (+ D7.8 law embedded in every earlier task's tests) |
| Markdown 流式+语法高亮 | Tasks 1–3 (+ `md-stream`/`md-settled` checkpoints) |
| 六类工具卡(D12) | Tasks 5–10 |
| diff 行号 | Task 7 |
| paletteSpec+/palette | Task 12 |
| footer 指标+glyph 动画 | Task 15 |
| 压缩/重试可视化 | Tasks 13–14 |

## Execution notes

- Branch: `feat/t3-rendering` off `main`; merge locally back to `main` when every task + the acceptance run is green (the T2 finishing precedent).
- Order is dependency order: 1→2→3 (engine → settled → live); 5 before 6–11; 12 independent after 1; 13–14 after 5 (translate structure); 15 after 13 (⊙ phase reads the live-compaction state); 16–17 last.
- `../deepseek-harness` must be built (`pnpm run build:lib:host`) and is read-only; re-verify any crib signature that a task touches against the CURRENT checkout before implementing (rc drift law).
- After any src change intended for live smoke: `pnpm build` (profile is `link:`).
- New checkpoints follow the three-leg closed-manifest law; every new cell class registers in `Transcript.lineCountOf`.
