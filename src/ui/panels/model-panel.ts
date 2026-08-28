/** The `/model` selector (spec §3.7/§4.4): SelectList + fuzzy filter, on the
 * ResumePanel's exact shape — SelectList items are constructor-only, so every
 * query change REBUILDS the list.
 *
 * Shift+Tab cycles the HIGHLIGHTED row's reasoning effort (the old
 * interaction, kept). The efforts are whatever `resolveModelInfo` reported for
 * that exact route — never a hard-coded ladder — so a model with none simply
 * has nothing to cycle. */
import { Input, SelectList, fuzzyFilter, matchesKey, truncateToWidth, type Component, type SelectItem, type SelectListTheme } from '@earendil-works/pi-tui'
import { routeKey, type ModelChoice } from '../../backend/models.js'
import { displayText, type Palette } from '../../theme/palette.js'
import { panelRule } from './panel-rule.js'

const SEARCH = '⌕ '
const PLACEHOLDER = 'type to filter'
const HINT = '↑/↓ · shift+tab effort · enter select · esc clear/cancel'
const LOADING = 'Loading models…'
const NO_MATCH = 'No matching models.'
const ERROR_LOADING = 'Models are still loading.'
const ERROR_NO_MATCH = 'No model matches this search.'
const MAX_VISIBLE = 8
const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 }
const CURRENT_MARK = '● '
const OTHER_MARK = '  '

/** What the panel answers with: a route plus the effort chosen for it. */
export interface ModelPick { provider: string; model: string; reasoningEffort: string | undefined }

export class ModelPanel implements Component {
  private choices: ModelChoice[] | undefined
  private readonly input = new Input()
  private rows: ModelChoice[] = []
  /** Effort chosen per route by Shift+Tab. Absent = the route's own default. */
  private readonly efforts = new Map<string, string>()
  private readonly theme: SelectListTheme
  private list: SelectList
  private error = ''

  constructor(
    private readonly finish: (picked: ModelPick | undefined) => void,
    private readonly palette: Palette,
  ) {
    this.theme = {
      /* v8 ignore next -- required by SelectListTheme but never called by SelectList (the ResumePanel precedent) */
      selectedPrefix: palette.text,
      selectedText: palette.selected,
      description: palette.dim,
      scrollInfo: palette.dim,
      /* v8 ignore next -- render() intercepts an empty list with talon's own copy before SelectList can show its own */
      noMatch: palette.dim,
    }
    this.list = this.build()
  }

  invalidate(): void {}
  get focused(): boolean { return this.input.focused }
  set focused(value: boolean) { this.input.focused = value }

  /** loading → loaded in place: the panel stays mounted across the swap. */
  setChoices(choices: ModelChoice[]): void {
    this.choices = choices
    for (const choice of choices) {
      // The current route lands pre-set to the effort the agent is running.
      if (choice.current && choice.defaultEffort !== undefined) this.efforts.set(routeKey(choice.provider, choice.model), choice.defaultEffort)
    }
    this.rebuild()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'enter')) { this.pick(); return }
    if (matchesKey(data, 'shift+tab')) { this.cycleEffort(); return }
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

  /** Advance the highlighted route through its own efforts, wrapping. The row
   * LABEL carries the effort, and SelectList items are constructor-only, so
   * this rebuilds — and must put the highlight back where it was, or the next
   * Enter would select a different model than the one the user was looking at. */
  private cycleEffort(): void {
    const highlighted = this.highlighted()
    if (highlighted === undefined || highlighted.efforts.length === 0) return
    const key = routeKey(highlighted.provider, highlighted.model)
    const at = highlighted.efforts.findIndex((effort) => effort.id === this.efforts.get(key))
    this.efforts.set(key, highlighted.efforts[(at + 1) % highlighted.efforts.length]!.id)
    this.list = this.build(key)
  }

  private highlighted(): ModelChoice | undefined {
    const item = this.list.getSelectedItem()
    return item === null ? undefined : this.rows.find((row) => routeKey(row.provider, row.model) === item.value)
  }

  private pick(): void {
    if (this.choices === undefined) { this.error = ERROR_LOADING; return }
    const picked = this.highlighted()
    if (picked === undefined) { this.error = ERROR_NO_MATCH; return }
    this.finish({ provider: picked.provider, model: picked.model, reasoningEffort: this.efforts.get(routeKey(picked.provider, picked.model)) })
  }

  private rebuild(): void {
    this.error = ''
    this.list = this.build()
  }

  /** `keep` names a route the highlight must stay on across the rebuild. A
   * QUERY change deliberately passes nothing: a new filter re-lands on the top
   * row, the way every filtered list does. */
  private build(keep?: string): SelectList {
    this.rows = fuzzyFilter(this.choices ?? [], this.input.getValue(), (c) => `${c.name} ${c.model} ${c.providerName}`)
    const list = new SelectList(this.rows.map((choice) => this.toItem(choice)), MAX_VISIBLE, this.theme, LAYOUT)
    const at = keep === undefined ? -1 : this.rows.findIndex((row) => routeKey(row.provider, row.model) === keep)
    if (at >= 0) list.setSelectedIndex(at)
    return list
  }

  private toItem(choice: ModelChoice): SelectItem {
    const key = routeKey(choice.provider, choice.model)
    const effort = this.efforts.get(key)
    const meta = [choice.providerName]
    if (choice.contextWindow !== undefined) meta.push(`${Math.round(choice.contextWindow / 1000)}k ctx`)
    if (effort !== undefined) meta.push(`effort ${effort}`)
    else if (choice.efforts.length > 0) meta.push(`${choice.efforts.length} efforts`)
    if (choice.description !== undefined) meta.push(choice.description)
    return {
      value: key,
      label: `${choice.current ? CURRENT_MARK : OTHER_MARK}${displayText(choice.name)}`,
      description: displayText(meta.join(' · ')),
    }
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const query = this.input.getValue()
    const rows = [
      '',
      panelRule('model', safe, p),
      truncateToWidth(query === '' ? p.dim(`${SEARCH}${PLACEHOLDER}`) : SEARCH + this.input.render(Math.max(1, safe - 2))[0]!, safe, '…'),
    ]
    if (this.choices === undefined) rows.push(p.dim(truncateToWidth(LOADING, safe, '…')))
    else if (this.rows.length === 0) rows.push(p.dim(truncateToWidth(NO_MATCH, safe, '…')))
    else rows.push(...this.list.render(safe).map((row) => truncateToWidth(row, safe, '…')))
    rows.push(p.dim(truncateToWidth(HINT, safe, '…')))
    if (this.error !== '') rows.push(p.error(truncateToWidth(displayText(this.error), safe, '…')))
    return rows
  }
}
