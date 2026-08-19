// src/ui/panels/resume-panel.ts
/** Resume selector (spec §3.6/§4.4): SelectList + fuzzy filter + scope
 * toggle. SelectList items are constructor-only, so every query/scope/
 * candidate change REBUILDS the list (the Editor does the same per query).
 * Disabled rows stay visible and explain themselves; Enter refuses them. */
import { Input, SelectList, fuzzyFilter, matchesKey, truncateToWidth, type Component, type SelectItem, type SelectListTheme } from '@earendil-works/pi-tui'
import type { ResumeCandidate } from '../../backend/sessions.js'
import { displayText, type Palette } from '../../theme/palette.js'
import { panelRule } from './panel-rule.js'

const SEARCH = '⌕ '
const PLACEHOLDER = 'type to filter'
const HINT = '↑/↓ · tab scope · enter resume · esc clear/cancel'
const LOADING = 'Loading sessions…'
const NO_MATCH = 'No matching sessions.'
const ERROR_LOADING = 'Sessions are still loading.'
const ERROR_NO_MATCH = 'No session matches this search.'
/** Rows shown before the SelectList scrolls (its own scrollInfo takes over). */
const MAX_VISIBLE = 8
/** Two-column rows (Ruling 9): titles get a stable column, meta takes the rest. */
const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 }

export class ResumePanel implements Component {
  private candidates: ResumeCandidate[] | undefined
  private scope: 'workspace' | 'all' = 'workspace'
  private readonly input = new Input()
  /** The candidates behind the current list rows: Enter maps the selected
   * SelectItem back through it by id. Kept in step by build(). */
  private rows: ResumeCandidate[] = []
  private readonly theme: SelectListTheme
  private list: SelectList
  private error = ''

  constructor(
    private readonly finish: (picked: ResumeCandidate | undefined) => void,
    private readonly palette: Palette,
    private readonly formatWorkspace: (cwd: string | undefined) => string,
  ) {
    this.theme = {
      // Required by the type but dead upstream (SelectList never reads it):
      // the no-op `text` role rather than a private identity function.
      selectedPrefix: palette.text,
      selectedText: palette.selected, // reverse video — selectors only (spec D6)
      description: palette.dim,
      scrollInfo: palette.dim,
      // Unreachable: render() intercepts an empty list with talon's own copy
      // (upstream's reads "No matching commands").
      noMatch: palette.dim,
    }
    this.list = this.build()
  }

  invalidate(): void {}
  /** Focusable: forwarded to the filter Input so its caret renders. */
  get focused(): boolean { return this.input.focused }
  set focused(value: boolean) { this.input.focused = value }

  /** loading → loaded in place: the panel stays mounted across the swap. */
  setCandidates(candidates: ResumeCandidate[]): void {
    this.candidates = candidates
    this.rebuild()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'enter')) { this.pick(); return }
    if (matchesKey(data, 'tab')) {
      // Old-TUI exact: a scope flip resets the query, and with it the selection.
      this.scope = this.scope === 'workspace' ? 'all' : 'workspace'
      this.input.setValue('')
      this.rebuild()
      return
    }
    if (matchesKey(data, 'escape')) {
      if (this.input.getValue() === '') { this.finish(undefined); return }
      this.input.setValue('')
      this.rebuild()
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) { this.list.handleInput(data); return }
    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() !== before) this.rebuild()
  }

  private pick(): void {
    if (this.candidates === undefined) { this.error = ERROR_LOADING; return }
    const item = this.list.getSelectedItem()
    if (item === null) { this.error = ERROR_NO_MATCH; return }
    // Always found: `rows` and the list's items are built from each other.
    const picked = this.rows.find((c) => c.id === item.value)!
    if (picked.disabledReason !== undefined) { this.error = picked.disabledReason; return }
    this.finish(picked)
  }

  private get all(): ResumeCandidate[] { return this.candidates ?? [] }

  private rebuild(): void {
    this.error = ''
    this.list = this.build()
  }

  /** Re-derives `rows` for the current scope + query and returns the list
   * built from them (SelectList items are constructor-only). */
  private build(): SelectList {
    const scoped = this.scope === 'workspace' ? this.all.filter((c) => c.currentWorkspace) : this.all
    // The workspace label joins the haystack only where it is also on screen.
    this.rows = fuzzyFilter(scoped, this.input.getValue(), (c) => `${c.title} ${c.id}${this.scope === 'all' ? ` ${this.formatWorkspace(c.cwd)}` : ''}`)
    return new SelectList(this.rows.map((c) => this.toItem(c)), MAX_VISIBLE, this.theme, LAYOUT)
  }

  private toItem(c: ResumeCandidate): SelectItem {
    const meta = [new Date(c.lastActivityAt).toISOString(), ...(c.live ? ['live'] : []), ...(c.persisted ? ['persisted'] : []), c.id]
    if (this.scope === 'all') meta.push(this.formatWorkspace(c.cwd))
    if (c.disabledReason !== undefined) meta.push(`unavailable: ${c.disabledReason}`)
    return { value: c.id, label: displayText(c.title), description: displayText(meta.join(' · ')) }
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const query = this.input.getValue()
    const rows = [
      '',
      panelRule('resume', safe, p),
      truncateToWidth(query === '' ? p.dim(`${SEARCH}${PLACEHOLDER}`) : SEARCH + this.input.render(Math.max(1, safe - 2))[0]!, safe, '…'),
      truncateToWidth(this.scopeRow(), safe, '…'),
    ]
    if (this.candidates === undefined) rows.push(p.dim(truncateToWidth(LOADING, safe, '…')))
    else if (this.rows.length === 0) rows.push(p.dim(truncateToWidth(NO_MATCH, safe, '…')))
    else rows.push(...this.list.render(safe).map((row) => truncateToWidth(row, safe, '…')))
    rows.push(p.dim(truncateToWidth(HINT, safe, '…')))
    if (this.error !== '') rows.push(p.error(truncateToWidth(displayText(this.error), safe, '…')))
    return rows
  }

  /** The active scope accented, the other dim behind the tab glyph. */
  private scopeRow(): string {
    const p = this.palette
    const mark = (text: string, active: boolean): string => active ? p.accent(text) : p.dim(`⇥ ${text}`)
    const here = `this workspace ${displayText(this.formatWorkspace(this.all.find((c) => c.currentWorkspace)?.cwd))}`
    return `${mark(here, this.scope === 'workspace')}  ${mark(`all workspaces (${this.all.length})`, this.scope === 'all')}`
  }
}
