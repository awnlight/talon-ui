/** The workflow run card (spec §3.9).
 *
 * A workflow writes FOUR durable records into its calling session — the run
 * opens, each member starts, each member settles, the run closes — so the card
 * is built from the log exactly like a tool card, mutating in place and keyed
 * by `runId`. Live and replay therefore produce the same rows, and a run whose
 * end never arrived stays open on screen, because that is what the log says
 * happened.
 *
 * The tone law is the tool card's, unchanged: the head carries the state
 * colour, the body is dim, and only members carry their own outcome tone. */
import { truncateToWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'
import { wrapPlain } from './cells.js'

const RUNNING_GLYPH = '◇'
const SETTLED_GLYPH = '◆'
const INDENT = '  '
/** Members past this fold into a count — a run can have dozens. */
const MAX_MEMBERS = 8

/** How a member settled (`WorkflowAgentOutcome`). */
export type WorkflowMemberOutcome = 'completed' | 'failed' | 'cancelled'
/** Why the run settled (`WorkflowStopReason`). */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

interface Member { seq: number; label: string; phase: string | undefined; outcome: WorkflowMemberOutcome | undefined }

export class WorkflowCardCell implements Component {
  private readonly members = new Map<number, Member>()
  private stopReason: WorkflowStopReason | undefined
  private cache: { width: number; lines: string[] } | undefined

  constructor(readonly runId: string, private readonly name: string, private readonly palette: Palette) {}

  /** A member joined the run. A repeat of the same `seq` replaces it — the log
   * is the truth and a replay must not double-count. */
  startMember(seq: number, label: string, phase: string | undefined): void {
    this.members.set(seq, { seq, label, phase, outcome: undefined })
    this.cache = undefined
  }

  /** A member settled. An `agent-end` whose start never arrived still lands:
   * the outcome is the fact, and dropping it would hide a failure. */
  endMember(seq: number, outcome: WorkflowMemberOutcome): void {
    const member = this.members.get(seq)
    this.members.set(seq, member === undefined ? { seq, label: `member ${seq}`, phase: undefined, outcome } : { ...member, outcome })
    this.cache = undefined
  }

  settle(stopReason: WorkflowStopReason): void {
    this.stopReason = stopReason
    this.cache = undefined
  }

  isSettled(): boolean { return this.stopReason !== undefined }
  invalidate(): void { this.cache = undefined }

  /** Content lines (logical, pre-wrap) for the mount-cap accounting. */
  contentLineCount(): number { return this.rows().length }

  render(width: number): string[] {
    // Uncached while the run is open — it is the mutating tail — and
    // width-cached once it settles: the tool card's law, unchanged.
    if (this.stopReason === undefined) return this.renderLines(width)
    if (this.cache?.width !== width) this.cache = { width, lines: this.renderLines(width) }
    return this.cache.lines
  }

  private renderLines(width: number): string[] {
    const safe = Math.max(1, width)
    const [head, ...body] = this.rows()
    return [truncateToWidth(head!, safe, '…'), ...body.flatMap((row) => wrapPlain(row, safe))]
  }

  /** The logical rows, head first. One place, so the render and the mount-cap
   * count can never disagree. */
  private rows(): string[] {
    const p = this.palette
    const settled = this.stopReason !== undefined
    const tone = !settled ? p.warning : this.stopReason === 'completed' ? p.success : p.error
    const rows = [tone(`${settled ? SETTLED_GLYPH : RUNNING_GLYPH} workflow · ${displayText(this.name)}`)]
    const members = [...this.members.values()].sort((a, b) => a.seq - b.seq)
    for (const member of members.slice(0, MAX_MEMBERS)) rows.push(this.memberRow(member))
    const hidden = members.length - MAX_MEMBERS
    if (hidden > 0) rows.push(p.dim(`${INDENT}… ${hidden} more members …`))
    rows.push(p.dim(`└ ${members.length} member${members.length === 1 ? '' : 's'}${settled ? ` · ${this.stopReason!}` : ''}`))
    return rows
  }

  private memberRow(member: Member): string {
    const p = this.palette
    const tone = member.outcome === undefined ? p.warning : member.outcome === 'completed' ? p.success : p.error
    const glyph = member.outcome === undefined ? RUNNING_GLYPH : SETTLED_GLYPH
    const meta = [member.phase, member.outcome].filter((part): part is string => part !== undefined)
    return `${INDENT}${tone(`${glyph} ${displayText(member.label)}`)}${meta.length === 0 ? '' : p.dim(` · ${displayText(meta.join(' · '))}`)}`
  }
}
