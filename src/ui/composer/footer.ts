/** The bottom metrics line (spec §4.3): a left/right split under the hint.
 *
 * `${project} · ${git} · ${model} · ${cache} · ${context}`   `${agents} ${queued}`
 *
 * An absent value vanishes TOGETHER WITH its separator — the whole point of
 * the template is that a session with no usage yet reads as a clean name, not
 * as a row of zeros and stray dots. On a narrow terminal the LEFT side gives
 * way first: the badges are the one thing a user needs to see even when
 * nothing else fits.
 *
 * Two things the first cut got wrong, both about how scarce this row is:
 *
 *   - it spent 44 of ~90 columns on the FULL working directory, so the
 *     segments that actually change during a session were crowded into the
 *     right half. The footer now shows the project NAME (`projectName`); the
 *     path itself moved to the boot banner, which is read once and has room.
 *   - it toned the whole row `dim`, which made an idle path, the model, and a
 *     context window at 94% all exactly as loud as each other. Tone now
 *     follows rank: the terminal's own foreground for identity (project,
 *     branch), `brand` for the model — the one setting that changes what every
 *     turn costs and says — `dim` for reference values, and a THRESHOLD tone
 *     for context occupancy, which is the number that turns into a problem.
 *     Separators stay dim so the row still reads as one line, not five chips.
 */
import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'

export interface FooterView {
  /** The project NAME, not its path (see the module comment). */
  project: string | undefined
  branch: string | undefined
  model: string | undefined
  cachePercent: number | undefined
  contextPercent: number | undefined
  queued: number
  /** Subagents running right now (spec §3.9). Live and ephemeral: a replayed
   * log can never light this, only live `subagent/start` can. */
  agents: number
}

const SEPARATOR = ' · '
const GAP = 2
/** Where a context window stops being reference and starts being news. */
const CONTEXT_WARN = 75
const CONTEXT_ALARM = 90

export class Footer implements Component {
  private view: FooterView = { project: undefined, branch: undefined, model: undefined, cachePercent: undefined, contextPercent: undefined, queued: 0, agents: 0 }

  constructor(private readonly palette: Palette) {}

  set(view: FooterView): void { this.view = view }
  invalidate(): void {}

  /** Occupancy earns a louder tone as it approaches the wall — the one number
   * here that becomes actionable rather than merely informative. */
  private contextTone(percent: number): (s: string) => string {
    if (percent >= CONTEXT_ALARM) return this.palette.error
    if (percent >= CONTEXT_WARN) return this.palette.warning
    return this.palette.dim
  }

  render(width: number): string[] {
    const safe = Math.max(1, width)
    const p = this.palette
    const { project, branch, model, cachePercent, contextPercent, queued, agents } = this.view
    const paint = (value: string | undefined, tone: (s: string) => string): string | undefined =>
      value === undefined || value === '' ? undefined : tone(displayText(value))
    const left = [
      paint(project, p.text),
      paint(branch, p.dim),
      paint(model, p.brand),
      cachePercent === undefined ? undefined : p.dim(`cache ${cachePercent}%`),
      contextPercent === undefined ? undefined : this.contextTone(contextPercent)(`${contextPercent}% ctx`),
    ].filter((part): part is string => part !== undefined).join(p.dim(SEPARATOR))
    const right = [
      agents > 0 ? p.accent(`⚙ ${agents} agent${agents === 1 ? '' : 's'}`) : undefined,
      queued > 0 ? p.warning(`⏳ ${queued} queued`) : undefined,
    ].filter((part): part is string => part !== undefined).join(p.dim(SEPARATOR))
    if (right === '') return [truncateToWidth(left, safe, '…')]

    const rightWidth = visibleWidth(right)
    // The badges are never the thing that gets cut.
    if (rightWidth >= safe) return [truncateToWidth(right, safe, '…')]
    const room = safe - rightWidth - GAP
    const cut = room <= 0 ? '' : truncateToWidth(left, room, '…')
    const pad = ' '.repeat(Math.max(0, safe - rightWidth - visibleWidth(cut)))
    return [`${cut}${pad}${right}`]
  }
}
