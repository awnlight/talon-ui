/** `/agents` (spec §3.9): the subagent tree, read-only.
 *
 * `listDescendants` hands back depth, label, activity and diagnostics already
 * interpreted — the projection fold is the single classification authority, so
 * this panel renders what it is told and parses no descriptor of its own.
 *
 * A `diagnostic` row is DIM, not red. A child whose descriptor is corrupt or
 * whose persistence could not be read is a fact about the log, not a talon
 * failure, and dressing it as an error would say otherwise. */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'
import { panelRule } from './panel-rule.js'

const HINT = 'esc close'
const LOADING = 'Loading agents…'
const EMPTY = 'No subagents in this session.'
const INDENT = '  '
const RUNNING = '◇'
const SETTLED = '◆'
const DIAGNOSTIC = '◌'
/** Rows past this are summarized rather than printed: the panel is a glance. */
const MAX_ROWS = 12

/** One entry of `listDescendants`, narrowed to what this panel renders. */
export type AgentEntry =
  | { kind: 'child'; id: string; depth: number; activity: 'running' | 'inactive'; mode: 'one-shot' | 'continuable'; label?: string }
  | { kind: 'diagnostic'; id: string; depth: number; reason: string }

export class AgentsPanel implements Component {
  private entries: AgentEntry[] | undefined

  constructor(private readonly finish: () => void, private readonly palette: Palette) {}

  invalidate(): void {}
  setEntries(entries: AgentEntry[]): void { this.entries = entries }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) this.finish()
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const rows = ['', panelRule('agents', safe, p)]
    if (this.entries === undefined) rows.push(p.dim(LOADING))
    else if (this.entries.length === 0) rows.push(p.dim(EMPTY))
    else {
      for (const entry of this.entries.slice(0, MAX_ROWS)) rows.push(truncateToWidth(this.row(entry), safe, '…'))
      const hidden = this.entries.length - MAX_ROWS
      if (hidden > 0) rows.push(p.dim(`${INDENT}… ${hidden} more …`))
    }
    rows.push(p.dim(truncateToWidth(HINT, safe, '…')))
    return rows
  }

  private row(entry: AgentEntry): string {
    const p = this.palette
    // Depth 1 is a direct child, so the root's own children sit flush left.
    const indent = INDENT.repeat(Math.max(0, entry.depth - 1))
    if (entry.kind === 'diagnostic') return p.dim(`${indent}${DIAGNOSTIC} ${displayText(entry.id)} · ${displayText(entry.reason)}`)
    const glyph = entry.activity === 'running' ? RUNNING : SETTLED
    const tone = entry.activity === 'running' ? p.warning : p.success
    const label = entry.label === undefined ? displayText(entry.id) : displayText(entry.label)
    return `${indent}${tone(`${glyph} ${label}`)}${p.dim(` · ${entry.mode} · ${displayText(entry.id)}`)}`
  }
}
