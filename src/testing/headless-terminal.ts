/** Test double: a real @xterm/headless emulator behind pi-tui's exact
 * Terminal interface. Snapshots are SEMANTIC terminal state (text and
 * style reported separately), never raw ANSI bytes. Frame boundaries are
 * pi-tui's CSI 2026 synchronized-output end marker, so a snapshot never
 * captures a write-in-progress prefix. (Pattern recovered from the deleted
 * dsh-tui harness; see spec §7.1.) */
import { Terminal as XtermTerminal } from '@xterm/headless'
import type { IBufferCell } from '@xterm/headless'
import type { Terminal } from '@earendil-works/pi-tui'

const FRAME_END = '\x1b[?2026l'

export class HeadlessTerminal implements Terminal {
  private readonly emulator: XtermTerminal
  private inputHandler: ((data: string) => void) | undefined
  private resizeHandler: (() => void) | undefined
  private started = 0
  private stopped = 0
  private title = ''
  private progressActive = false
  private cursorHidden = false
  private frameCount = 0
  private wipes = 0
  private waiters: { after: number; resolve(): void }[] = []

  constructor(private readonly cols = 100, private readonly rowCount = 36) {
    this.emulator = new XtermTerminal({ cols, rows: rowCount, allowProposedApi: true, scrollback: 5000 })
  }

  get frames(): number { return this.frameCount }

  /** ED3 (`\x1b[3J`) occurrences across everything written — the signature of
   * pi-tui's full-redraw scrollback wipe (D10; gated by tests/redraw.spec.ts). */
  get scrollbackWipes(): number { return this.wipes }

  waitForFrame(after: number, timeoutMs = 2000): Promise<void> {
    if (this.frameCount > after) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { after, resolve }
      this.waiters.push(waiter)
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) {
          this.waiters.splice(i, 1)
          reject(new Error(`TUI did not complete frame ${after + 1} within ${timeoutMs}ms`))
        }
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /** Feed raw bytes as if typed. */
  input(data: string): void { this.inputHandler?.(data) }

  // ---- Terminal interface ----
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
    this.started += 1
  }
  stop(): void { this.stopped += 1; this.inputHandler = undefined }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    // Counted on the RAW written stream, before the emulator parses it: the
    // wipe is a property of what the TUI EMITS, not of post-parse state.
    this.wipes += (data.split('\x1b[3J').length - 1)
    // @xterm/headless parses asynchronously (write's 2nd arg is a completion
    // callback per its typings). Frame completion must wait for that callback
    // — otherwise waitForFrame() can resolve before the buffer reflects the
    // write, and a snapshot would race the parser instead of seeing settled
    // state. Verified empirically: buffer.active is still empty synchronously
    // after write(), and even after an `await Promise.resolve()` tick.
    this.emulator.write(data, () => {
      let idx = -1
      while ((idx = data.indexOf(FRAME_END, idx + 1)) >= 0) {
        this.frameCount += 1
        this.waiters = this.waiters.filter((w) => {
          if (this.frameCount > w.after) { w.resolve(); return false }
          return true
        })
      }
    })
  }
  get columns(): number { return this.cols }
  get rows(): number { return this.rowCount }
  get kittyProtocolActive(): boolean { return false }
  moveBy(_lines: number): void {}
  hideCursor(): void { this.cursorHidden = true }
  showCursor(): void { this.cursorHidden = false }
  clearLine(): void { this.emulator.write('\r\x1b[2K') }
  clearFromCursor(): void { this.emulator.write('\x1b[0J') }
  clearScreen(): void { this.emulator.write('\x1b[2J\x1b[H') }
  setTitle(title: string): void { this.title = title }
  setProgress(active: boolean): void { this.progressActive = active }

  triggerResize(): void { this.resizeHandler?.() }

  // ---- semantic serialization ----
  snapshot(): string {
    const buf = this.emulator.buffer.active
    const lines: string[] = []
    lines.push(`terminal ${this.cols}x${this.rowCount} buffer=${this.emulator.buffer.active === this.emulator.buffer.normal ? 'normal' : 'alternate'} length=${buf.length} base=${buf.baseY} viewport=${buf.viewportY}`)
    lines.push(`lifecycle started=${this.started} stopped=${this.stopped} progress=${this.progressActive ? 'active' : 'inactive'}`)
    if (this.title) lines.push(`title "${this.title}"`)
    lines.push(`cursor ${this.cursorHidden ? 'hidden' : 'visible'} @${buf.cursorY},${buf.cursorX}`)
    let blankRun: [number, number] | undefined
    const flushBlanks = () => {
      if (!blankRun) return
      lines.push(blankRun[0] === blankRun[1] ? `${blankRun[0]}| <blank>` : `${blankRun[0]}-${blankRun[1]}| <blank>`)
      blankRun = undefined
    }
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      /* v8 ignore next -- defensive: @xterm/headless's real getLine(y) never returns undefined for y in [0, buf.length), only for out-of-range indices this loop never produces */
      if (!line) continue
      // translateToString(true) only trims cells with no character data; pi-tui
      // pads rows with literal space characters (real cells), so those survive
      // and need an explicit trimEnd(). Verified empirically against pi-tui's
      // Text component output.
      const text = line.translateToString(true).trimEnd()
      if (text.trim() === '') {
        blankRun = blankRun ? [blankRun[0], y] : [y, y]
        continue
      }
      flushBlanks()
      lines.push(`${y}| "${text}"${line.isWrapped ? ' ~' : ''}`)
      lines.push(...this.styleRuns(y))
    }
    flushBlanks()
    return lines.join('\n') + '\n'
  }

  private cellLabel(cell: IBufferCell): string {
    const parts: string[] = []
    if (cell.isFgRGB()) parts.push('rgb-fg')
    else if (cell.isFgPalette() && cell.getFgColor() > 15) parts.push(`extended-fg-${cell.getFgColor()}`)
    else if (cell.isFgPalette()) parts.push(`fg-${cell.getFgColor()}`)
    if (cell.isBgRGB()) parts.push('rgb-bg')
    else if (cell.isBgPalette() && cell.getBgColor() > 15) parts.push(`extended-bg-${cell.getBgColor()}`)
    else if (cell.isBgPalette()) parts.push(`bg-${cell.getBgColor()}`)
    if (cell.isBold()) parts.push('bold')
    if (cell.isDim()) parts.push('dim')
    if (cell.isItalic()) parts.push('italic')
    if (cell.isUnderline()) parts.push('underline')
    if (cell.isInverse()) parts.push('inverse')
    if (cell.isStrikethrough()) parts.push('strike')
    return parts.join(' ')
  }

  private styleRuns(y: number): string[] {
    const buf = this.emulator.buffer.active
    const line = buf.getLine(y)
    /* v8 ignore next -- defensive: styleRuns is only ever called by snapshot() for a y it already confirmed has a line; see the twin guard above */
    if (!line) return []
    const runs: string[] = []
    let runStart = -1
    let runLabel = ''
    for (let x = 0; x <= line.length; x++) {
      const cell = x < line.length ? line.getCell(x) : undefined
      const label = cell ? this.cellLabel(cell) : ''
      if (label !== runLabel) {
        if (runLabel !== '') runs.push(`  style ${runStart}-${x - 1} ${runLabel}`)
        runStart = x
        runLabel = label
      }
    }
    return runs
  }

  themeViolations(): string[] {
    const buf = this.emulator.buffer.active
    const violations: string[] = []
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y)
      /* v8 ignore next -- defensive: same xterm buffer contract as snapshot()'s guard above (real getLine(y) never returns undefined for in-range y) */
      if (!line) continue
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        /* v8 ignore next -- defensive: getCell(x) never returns undefined for x in [0, line.length) on a real xterm buffer line */
        if (!cell) continue
        if (cell.isFgRGB()) violations.push(`${y}:${x} rgb-fg`)
        if (cell.isBgRGB()) violations.push(`${y}:${x} rgb-bg`)
        if (cell.isFgPalette() && cell.getFgColor() > 15) violations.push(`${y}:${x} extended-fg-${cell.getFgColor()}`)
        if (cell.isBgPalette() && cell.getBgColor() > 15) violations.push(`${y}:${x} extended-bg-${cell.getBgColor()}`)
        if (cell.isBgPalette() && cell.getBgColor() <= 15 && !cell.isBgDefault() && cell.getChars() !== '') violations.push(`${y}:${x} explicit-bg`)
      }
    }
    return violations
  }
}
