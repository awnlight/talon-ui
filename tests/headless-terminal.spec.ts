import { describe, expect, it } from 'vitest'
import { Text, TuiMainScreen } from '@earendil-works/pi-tui'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'

describe('HeadlessTerminal', () => {
  it('counts synchronized frames and resolves waitForFrame', async () => {
    const term = new HeadlessTerminal(40, 10)
    const tui = new TuiMainScreen(term)
    tui.addChild(new Text('hello', 0, 0))
    tui.start()
    await term.waitForFrame(0)
    expect(term.frames).toBeGreaterThan(0)
    tui.stop()
  })

  it('snapshots text content and dimensions semantically', async () => {
    const term = new HeadlessTerminal(40, 10)
    const tui = new TuiMainScreen(term)
    tui.addChild(new Text('hello talon', 0, 0))
    tui.start()
    await term.waitForFrame(0)
    tui.stop()
    const snap = term.snapshot()
    expect(snap).toContain('terminal 40x10')
    expect(snap).toContain('"hello talon"')
    expect(snap).toContain('lifecycle started=1 stopped=1')
  })

  it('flags truecolor as a theme violation, accepts ANSI-16', async () => {
    const p = createPalette(true, 'dark')
    const term = new HeadlessTerminal(40, 10)
    const tui = new TuiMainScreen(term)
    tui.addChild(new Text(p.accent('ansi ok'), 0, 0))
    tui.addChild(new Text('\x1b[38;2;45;212;191mtruecolor\x1b[39m', 0, 0))
    tui.start()
    await term.waitForFrame(0)
    tui.stop()
    const violations = term.themeViolations()
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((v) => v.endsWith('rgb-fg'))).toBe(true)
  })

  it('times out with a named error if a frame never completes', async () => {
    const term = new HeadlessTerminal(40, 10)
    await expect(term.waitForFrame(0, 50)).rejects.toThrow(/frame 1/)
  })

  it('exercises the pass-through Terminal methods and reflects title/progress/cursor in the snapshot header', async () => {
    const term = new HeadlessTerminal(40, 10)
    let resized = false
    term.start(() => {}, () => { resized = true })
    term.moveBy(1)
    term.clearLine()
    term.clearFromCursor()
    term.clearScreen()
    await term.drainInput()
    term.triggerResize()
    expect(resized).toBe(true)
    expect(term.kittyProtocolActive).toBe(false)
    term.setTitle('my title')
    term.setProgress(true)
    term.hideCursor()
    let snap = term.snapshot()
    expect(snap).toContain('title "my title"')
    expect(snap).toContain('progress=active')
    expect(snap).toContain('cursor hidden')
    term.showCursor()
    snap = term.snapshot()
    expect(snap).toContain('cursor visible')
  })

  it('waitForFrame keeps an unsatisfied waiter pending when a satisfied one resolves (waiter-filter branch)', async () => {
    const term = new HeadlessTerminal(40, 10)
    const satisfied = term.waitForFrame(0)
    const unsatisfied = term.waitForFrame(5, 30) // needs frame 6+; only frame 1 completes below
    term.write('hello\x1b[?2026l')
    await satisfied
    await expect(unsatisfied).rejects.toThrow(/frame 6/)
  })

  it('waitForFrame resolves immediately (fast path) when the requested frame already completed', async () => {
    const term = new HeadlessTerminal(40, 10)
    term.write('hello\x1b[?2026l')
    await term.waitForFrame(0) // slow path: frame 1 not done yet at call time
    await expect(term.waitForFrame(0)).resolves.toBeUndefined() // fast path: frame 1 already done
  })

  it('reports the alternate screen buffer when active', async () => {
    const term = new HeadlessTerminal(40, 10)
    term.write('\x1b[?1049h\x1b[?2026l') // enter the alternate screen buffer
    await term.waitForFrame(0)
    expect(term.snapshot()).toContain('buffer=alternate')
  })

  it('marks an auto-wrapped continuation row with the ~ suffix', async () => {
    const term = new HeadlessTerminal(40, 10)
    term.write('x'.repeat(45) + '\x1b[?2026l') // wider than 40 cols: wraps onto the next row
    await term.waitForFrame(0)
    expect(term.snapshot()).toMatch(/"\s~$/m)
  })

  it('cellLabel and themeViolations recognize every fg/bg color class and strikethrough', async () => {
    const term = new HeadlessTerminal(40, 10)
    const rows = [
      '\x1b[38;2;10;20;30mrgbfg\x1b[0m', // rgb-fg
      '\x1b[48;2;10;20;30mrgbbg\x1b[0m', // rgb-bg
      '\x1b[38;5;200mextfg\x1b[0m', // extended-fg (256-color index > 15)
      '\x1b[48;5;200mextbg\x1b[0m', // extended-bg (256-color index > 15)
      '\x1b[41mbasicbg\x1b[0m', // basic bg (palette index <= 15): also themeViolations' explicit-bg
      '\x1b[9mstrike\x1b[0m', // strikethrough
    ]
    term.write(rows.join('\r\n') + '\x1b[?2026l')
    await term.waitForFrame(0)
    const snap = term.snapshot()
    expect(snap).toMatch(/\brgb-fg\b/)
    expect(snap).toMatch(/\brgb-bg\b/)
    expect(snap).toMatch(/\bextended-fg-200\b/)
    expect(snap).toMatch(/\bextended-bg-200\b/)
    expect(snap).toMatch(/\bbg-1\b/)
    expect(snap).toMatch(/\bstrike\b/)
    const violations = term.themeViolations()
    expect(violations.some((v) => v.endsWith('rgb-fg'))).toBe(true)
    expect(violations.some((v) => v.endsWith('rgb-bg'))).toBe(true)
    expect(violations.some((v) => v.endsWith('extended-fg-200'))).toBe(true)
    expect(violations.some((v) => v.endsWith('extended-bg-200'))).toBe(true)
    expect(violations.some((v) => v.endsWith('explicit-bg'))).toBe(true)
  })
})
