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
import { truncateToWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'
import { wrapPlain } from './cells.js'
import { diffsFromMeta, renderFileDiffs, type FileDiff } from './diff-render.js'

export type ToolCardClass = 'terminal' | 'diff' | 'read' | 'search' | 'web' | 'generic'

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
export interface ToolBody { lines: string[]; failed?: boolean }
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

/** Until each class lands: the flattened result text, dim, one row per line. */
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

export const TOOL_HEAD_BUILDERS: Record<ToolCardClass | 'unregistered', ToolHeadBuilder> = {
  terminal: terminalHead,
  diff: diffHead,
  read: defaultHead,
  search: defaultHead,
  web: defaultHead,
  generic: defaultHead,
  unregistered: defaultHead,
}

export const TOOL_BODY_BUILDERS: Record<ToolCardClass | 'unregistered', ToolBodyBuilder> = {
  terminal: terminalBody,
  diff: diffBody,
  read: plainResultBody,
  search: plainResultBody,
  web: plainResultBody,
  generic: plainResultBody,
  unregistered: plainResultBody,
}

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
  // A failure by either route — the tool flagged it, or the class read one out
  // of the result (a non-zero shell exit). Drives the head tone AND the
  // failed-forces-expanded law, so both can never disagree.
  private failed = false
  // The body as it currently presents: the running line while pending, the
  // built (and, for a success, folded) body once settled. Held pre-wrap so
  // contentLineCount() stays width-free for the O(1) mount-cap accounting.
  private presented: string[]
  private cache: { width: number; lines: string[] } | undefined

  constructor(private readonly call: ToolCall, private readonly palette: Palette) {
    this.presented = [palette.dim(RUNNING_BODY)]
  }

  /** The key the transcript settles this card by (ruling 5). */
  get callId(): string { return this.call.callId }
  isSettled(): boolean { return this.result !== undefined }
  /** Content lines (logical, pre-wrap) for the mount-cap accounting. */
  contentLineCount(): number { return 1 + this.presented.length }

  /** Mutate in place on tool/result: the head takes its settled glyph and
   * outcome tone, the body comes from this class's builder. */
  settle(result: ToolResult): void {
    this.result = result
    const body = TOOL_BODY_BUILDERS[classifyTool(this.call.name)](this.call, result, this.palette)
    this.failed = result.isError || body.failed === true
    this.presented = this.failed ? body.lines : foldPreview(body.lines, this.palette)
    this.cache = undefined
  }

  invalidate(): void { this.cache = undefined }

  render(width: number): string[] {
    if (this.result === undefined) return this.renderLines(width)   // live tail: content still changing
    if (this.cache?.width !== width) this.cache = { width, lines: this.renderLines(width) }
    return this.cache.lines
  }

  private renderLines(width: number): string[] {
    const safe = Math.max(1, width)
    return [truncateToWidth(this.head(), safe, '…'), ...this.presented.flatMap((row) => wrapPlain(row, safe))]
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
