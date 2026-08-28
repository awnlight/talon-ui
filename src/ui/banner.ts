/** The boot banner (spec D6: 启动 wordmark 渐变) — talon's brand entry, and
 * the ONE place the full working directory is spelled out.
 *
 * It is a transcript CELL, not a permanent child of the TUI: TuiMainScreen
 * renders into the main screen and its scrollback (tui-main-screen.js:40), so
 * a banner mounted as the transcript's first cell scrolls away as the session
 * grows instead of holding five rows hostage forever.
 *
 * Layout — the mark on the left, three facts on the right, the text block
 * vertically centred against the mark so the pair reads as one object:
 *
 *     ▄████▄   ▗█
 *    ██ █████▄▗██    talon  v0.1.0
 *    ████████████▘   deepseek-v4-pro
 *    ▝█████████▘     ~/proj/app
 *     █ █ █
 *
 * Three tones, three ranks: the brand ramp for the mark and the wordmark,
 * the terminal's own foreground for the one fact that changes what the
 * session DOES (the model), dim for everything a user reads once and forgets.
 */
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { brandGradient, brandGrid, displayText, type Palette } from '../theme/palette.js'
import { CachedCell } from './transcript/cells.js'

/** dsh's whale wearing talon's claws. Drawn on a 2×2-pixel-per-cell quadrant
 * grid (`docs/` has the source grid) so every feature — the eye gap, the three
 * claws — lands on an EVEN pixel boundary and survives the block-glyph
 * downsample; an odd-aligned feature smears across two cells and reads as
 * noise, which is exactly how the first drafts failed. */
export const MARK: readonly string[] = [
  '  ▄████▄   ▗█',
  ' ██ █████▄▗██',
  ' ████████████▘',
  ' ▝█████████▘',
  '  █ █ █',
]

/** Columns between the mark and the text block. */
const GAP = 3
/** Below this much room for text the mark is dropped entirely — a wrapped or
 * truncated mark is worse than no mark. */
const MIN_TEXT_WIDTH = 24
/** Which mark rows the three text lines sit beside (centred against 5 rows). */
const TEXT_TOP = 1

export interface BannerView {
  /** talon's own version. Absent when package.json could not be read — the
   * segment then vanishes, rather than asserting a version that is not true.
   * Same law as the footer's: an absent value is absent, never a zero. */
  version: string | undefined
  /** The active model. Absent before anything has declared one — the segment
   * then vanishes with its separator, exactly as the footer's does. */
  model: string | undefined
  /** The full working directory. The banner is where a path BELONGS: the
   * footer carries only the basename, because bottom-bar width is the
   * scarcest space in the UI and a 47-column path spends half of it. */
  cwd: string
  /** Boot notices — a degraded composition, a missing service. Rendered under
   * the banner, toned, one row each. */
  notes?: readonly { text: string; tone: 'warning' | 'error' | 'info' }[]
}

export class BannerCell extends CachedCell {
  constructor(private readonly view: BannerView, private readonly palette: Palette) { super() }

  contentLineCount(): number { return MARK.length + (this.view.notes?.length ?? 0) }

  private textLines(): string[] {
    const p = this.palette
    const { version, model, cwd } = this.view
    // The wordmark carries the gradient (D6); the version is a footnote to it.
    const title = version === undefined
      ? p.bold(brandGradient('talon', p))
      : `${p.bold(brandGradient('talon', p))}  ${p.dim(displayText(`v${version}`))}`
    // The model is the one runtime fact worth the terminal's full foreground.
    const second = model === undefined ? '' : p.text(displayText(model))
    return [title, second, p.dim(displayText(cwd))].filter((line) => line !== '')
  }

  protected renderLines(width: number): string[] {
    const safe = Math.max(1, width)
    const p = this.palette
    const text = this.textLines()
    const markWidth = Math.max(...MARK.map((row) => visibleWidth(row)))
    const rows: string[] = []
    if (safe - markWidth - GAP >= MIN_TEXT_WIDTH) {
      const mark = brandGrid(MARK, p)
      const room = safe - markWidth - GAP
      for (let i = 0; i < MARK.length; i++) {
        const line = text[i - TEXT_TOP]
        const pad = ' '.repeat(markWidth - visibleWidth(MARK[i]!) + GAP)
        rows.push(line === undefined ? mark[i]! : `${mark[i]!}${pad}${truncateToWidth(line, room, '…')}`)
      }
    } else {
      // No room to set the mark beside the text: the facts win.
      rows.push(...text.map((line) => truncateToWidth(line, safe, '…')))
    }
    for (const note of this.view.notes ?? []) {
      const tone = note.tone === 'error' ? p.error : note.tone === 'warning' ? p.warning : p.dim
      const glyph = note.tone === 'info' ? '·' : '⚠'
      rows.push(truncateToWidth(tone(`${glyph} ${displayText(note.text)}`), safe, '…'))
    }
    return rows
  }
}
