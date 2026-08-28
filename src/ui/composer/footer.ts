/** The bottom metrics line (spec §4.3): a left/right split under the hint.
 *
 * `${cwd} · ${git} · ${model} · ${cache} · ${context}`   `${queued}`
 *
 * An absent value vanishes TOGETHER WITH its separator — the whole point of
 * the template is that a session with no usage yet reads as a clean path, not
 * as a row of zeros and stray dots. On a narrow terminal the LEFT side gives
 * way first: the queued badge is the one thing a user needs to see even when
 * nothing else fits. */
import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui'
import { displayText, type Palette } from '../../theme/palette.js'

export interface FooterView {
  cwd: string | undefined
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

export class Footer implements Component {
  private view: FooterView = { cwd: undefined, branch: undefined, model: undefined, cachePercent: undefined, contextPercent: undefined, queued: 0, agents: 0 }

  constructor(private readonly palette: Palette) {}

  set(view: FooterView): void { this.view = view }
  invalidate(): void {}

  render(width: number): string[] {
    const safe = Math.max(1, width)
    const { cwd, branch, model, cachePercent, contextPercent, queued, agents } = this.view
    const left = [
      cwd, branch, model,
      cachePercent === undefined ? undefined : `cache ${cachePercent}%`,
      contextPercent === undefined ? undefined : `${contextPercent}% ctx`,
    ].filter((part): part is string => part !== undefined && part !== '')
      .map(displayText)
      .join(SEPARATOR)
    const right = [
      agents > 0 ? `⚙ ${agents} agent${agents === 1 ? '' : 's'}` : undefined,
      queued > 0 ? `⏳ ${queued} queued` : undefined,
    ].filter((part): part is string => part !== undefined).join(SEPARATOR)
    if (right === '') return [this.palette.dim(truncateToWidth(left, safe, '…'))]

    const rightWidth = visibleWidth(right)
    // The badge is never the thing that gets cut.
    if (rightWidth >= safe) return [this.palette.dim(truncateToWidth(right, safe, '…'))]
    const room = safe - rightWidth - GAP
    const cut = room <= 0 ? '' : truncateToWidth(left, room, '…')
    const pad = ' '.repeat(Math.max(0, safe - rightWidth - visibleWidth(cut)))
    return [this.palette.dim(`${cut}${pad}${right}`)]
  }
}
