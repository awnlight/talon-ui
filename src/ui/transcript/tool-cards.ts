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
import { truncateToWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'
import { wrapPlain } from './cells.js'

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

/** The per-class seam (ruling 4). A body builder is PURE and WIDTH-FREE: it
 * returns logical content lines, already displayText-escaped and toned; the
 * cell truncates/wraps them and folds the preview. Tasks 6–10 replace the
 * placeholder below one class at a time. */
export type ToolBodyBuilder = (args: unknown, result: ToolResult, palette: Palette) => string[]

/** Until each class lands: the flattened result text, dim, one row per line. */
const plainResultBody: ToolBodyBuilder = (_args, result, palette) =>
  result.resultText === '' ? [] : displayText(result.resultText).split('\n').map((line) => palette.dim(line))

export const TOOL_BODY_BUILDERS: Record<ToolCardClass | 'unregistered', ToolBodyBuilder> = {
  terminal: plainResultBody,
  diff: plainResultBody,
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
  const command = (args as { command?: unknown } | undefined)?.command
  return typeof command === 'string' ? command : undefined
}

/** The head's key argument: the first non-empty string the model passed. */
function keyArg(args: unknown): string | undefined {
  for (const value of Object.values(args ?? {})) if (typeof value === 'string' && value !== '') return value
  return undefined
}

/** Escaped, and cut to its first logical line: the head is always ONE row, and
 * displayText keeps LF (the one control it does not escape). */
function oneLine(text: string): string {
  return displayText(text).split('\n')[0]
}

export class ToolCardCell implements Component {
  private result: ToolResult | undefined
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
    const body = TOOL_BODY_BUILDERS[classifyTool(this.call.name)](this.call.args, result, this.palette)
    this.presented = result.isError ? body : foldPreview(body, this.palette)
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
    const tone = this.result === undefined ? this.palette.warning : this.result.isError ? this.palette.error : this.palette.success
    const glyph = this.result === undefined ? PENDING_GLYPH : SETTLED_GLYPH
    const key = keyArg(this.call.args)
    return tone(`${glyph} ${oneLine(this.call.name)}${key === undefined ? '' : ` · ${oneLine(key)}`}`)
  }
}
