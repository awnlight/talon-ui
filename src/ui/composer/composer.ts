/** Borderless composer: our own state rule above (doubles as the status
 * indicator — zero extra rows for a spinner), the pi-tui Editor with its
 * frame suppressed via render() subclass, a dim contextual hint line below
 * (discoverability is a first-class ergonomic requirement, spec D5/§4.3). */
import { Container, Editor, Text, type AutocompleteProvider, type TUI } from '@earendil-works/pi-tui'
import type { Palette } from '../../theme/palette.js'
import { Footer, type FooterView } from './footer.js'
import { Gutter } from '../gutter.js'

export type ComposerState = 'idle' | 'streaming' | 'waiting'

/** Marks upstream border rows for removal. Border rows are the ONLY output
 * borderColor touches (verified pi-tui 0.84.1 editor.js:382,410,461), and
 * content rows cannot start with \x00 (Editor inserts only charCode >= 32),
 * so filtering by leading sentinel strips exactly the frame — with or
 * without autocomplete rows appended after the bottom border. */
const BORDER_SENTINEL = '\x00'

/** The one keystroke that re-queries an OPEN completion menu while changing
 * nothing: a right arrow at the very end of the text hits pi-tui's "can't
 * move" branch (editor.js:1535-1541) and then re-runs the provider
 * (editor.js:1567-1568). */
const CURSOR_RIGHT = '\x1b[C'

/** The prompt, and the phase glyphs that replace it IN PLACE while a turn runs
 * (spec §4.3) — no extra row, no extra column, no spinner. */
export type GlyphPhase = 'idle' | 'wait' | 'thinking' | 'responding' | 'tools' | 'compacting'
const GLYPHS: Record<GlyphPhase, string> = {
  idle: '❯', wait: '◌', thinking: '◍', responding: '◉', tools: '⚙', compacting: '⊙',
}
const PROMPT_WIDTH = 2                 // the glyph plus its one space
/** One timer, 50ms, running ONLY while a turn is: idle costs zero CPU. */
const GLYPH_TICK_MS = 50
/** A phase change fades its new glyph in over this long, so a transition
 * never reads as a flicker. */
const FADE_MS = 300
/** The breathing period the fade rides on. */
const BREATHE_MS = 1400
/** Below this the glyph is not drawn at all — a real fade, not a blink. */
const MIN_OPACITY = 0.12

class FramelessEditor extends Editor {
  /** Supplied by the Composer: the `❯`/phase glyph column. The editor lays
   * itself out `PROMPT_WIDTH` narrower and every row is shifted right by it,
   * so the prompt sits on the input line itself and pi-tui's cursor marker —
   * a positional marker inside the row — moves with the text. */
  prompt!: () => string          // assigned by the Composer that builds it

  render(width: number): string[] {
    const rows = super.render(Math.max(1, width - PROMPT_WIDTH)).filter((row) => !row.startsWith(BORDER_SENTINEL))
    const indent = ' '.repeat(PROMPT_WIDTH)
    return rows.map((row, i) => (i === 0 ? this.prompt() : indent) + row)
  }
}

export class Composer {
  readonly container = new Container()
  readonly editor: Editor
  onSubmit: ((text: string) => void) | undefined
  private state: ComposerState = 'idle'
  private readonly hint: Text
  private readonly footerLine: Footer
  private phase: GlyphPhase = 'idle'
  private phaseSince = 0
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly tui: TUI, private readonly palette: Palette) {
    this.editor = new FramelessEditor(tui, {
      borderColor: (s) => BORDER_SENTINEL + s, // marks border rows for FramelessEditor.render() to filter
      selectList: {
        /* v8 ignore next -- pi-tui declares selectedPrefix in SelectListTheme but never calls it: the name appears nowhere in pi-tui 0.84.1's shipped JS, only in the interface declaration (components/select-list.d.ts:8) — SelectList.renderItem styles the selected row through selectedText instead */
        selectedPrefix: (s) => palette.accent(s),
        selectedText: (s) => palette.selected(s),
        description: (s) => palette.dim(s),
        scrollInfo: (s) => palette.dim(s),
        /* v8 ignore next -- unreachable behind createCompletionProvider: noMatch renders only for an EMPTY item list — the provider answers null instead, which closes the menu before any row renders (editor.js:1897-1900) */
        noMatch: (s) => palette.dim(s),
      },
    }, { paddingX: 0 })
    this.editor.onSubmit = (text) => { if (text.trim() !== '') this.onSubmit?.(text) }
    ;(this.editor as FramelessEditor).prompt = () => this.promptCell()
    this.hint = new Text('', 0, 0)
    // Fourth child of the composer container, so it rides with the composer
    // through a D8 rebind exactly as the rule and the hint do.
    this.footerLine = new Footer(palette)
    // The rule DIVIDES and the editor carries the caret, so both keep column
    // 0; the hint and the footer are content and join the gutter (gutter.ts).
    this.container.addChild(this.ruleComponent())
    this.container.addChild(this.editor)
    this.container.addChild(new Gutter(this.hint))
    this.container.addChild(new Gutter(this.footerLine))
  }

  setFooter(view: FooterView): void { this.footerLine.set(view) }

  /** The live phase (spec §4.3). A CHANGE restarts the fade, so the new glyph
   * arrives smoothly instead of snapping. */
  setPhase(phase: GlyphPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.phaseSince = Date.now()
  }

  /** The single animation timer (ruling 11): started when a turn starts,
   * stopped when it ends, `unref`'d so it can never hold the process open. */
  setAnimating(animating: boolean): void {
    if (animating === (this.timer !== undefined)) return
    if (!animating) {
      clearInterval(this.timer)
      this.timer = undefined
      return
    }
    this.phaseSince = Date.now()
    this.timer = setInterval(() => this.tui.requestRender(), GLYPH_TICK_MS)
    this.timer.unref()
  }

  /** Stop the timer on teardown; the controller's disposer calls this. */
  dispose(): void { this.setAnimating(false) }

  /** The prompt column: `❯ ` at rest, the phase glyph while a turn runs. The
   * fade is truecolor-only — an ANSI-16 terminal has no shades of dim to fade
   * THROUGH, so it gets the envelope-gated steady glyph instead (spec §4.3). */
  private promptCell(): string {
    const glyph = GLYPHS[this.phase]
    if (this.phase === 'idle') return `${this.palette.dim(glyph)} `
    // The fade exists to smooth an ANIMATED transition; with no timer running
    // there is nothing to smooth, and a static frame must show its glyph.
    const elapsed = this.timer === undefined ? FADE_MS : Date.now() - this.phaseSince
    const envelope = Math.min(1, elapsed / FADE_MS)
    if (!this.palette.trueColor) return `${envelope < MIN_OPACITY ? ' ' : this.palette.dim(glyph)} `
    const breathe = 0.55 + 0.45 * Math.cos((elapsed / BREATHE_MS) * 2 * Math.PI)
    const opacity = envelope * breathe
    if (opacity < MIN_OPACITY) return '  '
    const level = Math.round(0x33 + opacity * (0xbb - 0x33))
    return `\x1b[38;2;${level};${level};${level}m${glyph}\x1b[39m `
  }

  private ruleComponent(): Text {
    const self = this
    return new (class extends Text {
      render(width: number): string[] {
        return [self.ruleLine(width)]
      }
      invalidate(): void {}
    })('', 0, 0)
  }

  private ruleLine(width: number): string {
    const bar = '─'.repeat(Math.max(1, width))
    switch (this.state) {
      case 'streaming': return this.palette.accent(bar)
      case 'waiting': return this.palette.warning(bar)
      default: return this.palette.dim(bar)
    }
  }

  setState(state: ComposerState): void { this.state = state }
  setHint(text: string): void { this.hint.setText(this.palette.dim(text)) }
  /** One-shot toned hint (T2 carryover 3): the next setHint() — every
   * agent/status transition issues one — restores the dim contract. */
  flashHint(text: string, tone: 'warning'): void { this.hint.setText(this.palette[tone](text)) }

  /** Wire the ONE completion provider (spec §3.5 discovery). pi-tui asks it on
   * every keystroke, so a closure-backed provider always offers the sources as
   * they stand right now. */
  attachCompletion(provider: AutocompleteProvider): void { this.editor.setAutocompleteProvider(provider) }

  /** Re-query a menu that is ALREADY open — what a `commands/change` arriving
   * under a visible menu needs (the provider itself needs no rebuild). Not the
   * plan's `handleInput('\t')`: with a menu open, Tab APPLIES the highlighted
   * completion and closes the menu (editor.js:540-553; probed against pi-tui
   * 0.84.1, a bare '/' became '/exit '). */
  refreshCompletion(): void {
    if (!this.editor.isShowingAutocomplete()) return
    const { line, col } = this.editor.getCursor()
    // Only when the cursor sits at the very end of the text — the text from its
    // line onward is `col` long only there (a later line adds at least the
    // joining newline). Anywhere else the arrow would really move the cursor.
    if (this.editor.getLines().slice(line).join('\n').length === col) this.editor.handleInput(CURSOR_RIGHT)
  }
}
