/** The approval prompt (spec §4.4, D9): dsh's FIRST terminal approval UI.
 * Live panel — renders fresh every frame (it is the mutating tail; the
 * committed-cell cache law does not apply). Every row is width-truncated:
 * an over-wide row crashes TuiMainScreen (hard constraint). */
import { matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { displayText, type Palette } from '../../theme/palette.js'
import { panelRule } from './panel-rule.js'

export interface ApprovalPrompt { toolName: string; preview?: string; reason?: string; cwd: string }

const OPTIONS: { key: string; label: string; outcome: ApprovalOutcome }[] = [
  { key: '1', label: 'allow once', outcome: 'allowed-once' },
  { key: '2', label: 'reject', outcome: 'rejected' },
]
const CANCEL_HINT = 'esc cancel'

export class ApprovalPanel implements Component {
  private highlighted = 0
  private done = false

  constructor(
    private readonly prompt: ApprovalPrompt,
    private readonly finish: (outcome: ApprovalOutcome) => void,
    private readonly palette: Palette,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (this.done) return
    for (const [i, option] of OPTIONS.entries()) {
      if (matchesKey(data, option.key as never)) { this.decide(OPTIONS[i]!.outcome); return }
    }
    if (matchesKey(data, 'escape')) { this.decide('cancelled'); return }
    if (matchesKey(data, 'enter')) { this.decide(OPTIONS[this.highlighted]!.outcome); return }
    if (matchesKey(data, 'left') || matchesKey(data, 'up')) this.highlighted = (this.highlighted + OPTIONS.length - 1) % OPTIONS.length
    else if (matchesKey(data, 'right') || matchesKey(data, 'down')) this.highlighted = (this.highlighted + 1) % OPTIONS.length
  }

  private decide(outcome: ApprovalOutcome): void {
    this.done = true
    this.finish(outcome)
  }

  render(width: number): string[] {
    const p = this.palette
    const safe = Math.max(1, width)
    const head = `◇ ${displayText(this.prompt.toolName)}${this.prompt.preview === undefined ? '' : ` · ${displayText(this.prompt.preview)}`}`
    const meta = `  ${displayText(this.prompt.cwd)}${this.prompt.reason === undefined ? '' : ` · ${displayText(this.prompt.reason)}`}`
    const options = OPTIONS.map((option, i) => {
      const cell = `[${option.key}] ${option.label}`
      return i === this.highlighted ? p.bold(p.accent(cell)) : p.dim(cell)
    }).join('   ')
    return [
      '',
      panelRule('approval', safe, p),
      truncateToWidth(p.warning(head), safe, '…'),
      p.dim(truncateToWidth(meta, safe, '…')),
      truncateToWidth(`  ${options}   ${p.dim(CANCEL_HINT)}`, safe, '…'),
    ]
  }
}
