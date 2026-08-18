// src/ui/panels/question-panel.ts
/** Inline question panel (spec §4.4, ported from the recovered QuestionDialog):
 * one panel session walks the whole request's questions serially; the FIFO
 * queue above it stays one-entry-per-request so the counter can say
 * "Question 2/5". Live panel — re-renders freely. */
import { Input, matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { displayText, type Palette } from '../../theme/palette.js'
import { wrapPlain } from '../transcript/cells.js'
import { panelRule } from './panel-rule.js'
import { IDLE_PAGE, compactHeader, windowBlocks, type BlockPage } from './question-layout.js'

const HINT_OPTIONS = ['Tab custom answer', '↑/↓ navigate', 'Enter submit', 'Esc interrupt']
const ERROR_SELECT = 'Select at least one option, or press Tab for a custom answer.'
const ERROR_CUSTOM = 'Enter an answer before submitting.'
/** Option blocks shown at once before the list windows and the position line appears. */
const MAX_VISIBLE = 8

/** A header row plus its tone: styling is applied AFTER windowing. */
interface HeaderRow { text: string; dim: boolean }

/** Move a page window by one screenful, clamped to its own bounds. */
function paged(page: BlockPage, direction: 1 | -1): BlockPage {
  return { ...page, offset: Math.min(page.maxOffset, Math.max(0, page.offset + direction * page.size)) }
}

export class QuestionPanel implements Component {
  private index = 0
  private cursor = 0
  private readonly answers: AskUserQuestionAnswerItem[] = []
  private error = ''
  /** Options mode lists the choices; custom mode swaps them for `input`. A
   * question with no options has nothing to list, so it starts in custom. */
  private mode: 'options' | 'custom'
  private readonly selected = new Set<number>()
  private readonly input = new Input()
  /** Both pages are re-derived by every render, so a layout that fits idles them. */
  private headerPage = IDLE_PAGE
  private selectedPage = IDLE_PAGE

  constructor(
    private readonly request: { questions: AskUserQuestionItem[] },
    private readonly finish: (answer: AskUserQuestionAnswer) => void,
    private readonly cancel: () => void,
    private readonly palette: Palette,
    private readonly maxHeight: () => number,
  ) {
    this.mode = this.options.length > 0 ? 'options' : 'custom'
    this.input.onSubmit = (value) => this.submitCustom(value)
    this.input.onEscape = () => {
      if (this.options.length > 0) { this.mode = 'options'; this.error = '' }
      else this.cancel()
    }
  }

  invalidate(): void {}
  /** Focusable: forwarded to the Input so its caret renders in custom mode
   * (options mode never renders the Input, so the marker cannot leak there). */
  get focused(): boolean { return this.input.focused }
  set focused(value: boolean) { this.input.focused = value }
  private get question(): AskUserQuestionItem { return this.request.questions[this.index]! }
  private get options(): { label: string; description?: string }[] { return this.question.options ?? [] }

  handleInput(data: string): void {
    // Paging is checked BEFORE the mode dispatch: in custom mode the Input
    // owns every other key, but the header pager must stay reachable.
    if (matchesKey(data, 'pageUp')) { this.pageBack(); return }
    if (matchesKey(data, 'pageDown')) { this.pageForward(); return }
    // Custom mode: the Input owns every key. Enter and Escape come back
    // through its onSubmit/onEscape callbacks, so nothing is intercepted here.
    if (this.mode === 'custom') { this.input.handleInput(data); return }
    const options = this.options
    if (matchesKey(data, 'escape')) { this.cancel(); return }
    if (matchesKey(data, 'space') && this.question.multiSelect) {
      if (this.selected.has(this.cursor)) this.selected.delete(this.cursor)
      else this.selected.add(this.cursor)
      return
    }
    if (matchesKey(data, 'tab') || data.toLowerCase() === 'c') { this.mode = 'custom'; this.error = ''; this.selectedPage = IDLE_PAGE; return }
    if (matchesKey(data, 'up')) { this.moveCursor(this.cursor + options.length - 1); return }
    if (matchesKey(data, 'down')) { this.moveCursor(this.cursor + 1); return }
    if (/^[1-9]$/.test(data) && Number(data) <= options.length) { this.moveCursor(Number(data) - 1); return }
    if (matchesKey(data, 'enter')) { this.submitOptions(); return }
  }

  /** Every cursor move restarts the selected block at its top (spec §4.4). */
  private moveCursor(next: number): void {
    this.cursor = next % Math.max(1, this.options.length)
    this.selectedPage = IDLE_PAGE
  }

  /** PgUp rewinds the oversized selected block first, then the header. */
  private pageBack(): void {
    if (this.selectedPage.offset > 0) { this.selectedPage = paged(this.selectedPage, -1); return }
    this.headerPage = paged(this.headerPage, -1)
  }

  /** PgDn pages the header first, then the oversized selected block — which
   * custom mode leaves idle, so there it is a no-op. */
  private pageForward(): void {
    if (this.headerPage.offset < this.headerPage.maxOffset) { this.headerPage = paged(this.headerPage, 1); return }
    this.selectedPage = paged(this.selectedPage, 1)
  }

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
    if (custom === '') { this.error = ERROR_CUSTOM; return }
    const labels = this.question.multiSelect ? [...this.selected].sort((a, b) => a - b).map((i) => this.options[i]!.label) : []
    // Always carried: `custom` is non-empty past the guard above.
    this.pushAnswer({ id: this.question.id, selected: labels, custom })
  }

  private pushAnswer(item: AskUserQuestionAnswerItem): void {
    this.answers.push(item)
    this.index += 1
    this.cursor = 0
    this.error = ''
    this.selected.clear()
    this.input.setValue('')
    this.headerPage = IDLE_PAGE
    this.selectedPage = IDLE_PAGE
    if (this.index >= this.request.questions.length) { this.finish({ answers: this.answers }); return }
    this.mode = this.options.length > 0 ? 'options' : 'custom'
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const header = this.headerRows(safe)
    const footer = this.footerRows(safe)
    const position = this.mode === 'options' && this.options.length > MAX_VISIBLE
      ? [p.dim(truncateToWidth(`${this.cursor + 1}/${this.options.length}`, safe, '…'))]
      : []
    // Old-TUI budget: the body keeps its floor, the header takes the rest.
    const floor = this.mode === 'options' ? 4 : 1
    const available = this.maxHeight() - 2 - position.length - footer.length
    const compacted = compactHeader(header.map((row) => row.text), Math.max(1, available - floor), this.headerPage)
    this.headerPage = compacted.page
    const budget = Math.max(floor, available - compacted.rows.length)
    const rows: string[] = ['', panelRule('question', safe, p)]
    rows.push(...compacted.rows.map((text, i) => {
      // Past the windowed rows sits compactHeader's own status row — dim, and
      // the one header row long enough to need truncating.
      const source: HeaderRow | undefined = header[compacted.page.offset + i]
      return source === undefined || source.dim ? p.dim(truncateToWidth(text, safe, '…')) : text
    }))
    rows.push('')
    if (this.mode === 'custom') {
      rows.push(...this.input.render(safe).map((row) => truncateToWidth(row, safe, '…')))
    } else {
      const windowed = windowBlocks(this.options.map((option, i) => this.optionRows(i, option, safe)), this.cursor, budget, MAX_VISIBLE, this.selectedPage)
      this.selectedPage = windowed.page
      if (windowed.hiddenBefore > 0) rows.push(p.dim(truncateToWidth(`↑ ${windowed.hiddenBefore} more`, safe, '…')))
      rows.push(...windowed.visible.flat().map((row) => truncateToWidth(row, safe, '…')))
      if (windowed.hiddenAfter > 0) rows.push(p.dim(truncateToWidth(`↓ ${windowed.hiddenAfter} more`, safe, '…')))
    }
    rows.push(...position, ...footer)
    return rows
  }

  /** Counter + question + detail as PLAIN rows: compactHeader windows them
   * before any styling, so a slice can never split an SGR pair. */
  private headerRows(width: number): HeaderRow[] {
    const total = this.request.questions.length
    const unanswered = total - this.answers.length
    const headerSuffix = this.question.header === undefined ? '' : ` · ${displayText(this.question.header)}`
    const rows: HeaderRow[] = wrapPlain(`Question ${this.index + 1}/${total} (${unanswered} unanswered)${headerSuffix}`, width).map((text) => ({ text, dim: true }))
    rows.push(...wrapPlain(displayText(this.question.question), width).map((text) => ({ text, dim: false })))
    if (this.question.detail !== undefined) {
      rows.push({ text: '', dim: false })
      rows.push(...wrapPlain(displayText(this.question.detail), width).map((text) => ({ text, dim: false })))
    }
    return rows
  }

  private footerRows(width: number): string[] {
    const p = this.palette
    const hint = this.mode === 'custom' ? this.customHint() : HINT_OPTIONS.join(' • ')
    const rows = ['', p.dim(truncateToWidth(hint, width, '…'))]
    if (this.error !== '') rows.push(p.error(truncateToWidth(this.error, width, '…')))
    return rows
  }

  private customHint(): string {
    const counter = this.question.multiSelect ? `${this.selected.size} selected • ` : ''
    return `${counter}Enter submit • ${this.options.length > 0 ? 'Esc options' : 'Esc cancel'}`
  }

  private optionRows(i: number, option: { label: string; description?: string }, width: number): string[] {
    const p = this.palette
    const cursor = i === this.cursor ? '›' : ' '
    const mark = this.question.multiSelect ? (this.selected.has(i) ? '[x] ' : '[ ] ') : ''
    const prefix = ` ${cursor} ${i + 1}. ${mark}`
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
