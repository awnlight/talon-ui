/** Borderless composer: our own state rule above (doubles as the status
 * indicator — zero extra rows for a spinner), the pi-tui Editor with its
 * frame suppressed via render() subclass, a dim contextual hint line below
 * (discoverability is a first-class ergonomic requirement, spec D5/§4.3). */
import { Container, Editor, Text, type TUI } from '@earendil-works/pi-tui'
import type { Palette } from '../../theme/palette.js'

export type ComposerState = 'idle' | 'streaming' | 'waiting'

class FramelessEditor extends Editor {
  render(width: number): string[] {
    const rows = super.render(width)
    // Empirically verified against pi-tui 0.84.1 (task-7-report.md): Editor
    // unconditionally frames its content with exactly one top border row and
    // one bottom border row — present regardless of focus or scroll state
    // (only the hardware-cursor marker depends on focus). Drop both; our
    // composer renders its own state rule instead. Content rows are
    // untouched so wrap math stays upstream's.
    if (rows.length >= 2) return rows.slice(1, -1)
    return rows
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
      borderColor: (s) => s, // border rows are dropped; color is irrelevant
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
