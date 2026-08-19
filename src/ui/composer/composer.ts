/** Borderless composer: our own state rule above (doubles as the status
 * indicator — zero extra rows for a spinner), the pi-tui Editor with its
 * frame suppressed via render() subclass, a dim contextual hint line below
 * (discoverability is a first-class ergonomic requirement, spec D5/§4.3). */
import { Container, Editor, Text, type AutocompleteProvider, type TUI } from '@earendil-works/pi-tui'
import type { Palette } from '../../theme/palette.js'

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

class FramelessEditor extends Editor {
  render(width: number): string[] {
    return super.render(width).filter((row) => !row.startsWith(BORDER_SENTINEL))
  }
}

export class Composer {
  readonly container = new Container()
  readonly editor: Editor
  onSubmit: ((text: string) => void) | undefined
  private state: ComposerState = 'idle'
  private readonly hint: Text

  constructor(tui: TUI, private readonly palette: Palette) {
    this.editor = new FramelessEditor(tui, {
      borderColor: (s) => BORDER_SENTINEL + s, // marks border rows for FramelessEditor.render() to filter
      selectList: {
        /* v8 ignore next -- pi-tui declares selectedPrefix in SelectListTheme but never calls it: the name appears nowhere in pi-tui 0.84.1's shipped JS, only in the interface declaration (components/select-list.d.ts:8) — SelectList.renderItem styles the selected row through selectedText instead */
        selectedPrefix: (s) => palette.accent(s),
        selectedText: (s) => palette.selected(s),
        description: (s) => palette.dim(s),
        /* v8 ignore next 2 -- unreachable behind createSlashProvider: scrollInfo needs more items than autocompleteMaxVisible, and noMatch renders only for an EMPTY item list — the provider answers null instead, which closes the menu before any row renders (editor.js:1897-1900) */
        scrollInfo: (s) => palette.dim(s),
        noMatch: (s) => palette.dim(s),
      },
    }, { paddingX: 0 })
    this.editor.onSubmit = (text) => { if (text.trim() !== '') this.onSubmit?.(text) }
    this.hint = new Text('', 0, 0)
    this.container.addChild(this.ruleComponent())
    this.container.addChild(this.editor)
    this.container.addChild(this.hint)
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

  /** Wire slash-command completion (spec §3.5 discovery). pi-tui asks the
   * provider on every keystroke, so a closure-backed one always offers the
   * command list as it stands right now. */
  attachSlashCompletion(provider: AutocompleteProvider): void { this.editor.setAutocompleteProvider(provider) }

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
