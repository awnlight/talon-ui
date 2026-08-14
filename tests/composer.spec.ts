import { describe, expect, it, vi } from 'vitest'
import { Editor, TuiMainScreen } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { Composer } from '../src/ui/composer/composer.ts'

function setup() {
  const term = new HeadlessTerminal(60, 12)
  const tui = new TuiMainScreen(term)
  const palette = createPalette(true)
  const composer = new Composer(tui, palette)
  tui.addChild(composer.container)
  tui.setFocus(composer.editor)
  return { term, tui, composer }
}

describe('Composer', () => {
  it('renders a full-width state rule and a hint line', async () => {
    const { term, tui, composer } = setup()
    composer.setHint('enter send · / commands')
    tui.start()
    await term.waitForFrame(0)
    tui.stop()
    const snap = term.snapshot()
    expect(snap).toContain('─'.repeat(60))
    expect(snap).toContain('enter send')
  })
  it('submit fires onSubmit with typed text', async () => {
    const { term, tui, composer } = setup()
    const got: string[] = []
    composer.onSubmit = (t) => got.push(t)
    tui.start()
    await term.waitForFrame(0)
    term.input('hello')
    term.input('\r')
    tui.stop()
    expect(got).toEqual(['hello'])
  })
  it('state changes recolor the rule', async () => {
    const { term, tui, composer } = setup()
    tui.start()
    await term.waitForFrame(0)
    const before = term.frames
    composer.setState('streaming')
    tui.requestRender()
    await term.waitForFrame(before)
    tui.stop()
    // accent = ANSI 95 → xterm palette index 13 (bright magenta)
    expect(term.snapshot()).toMatch(/style 0-\d+ fg-13/)
  })
  it('waiting state recolors the rule with the warning tone', async () => {
    const { term, tui, composer } = setup()
    tui.start()
    await term.waitForFrame(0)
    const before = term.frames
    composer.setState('waiting')
    tui.requestRender()
    await term.waitForFrame(before)
    tui.stop()
    // warning = ANSI 33 → xterm palette index 3 (yellow)
    expect(term.snapshot()).toMatch(/style 0-\d+ fg-3\b/)
  })
  it('container.invalidate() cascades to the rule component without throwing', () => {
    const { composer } = setup()
    expect(() => composer.container.invalidate()).not.toThrow()
  })
  // Pins the upstream frame shape FramelessEditor depends on. Verified
  // empirically against pi-tui 0.84.1 (see task-7-report.md): Editor.render()
  // always emits exactly one top border row, N>=1 content rows, and exactly
  // one bottom border row — unconditionally of focus or scroll state (only the
  // hardware-cursor marker depends on focus). If a future pi-tui version
  // changes that shape (e.g. adds a second border row, or omits one), this
  // test fails instead of silently slicing off content.
  it('drops exactly the upstream top/bottom border rows, nothing else', () => {
    const { tui, composer } = setup()
    const framed = new Editor(
      tui,
      {
        borderColor: (s: string) => s,
        selectList: {
          selectedPrefix: (s: string) => s,
          selectedText: (s: string) => s,
          description: (s: string) => s,
          scrollInfo: (s: string) => s,
          noMatch: (s: string) => s,
        },
      },
      { paddingX: 0 },
    )
    const borderlessRows = composer.editor.render(60) // composer.editor is focused (setup())
    tui.setFocus(framed) // match focus so the cursor marker doesn't skew the comparison
    const framedRows = framed.render(60)
    expect(framedRows[0]).toBe('─'.repeat(60))
    expect(framedRows[framedRows.length - 1]).toBe('─'.repeat(60))
    expect(framedRows.length).toBe(borderlessRows.length + 2)
    expect(borderlessRows).toEqual(framedRows.slice(1, -1))
  })
  it('keeps autocomplete rows and drops exactly the two border rows (T2 carryover 1)', async () => {
    const term = new HeadlessTerminal(60, 20)
    const tui = new TuiMainScreen(term)
    const palette = createPalette(false)
    const composer = new Composer(tui, palette)
    composer.editor.setAutocompleteProvider({
      async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
        const before = (lines[cursorLine] ?? '').slice(0, cursorCol)
        if (!before.startsWith('/')) return null
        return { items: [{ value: 'help', label: 'help', description: 'list commands' }, { value: 'status', label: 'status' }], prefix: before }
      },
      applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
    })
    tui.setFocus(composer.editor)
    tui.start()
    term.input('/')
    await vi.waitFor(() => expect(composer.editor.isShowingAutocomplete()).toBe(true))
    const rows = composer.editor.render(58)
    const text = rows.join('\n')
    expect(text).toContain('help')                    // completion rows survive
    expect(text).toContain('status')
    expect(rows.some((r) => /─{10,}/.test(r))).toBe(false) // no border row leaked into the middle
    expect(text).not.toContain('\x00')                // sentinel never escapes
    tui.stop()
  })
})
