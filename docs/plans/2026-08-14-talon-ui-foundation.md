# talon-ui Foundation (T0+T1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `dsh --profile talon` terminal UI: plugin boots, streams a conversation with role headers, borderless composer with state line, exits cleanly on every path, with the semantic-snapshot test harness and performance gates in place.

**Architecture:** Same-process Cordis plugin pair (`talon-boot` creates the root agent; `talon-ui` presents it) on pi-tui `TuiMainScreen` (inline flow, native scrollback). A contract layer (`src/backend/`) is the only code touching `ctx.*`; it translates dsh events into an internal `AppEvent` union consumed by UI components. Committed transcript cells are immutable persistent components with width-keyed line caches; only the streaming tail mutates.

**Tech Stack:** TypeScript strict ESM, Node >=22.19, pnpm, `@earendil-works/pi-tui@0.84.x`, vitest + `@xterm/headless@5.5.0`, peer-linked `@deepseek-ai/dsh-*` from local `../deepseek-harness`.

**Spec:** `docs/superpowers/specs/2026-08-13-talon-ui-design.md` (decision records D1–D13 govern; §3 has the exact dsh signatures recovered by archaeology; §5 performance laws are mandatory).

## Global Constraints

- Node engines: `>=22.19.0`; `"type": "module"`; TypeScript `strict: true`.
- All dsh imports resolve source-plane in tests (tsconfig `paths` → `../deepseek-harness/packages/*/*/src`), runtime via `file:` links.
- ANSI-16 only palette; the two truecolor exceptions are NOT in this plan's scope (banner lands in T3 plan). `NO_COLOR` and non-TTY-detect disable color.
- Every untrusted string (model/tool/config text) passes `displayText()` before styling (spec D7.8).
- No component constructs Text/Markdown or wraps text inside `render(width)` (spec §5.1). Width-keyed caches invalidated only by state mutators.
- `setClearOnShrink(false)` always (spec D10). Transcript mount cap default 5000 lines.
- pi-tui `Text` constructor defaults `paddingX=1, paddingY=1` — always pass explicit `0, 0` unless padding is wanted.
- UI copy is English, defined as constants in the file that renders it.
- Commit after every task (conventional commits).

## pi-tui exact signatures used in this plan (verified against 0.84.1 dist/*.d.ts)

```ts
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void
  stop(): void
  drainInput(maxMs?: number, idleMs?: number): Promise<void>
  write(data: string): void
  get columns(): number
  get rows(): number
  get kittyProtocolActive(): boolean
  moveBy(lines: number): void
  hideCursor(): void
  showCursor(): void
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void
  setTitle(title: string): void
  setProgress(active: boolean): void
}
interface Component { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void }
// TUI: new TuiMainScreen(terminal); addChild/removeChild/clear; setFocus(c|null); start(); stop(opts?);
//   requestRender(force?); renderNow(force?); addInputListener(l): () => void  (l: (data) => {consume?: boolean; data?: string} | undefined)
//   setClearOnShrink(b); hasOverlay(); queryTerminalColorScheme({timeoutMs}): Promise<'dark'|'light'|undefined>
// Text(text?, paddingX?, paddingY?): setText(t)   Spacer(lines?)   Container: addChild/removeChild/clear
// Editor(tui, theme: {borderColor: (s)=>string; selectList: SelectListTheme}, opts?: {paddingX?; autocompleteMaxVisible?})
//   .onSubmit?: (text)=>void  .getText()/.setText()  .addToHistory(t)  .borderColor mutable
// matchesKey(data: string, keyId: KeyId): boolean   Key.ctrl('c') etc.
```

---

### Task 1: Package scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `LICENSE` (MIT), `src/index.ts` (empty export), `src/boot.ts` (empty export)

**Interfaces:**
- Produces: buildable/testable workspace; `pnpm build` emits `lib/`; `pnpm test` runs vitest; dsh source-plane resolution for tests.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "talon-ui",
  "version": "0.1.0",
  "description": "Talon: a terminal UI for DeepSeek Harness agents",
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./boot": { "types": "./lib/boot.d.ts", "default": "./lib/boot.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "dependencies": {
    "@earendil-works/pi-tui": "^0.84.1"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-agent-loop": "*",
    "@deepseek-ai/dsh-commands": "*",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-session": "*",
    "@deepseek-ai/dsh-system-prompt": "*",
    "@deepseek-ai/dsh-token-meter": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-user-approval": "*",
    "@deepseek-ai/dsh-user-questions": "*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@xterm/headless": "5.5.0",
    "typescript": "^5.7.0",
    "vite-tsconfig-paths": "^5.1.0",
    "vitest": "^3.0.0"
  }
}
```

Note: peer ranges are `*` deliberately during dsh pre-release (spec D4); real resolution comes from `pnpm add file:` links.

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "lib",
    "rootDir": "src",
    "skipLibCheck": true,
    "allowImportingTsExtensions": false,
    "paths": {
      "@deepseek-ai/dsh-*": ["../deepseek-harness/packages/*/src", "../deepseek-harness/packages/core/*/src", "../deepseek-harness/packages/interaction/*/src", "../deepseek-harness/packages/llm/*/src", "../deepseek-harness/packages/session/*/src"]
    }
  },
  "include": ["src"]
}
```

Note: the `paths` fan-out above is a starting shape — dsh package dirs are grouped (`packages/<group>/<name>`). During this step run `ls ../deepseek-harness/packages/core ../deepseek-harness/packages/interaction ../deepseek-harness/packages/llm` and add one explicit entry per package this plan imports (`dsh-agent` → `packages/core/agent/src`, `dsh-session` → `packages/core/session/src`, `dsh-user-approval` → `packages/interaction/user-approval/src`, `dsh-user-questions` → `packages/interaction/user-questions/src`, `dsh-commands` → `packages/interaction/commands/src`, `dsh-tools` → `packages/core/tools/src`, `dsh-llm` → `packages/llm/llm/src`, `dsh-token-meter` → `packages/llm/token-meter/src`, `dsh-system-prompt` → `packages/core/system-prompt/src`, `dsh-agent-loop` → `packages/core/agent-loop/src`). Explicit entries beat glob guessing (dsh's own source-plane-resolution gate exists because a missing mapping silently falls back to built lib).

- [ ] **Step 3: Write vitest.config.ts**

```ts
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.snapshot.ts'],
    pool: 'forks',
  },
})
```

- [ ] **Step 4: Create empty entrypoints, LICENSE, README stub; install; verify toolchain**

`src/index.ts` and `src/boot.ts` each contain `export {}`. README: one paragraph (what talon is, `dsh plugin --profile talon add <path>` + `dsh --profile talon`). LICENSE: MIT text, copyright Devbox.

Run: `pnpm install && pnpm typecheck && pnpm test`
Expected: install OK; typecheck OK; vitest reports "no test files found" exit 0 (or add a trivial `tests/smoke.spec.ts` asserting `1===1` and delete it in Task 2).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold talon-ui package (tsc strict ESM, vitest, dsh source-plane paths)"
```

---

### Task 2: Palette and displayText (theme core)

**Files:**
- Create: `src/theme/palette.ts`, `tests/palette.spec.ts`

**Interfaces:**
- Produces:
  - `type ColorScheme = 'dark' | 'light'`
  - `paletteSpec(scheme: ColorScheme): { colors: Record<ColorRole, RoleSpec>; attributes: Record<AttrRole, RoleSpec> }` where `RoleSpec = { open: string; close: string; purpose: string }`
  - `type ColorRole = 'text'|'dim'|'accent'|'brand'|'code'|'success'|'warning'|'error'`; `type AttrRole = 'bold'|'italic'|'underline'|'strike'|'selected'`
  - `interface Palette` — one `(s: string) => string` closure per role, plus `readonly enabled: boolean`, `readonly scheme: ColorScheme`
  - `createPalette(enabled: boolean, scheme?: ColorScheme): Palette`
  - `displayText(text: string): string` — C0/C1 (except `\n`) → visible `\xNN`

- [ ] **Step 1: Write failing tests**

```ts
// tests/palette.spec.ts
import { describe, expect, it } from 'vitest'
import { createPalette, displayText, paletteSpec } from '../src/theme/palette.ts'

describe('paletteSpec', () => {
  it('uses the archaeology-verified SGR table (dark)', () => {
    const spec = paletteSpec('dark')
    expect(spec.colors.text).toMatchObject({ open: '', close: '' })
    expect(spec.colors.dim).toMatchObject({ open: '2;39', close: '22;39' })
    expect(spec.colors.accent).toMatchObject({ open: '95', close: '39' })
    expect(spec.colors.brand).toMatchObject({ open: '36', close: '39' })
    expect(spec.colors.code).toMatchObject({ open: '36', close: '39' })
    expect(spec.colors.success.open).toBe('32')
    expect(spec.colors.warning.open).toBe('33')
    expect(spec.colors.error.open).toBe('31')
    expect(spec.attributes.bold).toMatchObject({ open: '1', close: '22' })
    expect(spec.attributes.selected).toMatchObject({ open: '7', close: '27' })
  })
  it('code role switches to blue on light scheme', () => {
    expect(paletteSpec('light').colors.code.open).toBe('34')
  })
  it('every role carries a purpose string', () => {
    const spec = paletteSpec('dark')
    for (const role of Object.values({ ...spec.colors, ...spec.attributes }))
      expect(role.purpose.length).toBeGreaterThan(0)
  })
})

describe('createPalette', () => {
  it('wraps text in open/close SGR when enabled', () => {
    const p = createPalette(true, 'dark')
    expect(p.dim('x')).toBe('\x1b[2;39mx\x1b[22;39m')
    expect(p.text('x')).toBe('x') // zero-escape role
  })
  it('is identity when disabled', () => {
    const p = createPalette(false, 'dark')
    expect(p.accent('x')).toBe('x')
    expect(p.bold('x')).toBe('x')
  })
})

describe('displayText', () => {
  it('escapes C0/C1 controls except newline', () => {
    expect(displayText('a\x1b[31mred')).toBe('a\\x1b[31mred')
    expect(displayText('t\x07bel')).toBe('t\\x07bel')
    expect(displayText('osc\x9d')).toBe('osc\\x9d')
    expect(displayText('keep\nnewline')).toBe('keep\nnewline')
    expect(displayText('plain')).toBe('plain')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/palette.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/theme/palette.ts
/** Single source of every SGR code talon emits. ANSI-16 + attributes only
 * so every terminal remaps colors to the user's own theme (spec D6). */
export type ColorScheme = 'dark' | 'light'
export type ColorRole = 'text' | 'dim' | 'accent' | 'brand' | 'code' | 'success' | 'warning' | 'error'
export type AttrRole = 'bold' | 'italic' | 'underline' | 'strike' | 'selected'
export interface RoleSpec { open: string; close: string; purpose: string }

export function paletteSpec(scheme: ColorScheme): {
  colors: Record<ColorRole, RoleSpec>
  attributes: Record<AttrRole, RoleSpec>
} {
  return {
    colors: {
      text: { open: '', close: '', purpose: 'body text; inherits the terminal default foreground' },
      dim: { open: '2;39', close: '22;39', purpose: 'secondary text; fades relative to the terminal foreground on both schemes' },
      accent: { open: '95', close: '39', purpose: 'interactive highlights and the talon role header' },
      brand: { open: '36', close: '39', purpose: 'talon brand accents (ANSI fallback for truecolor teal)' },
      code: { open: scheme === 'light' ? '34' : '36', close: '39', purpose: 'inline code and code blocks' },
      success: { open: '32', close: '39', purpose: 'successful results and diff additions' },
      warning: { open: '33', close: '39', purpose: 'pending states and cautions' },
      error: { open: '31', close: '39', purpose: 'failures and diff removals' },
    },
    attributes: {
      bold: { open: '1', close: '22', purpose: 'role headers and emphasis' },
      italic: { open: '3', close: '23', purpose: 'reasoning text' },
      underline: { open: '4', close: '24', purpose: 'role headers and links' },
      strike: { open: '9', close: '29', purpose: 'completed todo items' },
      selected: { open: '7', close: '27', purpose: 'active row in selectors (reverse video)' },
    },
  }
}

export interface Palette {
  readonly enabled: boolean
  readonly scheme: ColorScheme
  text(s: string): string
  dim(s: string): string
  accent(s: string): string
  brand(s: string): string
  code(s: string): string
  success(s: string): string
  warning(s: string): string
  error(s: string): string
  bold(s: string): string
  italic(s: string): string
  underline(s: string): string
  strike(s: string): string
  selected(s: string): string
}

function ansi(spec: RoleSpec, enabled: boolean): (s: string) => string {
  if (!enabled || spec.open === '') return (s) => s
  return (s) => `\x1b[${spec.open}m${s}\x1b[${spec.close}m`
}

/** Build role closures from the spec table. `enabled: false` (NO_COLOR, non-TTY) yields identity fns. */
export function createPalette(enabled: boolean, scheme: ColorScheme = 'dark'): Palette {
  const spec = paletteSpec(scheme)
  return {
    enabled,
    scheme,
    text: ansi(spec.colors.text, enabled),
    dim: ansi(spec.colors.dim, enabled),
    accent: ansi(spec.colors.accent, enabled),
    brand: ansi(spec.colors.brand, enabled),
    code: ansi(spec.colors.code, enabled),
    success: ansi(spec.colors.success, enabled),
    warning: ansi(spec.colors.warning, enabled),
    error: ansi(spec.colors.error, enabled),
    bold: ansi(spec.attributes.bold, enabled),
    italic: ansi(spec.attributes.italic, enabled),
    underline: ansi(spec.attributes.underline, enabled),
    strike: ansi(spec.attributes.strike, enabled),
    selected: ansi(spec.attributes.selected, enabled),
  }
}

/** Neutralize terminal controls at the display boundary (spec D7.8): every
 * C0/C1 control except LF becomes a visible \xNN escape BEFORE styling, so
 * untrusted text can never inject OSC/CSI/cursor/title sequences. */
export function displayText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[ -	--]/gu, (c) => `\\x${c.codePointAt(0)!.toString(16).padStart(2, '0')}`)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/palette.spec.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/theme/palette.ts tests/palette.spec.ts && git commit -m "feat: ANSI-16 paletteSpec single table + displayText control neutralization"
```

---

### Task 3: HeadlessTerminal semantic snapshot harness

**Files:**
- Create: `src/testing/headless-terminal.ts`, `tests/headless-terminal.spec.ts`

**Interfaces:**
- Consumes: pi-tui `Terminal` interface (all 15 members, signatures in Global Constraints block).
- Produces:
  - `class HeadlessTerminal implements Terminal` with constructor `(columns = 100, rows = 36)`
  - `get frames(): number` — count of completed synchronized frames (`\x1b[?2026l` occurrences written)
  - `waitForFrame(after: number, timeoutMs = 2000): Promise<void>`
  - `snapshot(): string` — semantic serialization (dimensions, lifecycle counters, title, cursor, non-blank rows as `N| "text"` + `  style A-B <labels>` runs, blank runs collapsed)
  - `themeViolations(): string[]` — `rgb-fg/rgb-bg/extended-fg-N/extended-bg-N/explicit-bg` findings
  - `renderAfter(tui: { requestRender(): void }, terminal: HeadlessTerminal, action: () => void): Promise<void>` helper

- [ ] **Step 1: Write failing tests**

```ts
// tests/headless-terminal.spec.ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/headless-terminal.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/testing/headless-terminal.ts
/** Test double: a real @xterm/headless emulator behind pi-tui's exact
 * Terminal interface. Snapshots are SEMANTIC terminal state (text and
 * style reported separately), never raw ANSI bytes. Frame boundaries are
 * pi-tui's CSI 2026 synchronized-output end marker, so a snapshot never
 * captures a write-in-progress prefix. (Pattern recovered from the deleted
 * dsh-tui harness; see spec §7.1.) */
import { Terminal as XtermTerminal } from '@xterm/headless'
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
  private waiters: { after: number; resolve(): void }[] = []

  constructor(private readonly cols = 100, private readonly rowCount = 36) {
    this.emulator = new XtermTerminal({ cols, rows: rowCount, allowProposedApi: true, scrollback: 5000 })
  }

  get frames(): number { return this.frameCount }

  waitForFrame(after: number, timeoutMs = 2000): Promise<void> {
    if (this.frameCount > after) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { after, resolve }
      this.waiters.push(waiter)
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) {
          this.waiters.splice(i, 1)
          reject(new Error(`TUI did not complete frame ${after + 1} within ${timeoutMs}ms`))
        }
      }, timeoutMs).unref?.()
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
    this.emulator.write(data)
    let idx = -1
    while ((idx = data.indexOf(FRAME_END, idx + 1)) >= 0) {
      this.frameCount += 1
      this.waiters = this.waiters.filter((w) => {
        if (this.frameCount > w.after) { w.resolve(); return false }
        return true
      })
    }
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
      if (!line) continue
      const text = line.translateToString(true)
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

  private cellLabel(cell: NonNullable<ReturnType<NonNullable<ReturnType<typeof this.emulator.buffer.active.getLine>>['getCell']>>): string {
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
      if (!line) continue
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        if (!cell) continue
        if (cell.isFgRGB()) violations.push(`${y}:${x} rgb-fg`)
        if (cell.isBgRGB()) violations.push(`${y}:${x} rgb-bg`)
        if (cell.isFgPalette() && cell.getFgColor() > 15) violations.push(`${y}:${x} extended-fg-${cell.getFgColor()}`)
        if (cell.isBgPalette() && cell.getBgColor() > 15) violations.push(`${y}:${x} extended-bg-${cell.getBgColor()}`)
        if (cell.isBgPalette() && cell.getBgColor() <= 15 && cell.getChars() !== '') violations.push(`${y}:${x} explicit-bg`)
      }
    }
    return violations
  }
}

/** Snapshot the frame count, run the mutation, await the NEXT completed frame. */
export async function renderAfter(tui: { requestRender(force?: boolean): void }, terminal: HeadlessTerminal, action: () => void): Promise<void> {
  const before = terminal.frames
  action()
  tui.requestRender()
  await terminal.waitForFrame(before)
}
```

Note: `@xterm/headless` cell API (`getCell/isFgRGB/isBold/...`) — if a method name differs at 5.5.0, consult `node_modules/@xterm/headless/typings/xterm-headless.d.ts` (the `IBufferCell` interface) and adjust; the semantic output format is the contract, not the emulator API names.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/headless-terminal.spec.ts`
Expected: PASS. If the `explicit-bg` check misfires on default-background cells, tighten it per `IBufferCell` docs (default bg reports palette 0 or `isBgDefault()` — use `!cell.isBgDefault()` if available).

- [ ] **Step 5: Commit**

```bash
git add src/testing tests/headless-terminal.spec.ts && git commit -m "feat: HeadlessTerminal semantic snapshot harness with frame-boundary waits and theme violations"
```

---

### Task 4: AppEvent contract and event translator

**Files:**
- Create: `src/backend/app-events.ts`, `src/backend/translate.ts`, `tests/translate.spec.ts`

**Interfaces:**
- Consumes: dsh `SessionEventMap` payload shapes (spec §3.2) — this task defines local structural types for the payloads it reads; it does NOT import dsh types (contract layer stays compilable without dsh in unit tests).
- Produces:
  - `type AppEvent =` discriminated union (below) — the ONLY vocabulary UI code sees
  - `translateSessionEvent(event: { type: string; data: unknown; time?: number }): AppEvent[]`

- [ ] **Step 1: Write failing tests**

```ts
// tests/translate.spec.ts
import { describe, expect, it } from 'vitest'
import { translateSessionEvent } from '../src/backend/translate.ts'

describe('translateSessionEvent', () => {
  it('maps user/message to user-message', () => {
    const out = translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    expect(out).toEqual([{ kind: 'user-message', text: 'hi' }])
  })
  it('maps text-delta chunks to stream-delta', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'He' } } })
    expect(out).toEqual([{ kind: 'stream-delta', turn: 1, step: 2, index: 0, block: 'text', text: 'He' }])
  })
  it('maps reasoning-delta chunks with block=reasoning', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 1, text: 'hm' } } })
    expect(out[0]).toMatchObject({ kind: 'stream-delta', block: 'reasoning' })
  })
  it('ignores non-visual chunks (usage, tool-call-delta, finish)', () => {
    for (const chunk of [{ type: 'usage', usage: {} }, { type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '{' }, { type: 'finish' }])
      expect(translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk } })).toEqual([])
  })
  it('maps assistant/message to stream-settle with authoritative content', () => {
    const content = [{ type: 'text', text: 'final' }]
    const out = translateSessionEvent({ type: 'assistant/message', data: { turn: 1, step: 2, message: { content } } })
    expect(out).toEqual([{ kind: 'stream-settle', turn: 1, step: 2, content }])
  })
  it('maps every turn/end reason and names unknown kinds', () => {
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: undefined }])
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: { text: 'Turn cancelled.', tone: 'warning' } }])
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: { text: 'boom', tone: 'error' } }])
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'someday-new' } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: { text: 'Turn ended: someday-new.', tone: 'warning' } }])
  })
  it('passes through turn/start and step boundaries', () => {
    expect(translateSessionEvent({ type: 'turn/start', data: { turn: 3 } })).toEqual([{ kind: 'turn-start', turn: 3 }])
    expect(translateSessionEvent({ type: 'step/start', data: { turn: 3, step: 1 } })).toEqual([{ kind: 'step-start', turn: 3, step: 1 }])
    expect(translateSessionEvent({ type: 'step/end', data: { turn: 3, step: 1 }, time: 42 })).toEqual([{ kind: 'step-end', turn: 3, step: 1, time: 42 }])
  })
  it('returns [] for unknown durable event types (skip-safe)', () => {
    expect(translateSessionEvent({ type: 'schedule/change', data: {} })).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/translate.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/backend/app-events.ts
/** Internal UI vocabulary. The UI state machine consumes ONLY this union;
 * dsh's event surface is translated at the contract boundary (spec D1). */
export interface Notice { text: string; tone: 'info' | 'warning' | 'error' }
export type ContentBlockLike = { type: string; text?: string; [k: string]: unknown }

export type AppEvent =
  | { kind: 'user-message'; text: string }
  | { kind: 'turn-start'; turn: number }
  | { kind: 'turn-end'; turn: number; notice: Notice | undefined }
  | { kind: 'step-start'; turn: number; step: number }
  | { kind: 'step-end'; turn: number; step: number; time: number | undefined }
  | { kind: 'stream-delta'; turn: number; step: number; index: number; block: 'text' | 'reasoning'; text: string }
  | { kind: 'stream-settle'; turn: number; step: number; content: ContentBlockLike[] }
```

```ts
// src/backend/translate.ts
import type { AppEvent, ContentBlockLike, Notice } from './app-events.ts'

interface RawEvent { type: string; data: unknown; time?: number }

function turnEndNotice(reason: { kind: string; error?: { message?: string } }): Notice | undefined {
  switch (reason.kind) {
    case 'completed': return undefined
    case 'aborted': case 'interrupted': return { text: 'Turn cancelled.', tone: 'warning' }
    case 'error': return { text: reason.error?.message ?? 'Turn failed.', tone: 'error' }
    case 'max-tokens': return { text: 'Turn stopped: max tokens reached.', tone: 'warning' }
    case 'blocked': return { text: 'Turn blocked.', tone: 'warning' }
    default: return { text: `Turn ended: ${reason.kind}.`, tone: 'warning' } // exhaustive-with-named-default (spec §3.2)
  }
}

function textOf(content: ContentBlockLike[] | undefined): string {
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n\n')
}

/** Translate one dsh session event into zero-or-more AppEvents. Unknown
 * event types return [] (skip-safe across the 40-type durable vocabulary). */
export function translateSessionEvent(event: RawEvent): AppEvent[] {
  const d = event.data as Record<string, never> & Record<string, any>
  switch (event.type) {
    case 'user/message':
      return [{ kind: 'user-message', text: textOf(d.content) }]
    case 'turn/start':
      return [{ kind: 'turn-start', turn: d.turn }]
    case 'turn/end':
      return [{ kind: 'turn-end', turn: d.turn, notice: turnEndNotice(d.reason) }]
    case 'step/start':
      return [{ kind: 'step-start', turn: d.turn, step: d.step }]
    case 'step/end':
      return [{ kind: 'step-end', turn: d.turn, step: d.step, time: event.time }]
    case 'assistant/chunk': {
      const chunk = d.chunk as { type: string; index?: number; text?: string }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        return [{
          kind: 'stream-delta', turn: d.turn, step: d.step, index: chunk.index ?? 0,
          block: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text ?? '',
        }]
      }
      return []
    }
    case 'assistant/message':
      return [{ kind: 'stream-settle', turn: d.turn, step: d.step, content: d.message?.content ?? [] }]
    default:
      return []
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/translate.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend tests/translate.spec.ts && git commit -m "feat: AppEvent contract and skip-safe session event translator"
```

---

### Task 5: Transcript cells (role headers, cached cell base, streaming assistant)

**Files:**
- Create: `src/ui/transcript/cells.ts`, `src/ui/transcript/streaming.ts`, `tests/cells.spec.ts`, `tests/streaming.spec.ts`

**Interfaces:**
- Consumes: `Palette`, `displayText` (Task 2); `ContentBlockLike` (Task 4); pi-tui `Component`, `Text`, `Container`, `Spacer`.
- Produces:
  - `messageHeader(label: string, color: (s: string) => string, palette: Palette): string`
  - `abstract class CachedCell implements Component` — `render(width)` serves `{width, lines}` cache; subclasses implement `protected renderLines(width: number): string[]` and call `protected dropLines()` from every mutator; `invalidate()` also drops.
  - `class UserMessageCell extends CachedCell` — constructor `(text: string, palette: Palette, label?: string)`
  - `class NoticeCell extends CachedCell` — constructor `(notice: Notice, palette: Palette)`
  - `class StreamingAssistantCell implements Component` — `update(delta: { index: number; block: 'text' | 'reasoning'; text: string }): void`, `settle(content: ContentBlockLike[]): void`, `isSettled(): boolean`; renders `talon` header + reasoning (italic dim) + text.

- [ ] **Step 1: Write failing tests**

```ts
// tests/cells.spec.ts
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { CachedCell, messageHeader, NoticeCell, UserMessageCell } from '../src/ui/transcript/cells.ts'

const p = createPalette(false)

describe('messageHeader', () => {
  it('is bold+underline colored label with no gutter prefix', () => {
    const colored = createPalette(true)
    expect(messageHeader('You', colored.text, colored)).toBe('\x1b[1m\x1b[4mYou\x1b[24m\x1b[22m')
  })
  it('neutralizes controls in the label', () => {
    expect(messageHeader('a\x1bb', p.text, p)).toBe('a\\x1bb')
  })
})

describe('CachedCell contract', () => {
  class Probe extends CachedCell {
    computes = 0
    protected renderLines(width: number): string[] { this.computes++; return [`w=${width}`] }
    poke(): void { this.dropLines() }
  }
  it('serves identical array reference for repeat same-width renders', () => {
    const c = new Probe()
    const a = c.render(80)
    expect(c.render(80)).toBe(a)          // reference identity — the perf law (spec §5.1)
    expect(c.computes).toBe(1)
  })
  it('recomputes on width change and on dropLines and on invalidate', () => {
    const c = new Probe()
    const a = c.render(80)
    expect(c.render(60)).not.toBe(a)
    const b = c.render(60)
    c.poke()
    expect(c.render(60)).not.toBe(b)
    const d = c.render(60)
    c.invalidate()
    expect(c.render(60)).not.toBe(d)
  })
})

describe('UserMessageCell / NoticeCell', () => {
  it('renders header + body with controls neutralized', () => {
    const cell = new UserMessageCell('hello\x07world', p)
    const lines = cell.render(80)
    expect(lines[0]).toContain('You')
    expect(lines.join('\n')).toContain('hello\\x07world')
  })
  it('notice renders single toned line', () => {
    const cell = new NoticeCell({ text: 'Turn cancelled.', tone: 'warning' }, p)
    expect(cell.render(80).join('\n')).toContain('Turn cancelled.')
  })
})
```

```ts
// tests/streaming.spec.ts
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { StreamingAssistantCell } from '../src/ui/transcript/streaming.ts'

const p = createPalette(false)

describe('StreamingAssistantCell', () => {
  it('accumulates deltas per block index and renders in index order', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 1, block: 'text', text: 'wor' })
    cell.update({ index: 0, block: 'reasoning', text: 'think' })
    cell.update({ index: 1, block: 'text', text: 'ld' })
    const out = cell.render(80).join('\n')
    expect(out.indexOf('think')).toBeLessThan(out.indexOf('world'))
  })
  it('settle replaces accumulated content with authoritative blocks', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'partial gar' })
    cell.settle([{ type: 'text', text: 'authoritative final' }])
    const out = cell.render(80).join('\n')
    expect(out).toContain('authoritative final')
    expect(out).not.toContain('partial gar')
    expect(cell.isSettled()).toBe(true)
  })
  it('ignores updates after settle', () => {
    const cell = new StreamingAssistantCell(p)
    cell.settle([{ type: 'text', text: 'done' }])
    cell.update({ index: 0, block: 'text', text: 'late' })
    expect(cell.render(80).join('\n')).not.toContain('late')
  })
  it('neutralizes hostile controls in streamed text', () => {
    const cell = new StreamingAssistantCell(p)
    cell.update({ index: 0, block: 'text', text: 'x\x1b]0;pwn\x07y' })
    expect(cell.render(80).join('\n')).toContain('x\\x1b]0;pwn\\x07y')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/cells.spec.ts tests/streaming.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

```ts
// src/ui/transcript/cells.ts
/** Committed transcript cells. Copy-friendly: bold+underline role headers,
 * zero gutter decoration, so drag-select copies exact message text (spec §4.1).
 * Perf law: render(width) serves a width-keyed cache; recompute only via
 * renderLines(); every mutator calls dropLines() (spec §5.1). */
import type { Component } from '@earendil-works/pi-tui'
import type { Notice } from '../../backend/app-events.ts'
import { displayText, type Palette } from '../../theme/palette.ts'

export function messageHeader(label: string, color: (s: string) => string, palette: Palette): string {
  return palette.bold(palette.underline(color(displayText(label))))
}

export abstract class CachedCell implements Component {
  private cached: { width: number; lines: string[] } | undefined
  protected abstract renderLines(width: number): string[]
  protected dropLines(): void { this.cached = undefined }
  invalidate(): void { this.cached = undefined }
  render(width: number): string[] {
    if (this.cached?.width !== width) this.cached = { width, lines: this.renderLines(width) }
    return this.cached.lines
  }
}

export class UserMessageCell extends CachedCell {
  constructor(private readonly text: string, private readonly palette: Palette, private readonly label = 'You') { super() }
  protected renderLines(_width: number): string[] {
    return ['', messageHeader(this.label, this.palette.text, this.palette), displayText(this.text)]
  }
}

export class NoticeCell extends CachedCell {
  constructor(private readonly notice: Notice, private readonly palette: Palette) { super() }
  protected renderLines(_width: number): string[] {
    const tone = this.notice.tone === 'error' ? this.palette.error : this.notice.tone === 'warning' ? this.palette.warning : this.palette.dim
    return [tone(displayText(this.notice.text))]
  }
}
```

```ts
// src/ui/transcript/streaming.ts
/** The live streaming tail: accumulates deltas in a Map keyed by block
 * index; assistant/message settles it with authoritative content (never
 * trusting the accumulated buffer). Settled cells stay mounted (spec §5.3). */
import type { Component } from '@earendil-works/pi-tui'
import type { ContentBlockLike } from '../../backend/app-events.ts'
import { displayText, type Palette } from '../../theme/palette.ts'
import { messageHeader } from './cells.ts'

interface StreamingBlock { block: 'text' | 'reasoning'; text: string }

export class StreamingAssistantCell implements Component {
  private readonly blocks = new Map<number, StreamingBlock>()
  private settled: ContentBlockLike[] | undefined

  constructor(private readonly palette: Palette) {}

  update(delta: { index: number; block: 'text' | 'reasoning'; text: string }): void {
    if (this.settled) return
    const existing = this.blocks.get(delta.index)
    if (existing) existing.text += delta.text
    else this.blocks.set(delta.index, { block: delta.block, text: delta.text })
  }

  settle(content: ContentBlockLike[]): void { this.settled = content }
  isSettled(): boolean { return this.settled !== undefined }

  invalidate(): void {}

  render(_width: number): string[] {
    const lines: string[] = ['', messageHeader('talon', this.palette.accent, this.palette)]
    const parts: { block: string; text: string }[] = this.settled
      ? this.settled.filter((b) => b.type === 'text' || b.type === 'reasoning').map((b) => ({ block: b.type, text: b.text ?? '' }))
      : [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
    for (const part of parts) {
      const body = displayText(part.text)
      if (part.block === 'reasoning') lines.push(...body.split('\n').map((l) => this.palette.dim(this.palette.italic(l))))
      else lines.push(...body.split('\n'))
    }
    return lines
  }
}
```

Note: v1 renders plain styled text (Markdown component arrives in the T3 plan; the settle/accumulate architecture is what this task pins).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/cells.spec.ts tests/streaming.spec.ts`
Expected: PASS (cache identity assertions use `.toBe`).

- [ ] **Step 5: Commit**

```bash
git add src/ui tests/cells.spec.ts tests/streaming.spec.ts && git commit -m "feat: transcript cells with width-keyed cache law and settle-driven streaming"
```

---

### Task 6: Transcript container with mount cap

**Files:**
- Create: `src/ui/transcript/transcript.ts`, `tests/transcript.spec.ts`

**Interfaces:**
- Consumes: `AppEvent` (Task 4), cells (Task 5), `Palette`.
- Produces:
  - `class Transcript` — owns a pi-tui `Container`; methods: `get container(): Container`, `apply(event: AppEvent): void`, `mountedLines(width: number): number` (test aid), constructor `(palette: Palette, options?: { mountCapLines?: number })` (default 5000).
  - Behavior: `stream-delta` lazily creates/updates one `StreamingAssistantCell` per `(turn, step)`; `stream-settle` settles it; `turn-end` appends notice if present and clears the live ref; head-trim inserts one dim `… earlier history not shown …` marker cell when cap exceeded.

- [ ] **Step 1: Write failing tests**

```ts
// tests/transcript.spec.ts
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { Transcript } from '../src/ui/transcript/transcript.ts'

const p = createPalette(false)
const render = (t: Transcript) => t.container.render(80).join('\n')

describe('Transcript', () => {
  it('appends user message, streams, settles', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'user-message', text: 'question' })
    t.apply({ kind: 'turn-start', turn: 1 })
    t.apply({ kind: 'step-start', turn: 1, step: 1 })
    t.apply({ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: 'ans' })
    expect(render(t)).toContain('ans')
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'answer' }] })
    t.apply({ kind: 'turn-end', turn: 1, notice: undefined })
    const out = render(t)
    expect(out).toContain('question')
    expect(out).toContain('answer')
  })
  it('renders turn-end notices', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'turn-end', turn: 1, notice: { text: 'Turn cancelled.', tone: 'warning' } })
    expect(render(t)).toContain('Turn cancelled.')
  })
  it('second assistant/message of the same step does not re-open a settled cell', () => {
    const t = new Transcript(p)
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'first' }] })
    t.apply({ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'second' }] })
    const out = render(t)
    expect(out).toContain('first')
    expect(out).toContain('second') // becomes a NEW cell, first is preserved (replay bug fix, spec §4 archaeology)
  })
  it('head-trims past the mount cap with a marker', () => {
    const t = new Transcript(p, { mountCapLines: 50 })
    for (let i = 0; i < 40; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    const out = render(t)
    expect(out).toContain('earlier history not shown')
    expect(out).not.toContain('msg 0')
    expect(out).toContain('msg 39')
    expect(t.mountedLines(80)).toBeLessThanOrEqual(50 + 3) // cap + marker slack
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/transcript.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/ui/transcript/transcript.ts
/** Ordered committed cells + the one live streaming tail. Mount cap (spec
 * D10): when total rendered lines exceed the cap, oldest cells unmount and
 * one dim marker takes their place — bounds full-redraw cost and initial
 * layout; the session log stays complete. */
import { Container, Text } from '@earendil-works/pi-tui'
import type { AppEvent } from '../../backend/app-events.ts'
import type { Palette } from '../../theme/palette.ts'
import { NoticeCell, UserMessageCell } from './cells.ts'
import { StreamingAssistantCell } from './streaming.ts'

const TRIM_MARKER = '… earlier history not shown …'

export class Transcript {
  readonly container = new Container()
  private live: { key: string; cell: StreamingAssistantCell } | undefined
  private readonly cap: number
  private marker: Text | undefined

  constructor(private readonly palette: Palette, options?: { mountCapLines?: number }) {
    this.cap = options?.mountCapLines ?? 5000
  }

  mountedLines(width: number): number { return this.container.render(width).length }

  apply(event: AppEvent): void {
    switch (event.kind) {
      case 'user-message':
        this.container.addChild(new UserMessageCell(event.text, this.palette))
        break
      case 'stream-delta': {
        this.cell(`${event.turn}:${event.step}`).update(event)
        break
      }
      case 'stream-settle': {
        const key = `${event.turn}:${event.step}`
        const cell = this.cell(key)
        if (cell.isSettled()) {
          // A settled cell never re-absorbs a later message (replay-parity fix): new cell.
          const fresh = new StreamingAssistantCell(this.palette)
          fresh.settle(event.content)
          this.container.addChild(fresh)
          this.live = { key, cell: fresh }
        } else {
          cell.settle(event.content)
        }
        break
      }
      case 'turn-end':
        if (event.notice) this.container.addChild(new NoticeCell(event.notice, this.palette))
        this.live = undefined
        break
      case 'turn-start': case 'step-start': case 'step-end':
        break
    }
    this.trim()
  }

  private cell(key: string): StreamingAssistantCell {
    if (this.live?.key !== key) {
      const cell = new StreamingAssistantCell(this.palette)
      this.container.addChild(cell)
      this.live = { key, cell }
    }
    return this.live.cell
  }

  private trim(): void {
    // Cheap check first: count only when children are numerous.
    const width = 200 // conservative width for line counting; cached renders make this cheap
    while (this.container.children.length > 2 && this.mountedLines(width) > this.cap) {
      const first = this.container.children.find((c) => c !== this.marker)
      if (!first) break
      this.container.removeChild(first)
      if (!this.marker) {
        this.marker = new Text(this.palette.dim(TRIM_MARKER), 0, 0)
        this.container.children.unshift(this.marker)
      }
    }
  }
}
```

Note: `container.children` is a public plain array on pi-tui `Container` (verified 0.84.1); `unshift` for the marker is deliberate (marker stays first).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/transcript.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/transcript tests/transcript.spec.ts && git commit -m "feat: transcript container with settle routing and mount-cap head trim"
```

---

### Task 7: Composer (borderless editor + state line + hint line)

**Files:**
- Create: `src/ui/composer/composer.ts`, `tests/composer.spec.ts`

**Interfaces:**
- Consumes: pi-tui `Editor`, `Container`, `Text`; `Palette`.
- Produces:
  - `type ComposerState = 'idle' | 'streaming' | 'waiting'`
  - `class Composer` — `readonly container: Container` (state line + editor + hint line), `readonly editor: Editor` (focus target), `setState(state: ComposerState): void`, `setHint(text: string): void`, `onSubmit?: (text: string) => void`, constructor `(tui: TUI, palette: Palette)`.
  - State line: full-width `─` rule, dim (idle) / accent (streaming) / warning (waiting). Editor top border doubles as nothing — we render our own rule and drop the editor's bottom border row via subclass.

- [ ] **Step 1: Write failing tests**

```ts
// tests/composer.spec.ts
import { describe, expect, it } from 'vitest'
import { TuiMainScreen } from '@earendil-works/pi-tui'
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
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/composer.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/ui/composer/composer.ts
/** Borderless composer: our own state rule above (doubles as the status
 * indicator — zero extra rows for a spinner), the pi-tui Editor with its
 * frame suppressed via render() subclass, a dim contextual hint line below
 * (discoverability is a first-class ergonomic requirement, spec D5/§4.3). */
import { Container, Editor, Text, type TUI } from '@earendil-works/pi-tui'
import type { Palette } from '../../theme/palette.ts'

export type ComposerState = 'idle' | 'streaming' | 'waiting'

class FramelessEditor extends Editor {
  render(width: number): string[] {
    const rows = super.render(width)
    // Upstream Editor frames content with a top and bottom border row; drop
    // both (our composer renders its own state rule). Content rows are
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
  private readonly rule: Text
  private readonly hint: Text
  private width = 80

  constructor(tui: TUI, private readonly palette: Palette) {
    this.rule = new (class extends Text {})('', 0, 0)
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
        self.width = width
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
```

Note on `FramelessEditor`: verify empirically in Step 4 that upstream `Editor.render()` emits exactly one top and one bottom frame row (inspect `term.snapshot()` output). If 0.84.1 frames differently (e.g. no bottom row when empty), adjust the slice accordingly and pin the observed shape with an extra assertion. If the subclass proves brittle, fallback documented in spec risk table: re-create the known 346-line pnpm patch (frame:'none' + prompt prefixes).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/composer.spec.ts`
Expected: PASS. Inspect the snapshot output for stray border rows; adjust slice as noted.

- [ ] **Step 5: Commit**

```bash
git add src/ui/composer tests/composer.spec.ts && git commit -m "feat: borderless composer with state rule and hint line"
```

---

### Task 8: talon-boot plugin (root agent creation)

**Files:**
- Create: `src/boot.ts` (replace stub), `tests/boot.spec.ts`

**Interfaces:**
- Consumes: `ctx.agents` (`AgentRegistry` — `create(...)`/`roots()`), Cordis plugin shape.
- Produces: Cordis plugin `{ name: 'talon-boot', inject: ['agents'], Config, apply }`; config `{ sessionId?: string }` (default `'main'`). On apply, creates the root agent if absent (the UI plugin only presents — agent-by-host separation, spec §2).

- [ ] **Step 1: Read the exact current create signature**

Run: `sed -n '100,260p' ../deepseek-harness/packages/core/agent/src/index.ts`
Record: the exact `AgentRegistry.create(...)` options type (sibling of the archaeology-verified `resume({resumeSessionId, agentOptions?, setup?, signal?}): Promise<AgentHandle>` at index.ts:139-156,213). Adapt Step 2's `create` call to the printed signature — parameter names below are the expected shape, not gospel.

- [ ] **Step 2: Write failing test**

```ts
// tests/boot.spec.ts
import { describe, expect, it } from 'vitest'
import * as boot from '../src/boot.ts'

describe('talon-boot plugin shape', () => {
  it('exports Cordis plugin surface without default export', () => {
    expect(boot.name).toBe('talon-boot')
    expect(boot.inject).toEqual(['agents'])
    expect(typeof boot.apply).toBe('function')
    expect((boot as Record<string, unknown>).default).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run to verify failure, then implement**

Run: `pnpm vitest run tests/boot.spec.ts` — Expected: FAIL.

```ts
// src/boot.ts
/** talon-boot: creates the root agent the talon-ui plugin presents.
 * Separation is deliberate (host owns the agent; UI only renders — the
 * dedicated-front-door decision, spec §2). */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'talon-boot'
export const inject = ['agents'] as const

export interface Config { sessionId?: string }

export function apply(ctx: Context, config: Config = {}): void {
  const sessionId = config.sessionId ?? 'main'
  ctx.on('ready', async () => {
    const agents = (ctx as any).agents
    const existing = agents.roots().find((a: { id: string }) => a.id === sessionId)
    if (existing) return
    await agents.create({ agentOptions: { sessionId } }) // ← align with the signature printed in Step 1
  })
}
```

Note: `ctx.on('ready', ...)` timing and the exact create options MUST be aligned with the Step 1 printout and dsh's own bundle rows (see how `dsh-headless` or web app-boot creates agents: `grep -rn "agents.create" ../deepseek-harness/packages/boot ../deepseek-harness/packages/bundle ../deepseek-harness/apps | head`). If dsh requires an id brand (`SessionId`), import its brand helper rather than casting.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run tests/boot.spec.ts` — Expected: PASS. Also `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/boot.ts tests/boot.spec.ts && git commit -m "feat: talon-boot plugin creates the root agent"
```

---

### Task 9: talon-ui plugin entry (lifecycle, keys, wiring)

**Files:**
- Create: `src/index.ts` (replace stub), `src/app/controller.ts`, `tests/controller.spec.ts`, `tests/app.snapshot.ts`, `tests/snapshots/` (goldens directory)

**Interfaces:**
- Consumes: everything above; dsh services per inject list.
- Produces:
  - `src/index.ts`: Cordis plugin `{ name: 'talon-ui', inject: ['agents', 'sessions'], Config, apply }` — v1 inject is the T1 subset; the full 9-service list lands with T2 (approval/questions/commands). `apply` does the TTY fail-loud check, waits for `agent/created` matching configured sessionId (or finds it synchronously — race-safe both ways), then mounts via `ctx.effect`.
  - `src/app/controller.ts`: `createController(deps: ControllerDeps): { dispose(): Promise<void> }` where `ControllerDeps = { ctx: any; agent: any; terminal: Terminal; palette: Palette; exit(code: number): void }` — constructs TuiMainScreen (setClearOnShrink(false)), Transcript, Composer, global input listener, session/event + agent/status subscriptions, teardown.
  - Key behavior (spec §6): panel-yield stub (`hasPanel(): boolean` always false in T1), Ctrl+C three-way, Esc cancel-if-running, Ctrl+L force redraw, Ctrl+D exit-if-idle-empty.
  - Exit: `disposeRootAndExit(ctx, code)` with 5s timeout; `installFailLoud` for unhandledRejection AND uncaughtException (dispose-then-exit, 2s cap); SIGTERM/SIGHUP handlers doing the same.

- [ ] **Step 1: Write failing controller tests (FakeAgent pattern)**

```ts
// tests/controller.spec.ts
import { describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

type Listener = (...args: unknown[]) => void

function fakeCtx() {
  const listeners = new Map<string, Listener[]>()
  return {
    listeners,
    on(event: string, fn: Listener) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => list.splice(list.indexOf(fn), 1)
    },
    emit(event: string, ...args: unknown[]) { for (const fn of listeners.get(event) ?? []) fn(...args) },
  }
}

function fakeAgent(id = 'main') {
  return {
    id,
    status: 'idle' as 'idle' | 'running',
    session: { id },
    cancelled: [] as unknown[],
    followups: [] as unknown[],
    cancel(cause: unknown) { this.cancelled.push(cause) },
    followup(message: unknown) { this.followups.push(message) },
    steer(message: unknown) { this.followups.push(message) },
    whenIdle: () => Promise.resolve(),
    ctx: undefined as unknown,
  }
}

function setup() {
  const ctx = fakeCtx()
  const agent = fakeAgent()
  agent.ctx = ctx
  const terminal = new HeadlessTerminal(60, 14)
  const exit = vi.fn()
  const controller = createController({ ctx, agent, terminal, palette: createPalette(false), exit })
  return { ctx, agent, terminal, exit, controller }
}

describe('controller', () => {
  it('streams a session event roundtrip into the transcript', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    const before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello back' } } })
    await terminal.waitForFrame(before)
    expect(terminal.snapshot()).toContain('hello back')
    await controller.dispose()
  })
  it('ignores events from other sessions', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    ctx.emit('session/event', { id: 'other' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'foreign' }] } })
    await new Promise((r) => setTimeout(r, 30))
    expect(terminal.snapshot()).not.toContain('foreign')
    await controller.dispose()
  })
  it('submit dispatches followup when idle, steer when running', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('question\r')
    expect(agent.followups.length).toBe(1)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('steer this\r')
    expect(agent.followups.length).toBe(2)
    await controller.dispose()
  })
  it('Ctrl+C cancels a running turn; on idle+empty requests exit', async () => {
    const { ctx, agent, terminal, exit, controller } = setup()
    await terminal.waitForFrame(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('\x03')
    expect(agent.cancelled.length).toBe(1)
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' })
    terminal.input('\x03')
    await new Promise((r) => setTimeout(r, 10))
    expect(exit).toHaveBeenCalledWith(0)
    await controller.dispose()
  })
  it('Esc cancels only while running', async () => {
    const { ctx, agent, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    terminal.input('\x1b')
    expect(agent.cancelled.length).toBe(0)
    agent.status = 'running'
    ctx.emit('agent/status', { agent, status: 'running' })
    terminal.input('\x1b')
    expect(agent.cancelled.length).toBe(1)
    await controller.dispose()
  })
  it('dispose stops the terminal exactly once and detaches listeners', async () => {
    const { ctx, terminal, controller } = setup()
    await terminal.waitForFrame(0)
    await controller.dispose()
    await controller.dispose() // idempotent
    const snap = terminal.snapshot()
    expect(snap).toContain('stopped=1')
    expect([...ctx.listeners.values()].flat().length).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement controller**

```ts
// src/app/controller.ts
/** One mounted talon channel: TuiMainScreen + Transcript + Composer +
 * global keys + backend subscriptions. Async results re-enter through the
 * same handlers — no side-channel state (spec §2 data flow). */
import { matchesKey, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui'
import { translateSessionEvent } from '../backend/translate.ts'
import type { Palette } from '../theme/palette.ts'
import { Composer } from '../ui/composer/composer.ts'
import { Transcript } from '../ui/transcript/transcript.ts'

export interface ControllerDeps {
  ctx: { on(event: string, fn: (...args: any[]) => void): () => void }
  agent: {
    id: string
    status: 'idle' | 'running'
    session: unknown
    cancel(cause: { kind: 'user' }): void
    followup(message: unknown): void
    steer(message: unknown): void
    whenIdle(): Promise<void>
  }
  terminal: Terminal
  palette: Palette
  exit(code: number): void
}

const HINT_IDLE = 'enter send · shift+enter newline · ctrl+c exit'
const HINT_RUNNING = 'esc interrupt · ctrl+c interrupt'

export function createController(deps: ControllerDeps): { dispose(): Promise<void> } {
  const { ctx, agent, terminal, palette, exit } = deps
  const tui = new TuiMainScreen(terminal)
  tui.setClearOnShrink(false) // spec D10: shrink clears via normal diff, never a scrollback-wiping full redraw
  const transcript = new Transcript(palette)
  const composer = new Composer(tui, palette)
  composer.setHint(HINT_IDLE)
  tui.addChild(transcript.container)
  tui.addChild(composer.container)
  tui.setFocus(composer.editor)

  let disposed = false
  let running = agent.status === 'running'
  const hasPanel = (): boolean => false // T2 replaces with PanelManager.activePanel !== undefined

  const detachers: (() => void)[] = []

  detachers.push(ctx.on('session/event', (session: unknown, event: { type: string; data: unknown; time?: number }) => {
    if (session !== agent.session || disposed) return
    for (const appEvent of translateSessionEvent(event)) transcript.apply(appEvent)
    tui.requestRender()
  }))

  detachers.push(ctx.on('agent/status', (payload: { agent: unknown; status: 'idle' | 'running' }) => {
    if (payload.agent !== agent || disposed) return
    running = payload.status === 'running'
    composer.setState(running ? 'streaming' : 'idle')
    composer.setHint(running ? HINT_RUNNING : HINT_IDLE)
    tui.requestRender()
  }))

  composer.onSubmit = (text) => {
    if (disposed) return
    const message = { content: [{ type: 'text', text }] }
    if (running) agent.steer(message)
    else agent.followup(message)
    composer.editor.setText('')
    composer.editor.addToHistory(text)
    tui.requestRender()
  }

  const requestExit = (): void => {
    if (running) {
      agent.cancel({ kind: 'user' })
      void agent.whenIdle().then(() => { void dispose().then(() => exit(0)) })
    } else {
      void dispose().then(() => exit(0))
    }
  }

  detachers.push(tui.addInputListener((data) => {
    if (hasPanel()) return undefined // panels own 100% of input (spec D5)
    if (matchesKey(data, 'ctrl+c')) {
      if (running) { agent.cancel({ kind: 'user' }); return { consume: true } }
      if (composer.editor.getText() !== '') { composer.editor.setText(''); tui.requestRender(); return { consume: true } }
      requestExit()
      return { consume: true }
    }
    if (matchesKey(data, 'escape') && running) { agent.cancel({ kind: 'user' }); return { consume: true } }
    if (matchesKey(data, 'ctrl+l')) { tui.requestRender(true); return { consume: true } }
    if (matchesKey(data, 'ctrl+d') && composer.editor.getText() === '') {
      if (!running) requestExit()
      return { consume: true }
    }
    return undefined
  }))

  tui.start()

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    for (const detach of detachers.splice(0)) detach()
    tui.stop()
  }

  return { dispose }
}
```

- [ ] **Step 4: Run controller tests to verify pass**

Run: `pnpm vitest run tests/controller.spec.ts`
Expected: PASS. (If `matchesKey(data, 'escape')` also matches escape-prefixed sequences, guard with `data === '\x1b'`.)

- [ ] **Step 5: Implement the plugin entry**

```ts
// src/index.ts
/** talon-ui: the Cordis plugin. TTY fail-loud (never silently downgrade —
 * recorded dsh decision), waits for the configured root agent, mounts the
 * controller as one ctx.effect, and owns process-level exit safety. */
import { ProcessTerminal } from '@earendil-works/pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import { createController } from './app/controller.ts'
import { createPalette } from './theme/palette.ts'

export const name = 'talon-ui'
export const inject = ['agents', 'sessions'] as const

export interface Config { sessionId?: string }

const ROOT_DISPOSE_TIMEOUT_MS = 5_000
const FAIL_LOUD_RELEASE_TIMEOUT_MS = 2_000

export function disposeRootAndExit(ctx: Context, code: number, exit: (code: number) => never = process.exit): void {
  let exited = false
  const exitOnce = (): void => { if (!exited) { exited = true; exit(code) } }
  const timer = setTimeout(exitOnce, ROOT_DISPOSE_TIMEOUT_MS)
  timer.unref?.()
  void Promise.resolve((ctx as any).root.fiber.dispose()).finally(exitOnce)
}

function installProcessGuards(ctx: Context): () => void {
  const release = async (): Promise<void> => {
    await Promise.race([
      Promise.resolve((ctx as any).root.fiber.dispose()),
      new Promise((r) => setTimeout(r, FAIL_LOUD_RELEASE_TIMEOUT_MS)),
    ])
  }
  const failLoud = (label: string) => (cause: unknown): void => {
    process.stderr.write(`talon-ui: ${label}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    void release().finally(() => process.exit(1))
  }
  const onSignal = (): void => { void release().finally(() => process.exit(0)) }
  const rejection = failLoud('unhandled rejection')
  const exception = failLoud('uncaught exception')
  process.on('unhandledRejection', rejection)
  process.on('uncaughtException', exception)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  return () => {
    process.off('unhandledRejection', rejection)
    process.off('uncaughtException', exception)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('talon-ui requires an interactive terminal (stdin and stdout must be TTYs). Use dsh --profile headless for automation.')
  }
  const sessionId = config.sessionId ?? 'main'
  const enabled = process.env.NO_COLOR === undefined
  const anyCtx = ctx as any

  const start = (agent: any): void => {
    anyCtx.effect(() => {
      const terminal = new ProcessTerminal()
      const removeGuards = installProcessGuards(ctx)
      const controller = createController({
        ctx: agent.ctx ?? ctx,
        agent,
        terminal,
        palette: createPalette(enabled),
        exit: (code) => disposeRootAndExit(ctx, code),
      })
      return () => { removeGuards(); return controller.dispose() }
    }, 'talon-ui')
  }

  const matches = (agent: any): boolean => agent.id === sessionId && anyCtx.agents.roots().includes(agent)
  const existing = anyCtx.agents.roots().find(matches)
  if (existing) { start(existing); return }
  const off = anyCtx.on('agent/created', ({ agent }: { agent: any }) => {
    if (!matches(agent)) return
    off()
    start(agent)
  })
}
```

- [ ] **Step 6: Snapshot test (first golden) + typecheck**

```ts
// tests/app.snapshot.ts
import { describe, expect, it, vi } from 'vitest'
import { HeadlessTerminal } from '../src/testing/headless-terminal.ts'
import { createPalette } from '../src/theme/palette.ts'
import { createController } from '../src/app/controller.ts'

const CHECKPOINTS = ['conversation-roundtrip'] as const

describe('talon snapshots', () => {
  it('conversation-roundtrip', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_755_100_000_000)
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const ctx = {
      on: (e: string, f: (...a: unknown[]) => void) => { const l = listeners.get(e) ?? []; l.push(f); listeners.set(e, l); return () => l.splice(l.indexOf(f), 1) },
      emit: (e: string, ...a: unknown[]) => { for (const f of listeners.get(e) ?? []) f(...a) },
    }
    const agent = { id: 'main', status: 'idle' as const, session: { id: 'main' }, cancel() {}, followup() {}, steer() {}, whenIdle: () => Promise.resolve(), ctx }
    const terminal = new HeadlessTerminal(72, 18)
    const controller = createController({ ctx, agent, terminal, palette: createPalette(true), exit: () => {} })
    await terminal.waitForFrame(0)
    let before = terminal.frames
    ctx.emit('session/event', agent.session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Rename the button.' }] } })
    ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Looking at the file.' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'Done — renamed.' } } })
    ctx.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'Looking at the file.' }, { type: 'text', text: 'Done — renamed.' }] } } })
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await terminal.waitForFrame(before)
    const snap = terminal.snapshot()
    expect(terminal.themeViolations()).toEqual([])
    await expect(snap).toMatchFileSnapshot(`snapshots/${CHECKPOINTS[0]}.expected.txt`)
    await controller.dispose()
  })
})
```

Run: `pnpm vitest run tests/app.snapshot.ts` (first run writes the golden — inspect it by eye: role headers `You`/`talon`, reasoning dim-italic, state rule, hint line, zero theme violations), then `pnpm typecheck`.
Expected: PASS; committed golden reads correctly.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/app tests/controller.spec.ts tests/app.snapshot.ts tests/snapshots && git commit -m "feat: talon-ui plugin entry, controller wiring, exit safety, first semantic golden"
```

---

### Task 10: Bundle manifest and profile install

**Files:**
- Create: `cordis.patch.yml`, `docs/INSTALL.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: dsh bundle mechanics (spec §2; archaeology: package.json `dsh.bundle.patch` + top-level YAML list; `dsh plugin --profile talon add` seeds profile with dsh-base then reconciles).
- Produces: installable bundle; documented install/run flow.

- [ ] **Step 1: Write cordis.patch.yml**

```yaml
# talon bundle layer: composed on top of @deepseek-ai/dsh-base by the dsh
# profile loader. Row ids are loader labels (distinct from ctx service keys).
- insert:
    - id: session-projection-cache
      name: '@deepseek-ai/dsh-session-projection-cache'
    - id: talon-boot
      name: 'talon-ui/boot'
    - id: talon
      name: 'talon-ui'
```

Note: verify the row shape against a live reference before committing: `cat ../deepseek-harness/packages/bundle/web-app/cordis.patch.yml`. Match its exact insert/id/name structure (and whether subpath plugin names like `talon-ui/boot` are used there — the deleted TUI used `'@deepseek-ai/dsh-tui/prompt'` as a row name, so subpaths are supported).

- [ ] **Step 2: Build and install into a talon profile**

Run:
```bash
pnpm build
cd ../deepseek-harness && pnpm dsh plugin --profile talon add file:../talon-ui
```
Expected: profile dir `$DSH_HOME/profiles/talon/` created (package.json seeded with dsh-base), pnpm add succeeds, reconcile prints that `talon-ui` was appended to `dsh.profile.bundles` (NOT the "plain dependency" warning — that warning means the `dsh.bundle.patch` field wasn't picked up).

- [ ] **Step 3: Boot smoke (manual, real terminal)**

Run (in a real interactive terminal): `cd ../deepseek-harness && pnpm dsh --profile talon`
Expected: talon UI appears (state rule + hint line), typing works; with `DEEPSEEK_API_KEY` set a message streams a reply; Ctrl+C exits cleanly with the shell prompt restored (echo works, no raw-mode residue: run `stty -a | head -1` after exit — `icanon`/`echo` present).
If the root agent is missing (boot ordering), align talon-boot's create call per Task 8 Step 1 notes before proceeding.

- [ ] **Step 4: Write docs/INSTALL.md**

```markdown
# Installing talon

Requirements: Node >= 22.19, pnpm, a checkout of `deepseek-harness` as a sibling directory, an interactive terminal.

    cd talon-ui && pnpm install && pnpm build
    cd ../deepseek-harness
    pnpm dsh plugin --profile talon add file:../talon-ui
    pnpm dsh --profile talon

`dsh plugin` seeds `$DSH_HOME/profiles/talon` with `@deepseek-ai/dsh-base` and appends `talon-ui` as a bundle layer (it declares `dsh.bundle.patch`). No dsh code changes are involved.

Uninstall: remove `$DSH_HOME/profiles/talon`.
```

- [ ] **Step 5: Commit**

```bash
git add cordis.patch.yml docs/INSTALL.md README.md && git commit -m "feat: dsh bundle manifest and talon profile install flow"
```

---

### Task 11: Performance gate (100k-line injection)

**Files:**
- Create: `tests/perf.spec.ts`

**Interfaces:**
- Consumes: `Transcript`, `HeadlessTerminal`, controller.
- Produces: CI-runnable performance floor for spec D7.3 (keystroke echo <33ms at scale) and the zero-full-redraw assertion for D10.

- [ ] **Step 1: Write the gate**

```ts
// tests/perf.spec.ts
import { describe, expect, it } from 'vitest'
import { createPalette } from '../src/theme/palette.ts'
import { Transcript } from '../src/ui/transcript/transcript.ts'

describe('performance floors (spec D7.3, D10)', () => {
  it('mount-capped transcript render stays under 10ms per frame after 100k events', () => {
    const t = new Transcript(createPalette(true), { mountCapLines: 5000 })
    for (let i = 0; i < 100_000; i++) {
      if (i % 2 === 0) t.apply({ kind: 'user-message', text: `message number ${i} with some typical length text` })
      else {
        t.apply({ kind: 'stream-settle', turn: i, step: 1, content: [{ type: 'text', text: `reply ${i}` }] })
        t.apply({ kind: 'turn-end', turn: i, notice: undefined })
      }
    }
    // Steady-state frame: all cells cached; this is the per-keystroke cost shape.
    t.container.render(120) // warm
    const start = performance.now()
    for (let i = 0; i < 20; i++) t.container.render(120)
    const perFrame = (performance.now() - start) / 20
    expect(t.mountedLines(120)).toBeLessThanOrEqual(5010)
    expect(perFrame).toBeLessThan(10)
  })
  it('same-width renders allocate nothing new (cache identity at scale)', () => {
    const t = new Transcript(createPalette(true), { mountCapLines: 2000 })
    for (let i = 0; i < 5_000; i++) t.apply({ kind: 'user-message', text: `msg ${i}` })
    const a = t.container.children[1]!.render(100)
    expect(t.container.children[1]!.render(100)).toBe(a)
  })
})
```

- [ ] **Step 2: Run**

Run: `pnpm vitest run tests/perf.spec.ts`
Expected: PASS. If the 10ms floor fails, the mount cap or a cache is broken — investigate before loosening the number (the deleted TUI achieved 17ms **without** a mount cap at 4× the event count; a capped transcript must beat that comfortably).

- [ ] **Step 3: Full suite + commit**

Run: `pnpm test && pnpm typecheck`
Expected: everything green.

```bash
git add tests/perf.spec.ts && git commit -m "test: 100k-event performance gate and cache identity at scale"
```

---

## Self-Review (performed at authoring time)

1. **Spec coverage (T0+T1 acceptance):** boot+install (Tasks 8,10) ✓; TTY fail-loud (Task 9) ✓; exit all-paths incl. SIGTERM/failLoud/5s dispose cap (Task 9) ✓; contract layer + AppEvent (Task 4) ✓; transcript streaming + settle + role headers (Tasks 5,6) ✓; borderless composer + state line + hints (Task 7) ✓; keys Ctrl+C/Esc/Ctrl+L/Ctrl+D with panel-yield stub (Task 9) ✓; snapshot harness + first golden + themeViolations (Tasks 3,9) ✓; 100k perf gate + cache identity (Task 11) ✓; mount cap + setClearOnShrink(false) (Tasks 6,9) ✓; displayText everywhere user text renders (Tasks 5 tests) ✓. Deferred to later plans by design: PI_DEBUG_REDRAW zero-full-redraw snapshot assertion (needs interactive panel flows — T2 plan), PTY smoke (T2 plan, with panels worth proving), Markdown/tool cards/panels/commands (T2/T3/T4 plans).
2. **Placeholder scan:** no TBDs; two explicitly-marked verify-against-source steps exist where dsh signatures must be read at execution time (Task 8 Step 1, Task 10 Step 1 note) — each states the exact command and what to align.
3. **Type consistency:** `AppEvent` kinds used in Tasks 5/6/9/11 match Task 4's union; `Palette` role names match Task 2; `HeadlessTerminal.waitForFrame/frames/input/snapshot/themeViolations` usage in Tasks 7/9 matches Task 3; `Composer.setState/setHint/onSubmit/editor` in Task 9 matches Task 7; `Transcript.apply/container/mountedLines` in Tasks 9/11 matches Task 6.
