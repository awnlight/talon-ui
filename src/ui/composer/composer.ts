/** Borderless composer: our own state rule above (doubles as the status
 * indicator — zero extra rows for a spinner), the pi-tui Editor with its
 * frame suppressed via render() subclass, a dim contextual hint line below
 * (discoverability is a first-class ergonomic requirement, spec D5/§4.3). */
import { Container, Editor, Text, type TUI } from '@earendil-works/pi-tui'
import type { Palette } from '../../theme/palette.js'

export type ComposerState = 'idle' | 'streaming' | 'waiting'

/** Marks upstream border rows for removal. Border rows are the ONLY output
 * borderColor touches (verified pi-tui 0.84.1 editor.js:382,410,461), and
 * content rows cannot start with \x00 (Editor inserts only charCode >= 32),
 * so filtering by leading sentinel strips exactly the frame — with or
 * without autocomplete rows appended after the bottom border. */
const BORDER_SENTINEL = '\x00'

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
      /* v8 ignore next 7 -- the built-in select-list overlay never renders: composer.ts never calls editor.setAutocompleteProvider, so pi-tui's requestAutocomplete() returns before ever invoking these formatters (verified against pi-tui 0.84.1's Editor.requestAutocomplete). Wired up once a future task adds slash-command/autocomplete support. */
      selectList: {
        selectedPrefix: (s) => palette.accent(s),
        selectedText: (s) => palette.selected(s),
        description: (s) => palette.dim(s),
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
}
