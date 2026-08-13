import { describe, expect, it } from 'vitest'
import { Text, TuiMainScreen } from '@earendil-works/pi-tui'
import { HeadlessTerminal, renderAfter } from '../src/testing/headless-terminal.ts'
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
})
