/** Tool cards (spec §4.2, D12): one cell per tool call, opened by `tool/call`
 * and settled in place by `tool/result` — the StreamingAssistantCell precedent
 * (uncached while pending, width-cached once settled).
 *
 * ONE class owns the shared machinery — header, tone law, the collapsed fold,
 * the cache law, mount-cap accounting — and each card class contributes only a
 * PURE body builder (T3 ruling 4), so the laws below cannot drift per class:
 *   - the tool name is deliberately NOT bold (spec §4.2: SGR-1 reads as a
 *     color change on some terminals); the whole head wears one tone;
 *   - every untrusted string passes displayText() BEFORE styling (D7.8);
 *   - the head is one row (truncated), every body row is wrapped — no rendered
 *     row may exceed the terminal width or TuiMainScreen crashes;
 *   - a failure shows its whole body; only successes fold. */
import { homedir } from 'node:os'
import { Markdown, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'
import { wrapPlain } from './cells.js'
import { highlightToAnsi } from '../../theme/highlight.js'
import { markdownTheme } from '../../theme/markdown-theme.js'
import { diffsFromMeta, renderFileDiffs, type FileDiff } from './diff-render.js'
import { renderUnknownXml } from './unknown-xml.js'

export type ToolCardClass = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'generic'

/** Ctrl+O's transcript-wide cycle (spec §4.2). Ephemeral UI state: never
 * persisted, never logged (§3.10). A FAILED card ignores it entirely — a
 * failure shows its whole body in every mode. */
export type CardVisibility = 'collapsed' | 'expanded' | 'hidden'

/** The name-keyed card registry (T3 ruling 1), from the verified dsh-base +
 * talon tool composition. Anything absent takes the unregistered path. */
export const TOOL_CARD_CLASSES: Record<string, ToolCardClass> = {
  bash: 'terminal', pwsh: 'terminal',
  edit: 'diff', write: 'diff', str_replace_editor: 'diff',
  read: 'read', read_image: 'read',
  grep: 'search', glob: 'search',
  web_search: 'web', web_fetch: 'web',
  todo_write: 'generic', skill: 'generic', subagent: 'generic', subagent_fork: 'generic',
  report: 'generic', workflow: 'generic', ralph: 'generic', job_output: 'generic',
  job_list: 'generic', job_kill: 'generic', get_goal: 'generic', create_goal: 'generic',
  update_goal: 'generic', list_agents: 'generic', send_message: 'generic',
  interrupt_agent: 'generic', exit_plan_mode: 'generic', ask_user_question: 'generic',
}

export function classifyTool(name: string): ToolCardClass | 'unregistered' {
  return TOOL_CARD_CLASSES[name] ?? 'unregistered'
}

/** What the call half of a card knows. `args` is the parsed arguments object
 * (undefined when the model's JSON did not parse); `rawArguments` is always the
 * verbatim string an expanded card can show. */
export interface ToolCall { callId: string; name: string; args: unknown; rawArguments: string }
/** What the result half of a card knows (translate.ts flattens it). */
export interface ToolResult { isError: boolean; errorCode: string | undefined; resultText: string; meta: unknown }

/** What a class puts after `◇/◆ <name>` on the head. `key` is the class's
 * 关键参数 (spec §4.2); `note` is the extra segment only bash carries (its
 * `description`). Read at CALL time, so a pending card already says what it
 * is doing. */
export interface ToolHead { key?: string; note?: string }
export type ToolHeadBuilder = (call: ToolCall) => ToolHead

/** The per-class seam (ruling 4). A body builder is PURE and WIDTH-FREE: it
 * returns logical content lines (ONE logical line per entry — the fold and the
 * mount cap count entries), already displayText-escaped and toned. `failed`
 * reports an outcome the tool itself did not flag, so the shared head tone and
 * the failed-forces-expanded law stay in one place. */
export interface ToolBody {
  lines: string[]
  failed?: boolean
  /** A body that is PROSE, not rows: the cell renders it through the shared
   * Markdown theme and folds the RESULT (spec §4.2 — cut visible rows, never
   * source lines, which is what makes a fenced block fold correctly). */
  markdown?: string
  /** Rows only an EXPANDED card shows — the raw `arguments`, kept literal
   * (spec §4.2), so an expanded card says exactly what the model asked for. */
  expanded?: string[]
}
export type ToolBodyBuilder = (call: ToolCall, result: ToolResult, palette: Palette) => ToolBody

/** Split, escape and dim one string into body entries. */
function dimLines(text: string, palette: Palette): string[] {
  return displayText(text).split('\n').map((line) => palette.dim(line))
}

/** A named string argument, absent when the model sent something else. */
function stringArg(args: unknown, name: string): string | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Every class without a head of its own: the first non-empty string the model
 * passed (the `generic` rule, spec §4.2). */
const defaultHead: ToolHeadBuilder = (call) => {
  for (const value of Object.values(call.args ?? {})) if (typeof value === 'string' && value !== '') return { key: value }
  return {}
}

/** The flattened result text, dim, one row per line: what an unregistered tool
 * renders (until D13's XML tree lands) and what every class falls back to when
 * a result carries no usable metadata — a replayed log that predates the
 * projection, or a failure that produced no structure at all. */
const plainResultBody: ToolBodyBuilder = (_call, result, palette) =>
  ({ lines: result.resultText === '' ? [] : dimLines(result.resultText, palette) })

// ── terminal (bash, pwsh) ───────────────────────────────────────────────────
// The durable terminal facts are the call arguments and the RENDERED result
// text: `tool-bash` publishes no presentationMeta, and dsh states the contract
// itself — "replay only retains the rendered content text, not the original
// ShellRunResult, so terminal presentation must recover the exit pill here"
// (dsh-shell/src/render.ts). Everything below reads those two.

const BACKGROUND_START = /^started background job (.+)$/
// The inverse of the markers `renderResult` appends, anchored exactly as dsh's
// own parseExitStatus anchors them: a leading newline and the end of the
// string, so ordinary output that merely looks like a marker is left alone.
const SIGNAL_MARKER = /\n\[killed by signal: ([^\]\n]+)\]$/
const EXIT_MARKER = /\n\[exit code: (\d+)\]$/

/** Recover the exit status and strip the marker it came from — a badge the
 * card renders ONCE (leaving the marker in the body would show it twice). */
function splitExitStatus(text: string): { body: string; badge: string | undefined } {
  const signal = SIGNAL_MARKER.exec(text)
  if (signal) return { body: text.slice(0, signal.index), badge: `[signal ${signal[1]}]` }
  const exit = EXIT_MARKER.exec(text)
  if (exit) return { body: text.slice(0, exit.index), badge: `[exit ${exit[1]}]` }
  return { body: text, badge: undefined }   // dsh emits no marker for a clean exit 0
}

/** `~`-abbreviate the home prefix, the way every shell prompt does. */
function abbreviateHome(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const terminalHead: ToolHeadBuilder = ({ args }) => ({ key: stringArg(args, 'command'), note: stringArg(args, 'description') })

const terminalBody: ToolBodyBuilder = ({ args }, result, palette) => {
  // The cwd the command actually ran in: its own workdir, else the session
  // workspace — which talon chdir's into on resume, so process.cwd() IS it.
  const cwd = stringArg(args, 'workdir') ?? process.cwd()
  const lead = [
    ...dimLines(abbreviateHome(cwd), palette),
    ...dimLines(`$ ${stringArg(args, 'command') ?? ''}`, palette),
  ]
  // A flagged failure is a harness error (abort, spawn failure), not a shell
  // exit: dsh's own presenter skips the marker parse for it, and so do we.
  if (result.isError) return { lines: [...lead, ...dimLines(result.resultText, palette)] }
  const background = BACKGROUND_START.exec(result.resultText)
  if (background) return { lines: [...lead, palette.dim(`└ background job ${displayText(background[1]!)}`)] }
  const { body, badge } = splitExitStatus(result.resultText)
  const output = body.replace(/\n+$/, '')     // the captured stream's trailing newline is not a body row
  return {
    lines: [...lead, ...(output === '' ? [] : dimLines(output, palette)), ...(badge === undefined ? [] : [palette.dim(displayText(badge))])],
    failed: badge !== undefined,              // a non-zero exit or a signal colors the head, D12
  }
}

// ── diff (edit, write, str_replace_editor) ──────────────────────────────────
// `edit` and `write` persist their applied hunks as `tool/result.meta`; a
// create records NONE (write.ts:96) and `str_replace_editor` publishes no meta
// at all, so those reconstruct the change from the call arguments — which is
// exactly the fallback dsh's own write presenter takes (write.ts:146).

/** The file a diff-class call names: `file_path` for the fs tools, `path` for
 * `str_replace_editor`. */
function diffPath(args: unknown): string | undefined {
  return stringArg(args, 'file_path') ?? stringArg(args, 'path')
}

const diffHead: ToolHeadBuilder = ({ args }) => ({ key: diffPath(args) })

/** The change as the ARGUMENTS describe it, for the calls the log has no
 * applied hunks for. `undefined` means this call is not a diff at all —
 * `str_replace_editor`'s `view` and `insert` forms, which dsh itself presents
 * as generic cards. */
function callTimeDiffs(call: ToolCall): FileDiff[] | undefined {
  const path = diffPath(call.args)
  if (path === undefined) return undefined
  const args = call.args as Record<string, unknown>
  if (call.name === 'write') return [{ path, oldText: null, newText: text(args.content) }]
  if (call.name === 'edit') return [{ path, oldText: stringArg(call.args, 'old_string') ?? null, newText: text(args.new_string) }]
  if (args.command === 'create') return [{ path, oldText: null, newText: text(args.file_text) }]
  if (args.command === 'str_replace') return [{ path, oldText: stringArg(call.args, 'old_str') ?? null, newText: text(args.new_str) }]
  return undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

const diffBody: ToolBodyBuilder = (call, result, palette) => {
  // A failed mutation applied nothing: show what went wrong rather than a diff
  // of a change that never landed (dsh's edit presenter drops to generic too).
  if (result.isError) return plainResultBody(call, result, palette)
  const diffs = diffsFromMeta(result.meta) ?? callTimeDiffs(call)
  if (diffs === undefined) return plainResultBody(call, result, palette)
  return { lines: renderFileDiffs(diffs, palette, diffPath(call.args)) }
}

// ── read (read, read_image) ─────────────────────────────────────────────────
// `read` persists its numbered window as meta (read-render.ts:212); nothing
// else in the class does — `read_image` publishes none, and no terminal card
// renders pixels anyway (T4 owns images) — so that one falls through to the
// model-facing text, which already says what was read.

interface ReadLine { number: number; text: string }
interface ReadMeta { path: string; offset: number; lines: ReadLine[]; totalLines: number; lang?: string }

function readMetaFrom(meta: unknown): ReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || typeof offset !== 'number' || typeof totalLines !== 'number') return undefined
  if (!Array.isArray(lines) || !lines.every(isReadLine)) return undefined
  return { path, offset, lines, totalLines, ...typeof lang === 'string' ? { lang } : {} }
}

function isReadLine(value: unknown): value is ReadLine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as Record<string, unknown>
  return typeof number === 'number' && typeof text === 'string'
}

const readHead: ToolHeadBuilder = ({ args }) => {
  const path = stringArg(args, 'file_path')
  if (path === undefined) return {}
  const offset = (args as { offset?: unknown }).offset
  return { key: typeof offset === 'number' ? `${path}:${offset}` : path }
}

const readBody: ToolBodyBuilder = (call, result, palette) => {
  if (result.isError) return plainResultBody(call, result, palette)
  const meta = readMetaFrom(result.meta)
  if (meta === undefined) return plainResultBody(call, result, palette)
  const tail = palette.dim(`└ ${meta.totalLines} lines`)
  if (meta.lines.length === 0) return { lines: [tail] }
  // The excerpt is highlighted as ONE block so the grammar sees real context,
  // then re-split: the engine promises 1:1 lines, and oneLine() guarantees the
  // input side of that promise even for a hand-edited log.
  const source = meta.lines.map((line) => oneLine(line.text))
  const highlighted = highlightToAnsi(source.join('\n'), meta.lang, palette)
  const numWidth = String(Math.max(...meta.lines.map((line) => line.number))).length
  return {
    lines: [
      ...meta.lines.map((line, i) => `${BODY_INDENT}${palette.dim(String(line.number).padStart(numWidth))} ${highlighted[i]!}`),
      tail,
    ],
  }
}

// ── search (grep, glob) ─────────────────────────────────────────────────────
// Both tools project one capped, structured payload (presentation.ts): grep's
// matches grouped by file, glob's flat path list, each with the pre-cap `total`
// and a `truncated` flag so a card never presents a capped result as complete.

type SearchMeta =
  | { shape: 'matches'; files: { path: string; matches: { lineNumber: number; line: string }[] }[]; truncated: boolean; total: number }
  | { shape: 'paths'; paths: string[]; truncated: boolean; total: number }

function searchMetaFrom(meta: unknown): SearchMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { shape, files, paths, truncated, total } = meta as Record<string, unknown>
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
  if (shape === 'matches') {
    return Array.isArray(files) && files.every(isFileMatches) ? { shape, files, truncated, total } : undefined
  }
  if (shape === 'paths') {
    return Array.isArray(paths) && paths.every((path) => typeof path === 'string') ? { shape, paths, truncated, total } : undefined
  }
  return undefined
}

function isFileMatches(value: unknown): value is { path: string; matches: { lineNumber: number; line: string }[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, matches } = value as Record<string, unknown>
  return typeof path === 'string' && Array.isArray(matches) && matches.every(isLineMatch)
}

function isLineMatch(value: unknown): value is { lineNumber: number; line: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { lineNumber, line } = value as Record<string, unknown>
  return typeof lineNumber === 'number' && typeof line === 'string'
}

const searchHead: ToolHeadBuilder = ({ args }) => ({ key: stringArg(args, 'pattern') })

function counted(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

const searchBody: ToolBodyBuilder = (call, result, palette) => {
  if (result.isError) return plainResultBody(call, result, palette)
  const meta = searchMetaFrom(result.meta)
  if (meta === undefined) return plainResultBody(call, result, palette)
  const lines = meta.shape === 'matches'
    ? meta.files.flatMap((file) => [
        palette.bold(oneLine(file.path)),
        ...file.matches.map((match) => palette.dim(`${BODY_INDENT}L${match.lineNumber}: ${oneLine(match.line)}`)),
      ])
    : meta.paths.map((path) => palette.dim(oneLine(path)))
  const summary = meta.shape === 'matches' ? counted(meta.total, 'match', 'matches') : counted(meta.total, 'path', 'paths')
  return { lines: [...lines, palette.dim(`└ ${summary}${meta.truncated ? ' · truncated' : ''}`)] }
}

// ── web (web_search, web_fetch) ─────────────────────────────────────────────
// `web_search` projects its sources, `web_fetch` its url + status (tool-web
// search.ts:154 / fetch.ts:374). The url is rendered as plain dim text rather
// than an OSC 8 link: pi-tui's `getCapabilities()` derives hyperlink support
// from the process environment, so linking here would make a committed golden
// depend on whichever terminal ran the suite. Links wait for the capability
// seam T4 introduces alongside images.

interface WebSource { url: string; title?: string; snippet?: string; publishedAt?: string }
type WebMeta =
  | { kind: 'search'; sources: WebSource[]; truncated: boolean }
  | { kind: 'fetch'; url: string; statusCode: number; truncated: boolean }

function webMetaFrom(meta: unknown): WebMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, url, statusCode, truncated } = meta as Record<string, unknown>
  if (typeof truncated !== 'boolean') return undefined
  if (Array.isArray(sources)) return sources.every(isWebSource) ? { kind: 'search', sources, truncated } : undefined
  if (typeof url === 'string' && typeof statusCode === 'number') return { kind: 'fetch', url, statusCode, truncated }
  return undefined
}

function isWebSource(value: unknown): value is WebSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet, publishedAt } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

const webHead: ToolHeadBuilder = ({ args }) => {
  const url = stringArg(args, 'url')
  if (url !== undefined) return { key: url }
  const queries = (args as { queries?: unknown } | undefined)?.queries
  const first = Array.isArray(queries) ? queries.find((query) => typeof query === 'string' && query !== '') : undefined
  return typeof first === 'string' ? { key: first } : {}
}

const webBody: ToolBodyBuilder = (call, result, palette) => {
  if (result.isError) return plainResultBody(call, result, palette)
  const meta = webMetaFrom(result.meta)
  if (meta === undefined) return plainResultBody(call, result, palette)
  const capped = meta.truncated ? ' · truncated' : ''
  if (meta.kind === 'fetch') return { lines: [palette.dim(`${oneLine(meta.url)} · HTTP ${meta.statusCode}${capped}`)] }
  const rows = meta.sources.flatMap((source) => source.title === undefined
    ? [palette.text(oneLine(source.url))]
    : [palette.text(oneLine(source.title)), palette.dim(`${BODY_INDENT}${oneLine(source.url)}`)])
  return { lines: [...rows, palette.dim(`└ ${counted(meta.sources.length, 'source', 'sources')}${capped}`)] }
}

// ── generic ─────────────────────────────────────────────────────────────────
// The curated tools whose results are PROSE. The body goes through the shared
// Markdown theme and folds by rendered rows (spec §4.2).

const genericBody: ToolBodyBuilder = (call, result, palette) => ({
  lines: [],
  ...result.resultText === '' ? {} : { markdown: result.resultText },
  // Literal, never through the parser: what an expanded card reveals is the
  // model's own JSON, not a rendering of it.
  ...call.rawArguments === '' ? {} : { expanded: dimLines(call.rawArguments, palette) },
})

// ── unregistered (D13) ──────────────────────────────────────────────────────
// A tool talon knows nothing about: a REAL parser or an explicit refusal, never
// a regex. Well-formed XML becomes a tree; anything else stays plain text.

const unknownBody: ToolBodyBuilder = (call, result, palette) => {
  const tree = renderUnknownXml(result.resultText, palette)
  return tree === undefined ? plainResultBody(call, result, palette) : { lines: tree }
}

export const TOOL_HEAD_BUILDERS: Record<ToolCardClass | 'unregistered', ToolHeadBuilder> = {
  terminal: terminalHead,
  diff: diffHead,
  read: readHead,
  search: searchHead,
  web: webHead,
  generic: defaultHead,
  unregistered: defaultHead,
}

export const TOOL_BODY_BUILDERS: Record<ToolCardClass | 'unregistered', ToolBodyBuilder> = {
  terminal: terminalBody,
  diff: diffBody,
  read: readBody,
  search: searchBody,
  web: webBody,
  generic: genericBody,
  unregistered: unknownBody,
}

const BODY_INDENT = '  '
const NO_ROWS: string[] = []
const PENDING_GLYPH = '◇'
const SETTLED_GLYPH = '◆'
const RUNNING_BODY = '└ running…'
const PREVIEW_BODY_LINES = 6            // collapsed cards show at most this many body lines
const PREVIEW_EDGE = PREVIEW_BODY_LINES / 2
/** The head of an orphan card: a result whose call is not (or no longer) mounted. */
export const ORPHAN_CARD_NAME = 'tool'

/** The single collapsed-fold rule for every card class: head and tail around
 * one dim marker naming what was dropped. */
export function foldPreview(body: string[], palette: Palette): string[] {
  if (body.length <= PREVIEW_BODY_LINES) return body
  return [
    ...body.slice(0, PREVIEW_EDGE),
    palette.dim(`… ${body.length - PREVIEW_BODY_LINES} more lines …`),
    ...body.slice(body.length - PREVIEW_EDGE),
  ]
}

/** The bash `command` argument — what an approval prompt previews (spec D9). */
export function commandArg(args: unknown): string | undefined {
  return stringArg(args, 'command')
}

/** Escaped, and cut to its first logical line: the head is always ONE row, and
 * displayText keeps LF (the one control it does not escape). */
function oneLine(text: string): string {
  return displayText(text).split('\n')[0]
}

export class ToolCardCell implements Component {
  private result: ToolResult | undefined
  private body: ToolBody | undefined
  private visibility: CardVisibility = 'collapsed'
  // A failure by either route — the tool flagged it, or the class read one out
  // of the result (a non-zero shell exit). Drives the head tone AND the
  // failed-forces-expanded law, so both can never disagree.
  private failed = false
  // The body as it currently presents: the running line while pending, the
  // built (and, for a success, folded) body once settled. Held pre-wrap so
  // contentLineCount() stays width-free for the O(1) mount-cap accounting.
  private presented: string[]
  // A prose body: ONE Markdown built at settle (§5.1 — never inside render),
  // rendered at width and folded by its RESULTING rows. `mdSourceLines` keeps
  // contentLineCount() width-free, the same law the streaming cell follows.
  private md: Markdown | undefined
  private mdSourceLines = 0
  // Rows only an expanded card shows, rendered under everything else.
  private extra: string[] = []
  private cache: { width: number; lines: string[] } | undefined

  constructor(private readonly call: ToolCall, private readonly palette: Palette) {
    this.presented = [palette.dim(RUNNING_BODY)]
  }

  /** The key the transcript settles this card by (ruling 5). */
  get callId(): string { return this.call.callId }
  isSettled(): boolean { return this.result !== undefined }

  /** Ctrl+O, applied as a MUTATOR (never a render argument) so the cache drops
   * and the transcript can re-register the line-count delta. */
  setVisibility(mode: CardVisibility): void {
    this.visibility = mode
    this.represent()
    this.cache = undefined
  }

  /** A hidden card contributes nothing — but a FAILURE is never hidden. */
  private isHidden(): boolean { return this.visibility === 'hidden' && !this.failed }

  /** Content lines (logical, pre-wrap) for the mount-cap accounting. */
  contentLineCount(): number {
    return this.isHidden() ? 0 : 1 + this.presented.length + this.mdSourceLines + this.extra.length
  }

  /** Mutate in place on tool/result: the head takes its settled glyph and
   * outcome tone, the body comes from this class's builder. */
  settle(result: ToolResult): void {
    this.result = result
    const body = TOOL_BODY_BUILDERS[classifyTool(this.call.name)](this.call, result, this.palette)
    this.body = body
    this.failed = result.isError || body.failed === true
    if (body.markdown === undefined) { this.md = undefined; this.mdSourceLines = 0 }
    else {
      const source = displayText(body.markdown)     // escape BEFORE the parser sees it (D7.8 order)
      this.md = new Markdown(source, 0, 0, markdownTheme(this.palette))
      this.mdSourceLines = source.split('\n').length
    }
    this.represent()
    this.cache = undefined
  }

  /** The body as it currently presents. Built ONCE per settle and only
   * re-folded here, so cycling Ctrl+O never re-runs a class builder (and the
   * diff walk behind it). */
  private represent(): void {
    const body = this.body
    if (body === undefined) return                 // still pending: the running line stands
    const whole = this.failed || this.visibility === 'expanded'
    this.presented = whole ? body.lines : foldPreview(body.lines, this.palette)
    // The raw arguments come LAST, under whatever the body rendered.
    this.extra = whole ? body.expanded ?? [] : []
  }

  invalidate(): void { this.cache = undefined }

  render(width: number): string[] {
    if (this.isHidden()) return NO_ROWS
    if (this.result === undefined) return this.renderLines(width)   // live tail: content still changing
    if (this.cache?.width !== width) this.cache = { width, lines: this.renderLines(width) }
    return this.cache.lines
  }

  private renderLines(width: number): string[] {
    const safe = Math.max(1, width)
    const rows = [truncateToWidth(this.head(), safe, '…'), ...this.presented.flatMap((row) => wrapPlain(row, safe))]
    if (this.md !== undefined) {
      // Markdown wraps and pads its own rows to `safe` — never re-wrap them.
      const prose = this.md.render(safe)
      rows.push(...this.failed || this.visibility === 'expanded' ? prose : foldPreview(prose, this.palette))
    }
    rows.push(...this.extra.flatMap((row) => wrapPlain(row, safe)))
    return rows
  }

  private head(): string {
    const tone = this.result === undefined ? this.palette.warning : this.failed ? this.palette.error : this.palette.success
    const glyph = this.result === undefined ? PENDING_GLYPH : SETTLED_GLYPH
    const { key, note } = TOOL_HEAD_BUILDERS[classifyTool(this.call.name)](this.call)
    const parts = [`${glyph} ${oneLine(this.call.name)}`]
    if (key !== undefined) parts.push(oneLine(key))
    if (note !== undefined) parts.push(oneLine(note))
    return tone(parts.join(' · '))
  }
}
