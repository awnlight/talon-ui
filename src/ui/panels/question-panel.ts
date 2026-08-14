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
