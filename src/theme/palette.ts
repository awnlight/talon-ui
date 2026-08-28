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
  /** Whether the terminal reports truecolor. Read at BOOT from
   * `getCapabilities()` and carried here rather than probed at render time, so
   * a committed golden can never depend on the terminal that ran the suite. */
  readonly trueColor: boolean
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
export function createPalette(enabled: boolean, scheme: ColorScheme = 'dark', trueColor = false): Palette {
  const spec = paletteSpec(scheme)
  return {
    enabled,
    scheme,
    trueColor,
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
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, (c) => `\\x${c.codePointAt(0)!.toString(16).padStart(2, '0')}`)
}

/** The brand teal, three stops (spec D6). talon's ONLY truecolor surface. */
export const BRAND_STOPS: readonly (readonly [number, number, number])[] = [
  [0x2d, 0xd4, 0xbf],
  [0x14, 0xb8, 0xa6],
  [0x0d, 0x94, 0x88],
]

/** The brand wordmark, teal across the three stops, one colour per character —
 * rgb-FOREGROUND only, never a background, and only where the terminal reports
 * truecolor. Everywhere else the ANSI-16 `brand` role (36) carries it, which is
 * what D6 means by "ANSI 降级 36". */
export function brandGradient(text: string, palette: Palette): string {
  if (!palette.enabled || !palette.trueColor) return palette.brand(text)
  const chars = [...text]
  if (chars.length === 0) return ''
  const painted = chars.map((char, i) => {
    const [r, g, b] = gradientAt(chars.length === 1 ? 0 : i / (chars.length - 1))
    return `\x1b[38;2;${r};${g};${b}m${char}`
  })
  return `${painted.join('')}\x1b[39m`
}

/** Whether an rgb foreground sits ON the brand ramp — the ONE exemption the
 * theme gate grants (spec §7.1). Exact rather than approximate: each channel
 * constrains the interpolation parameter to an interval, and the colour is on
 * the ramp iff all three intervals intersect somewhere in [0, 1]. Anything
 * else — any other rgb foreground, and every rgb background — still violates. */
export function onBrandGradient(color: number): boolean {
  const rgb: [number, number, number] = [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
  for (let i = 0; i + 1 < BRAND_STOPS.length; i++) {
    if (onSegment(rgb, BRAND_STOPS[i]!, BRAND_STOPS[i + 1]!)) return true
  }
  return false
}

function onSegment(rgb: readonly number[], a: readonly number[], b: readonly number[]): boolean {
  let lo = 0
  let hi = 1
  for (let c = 0; c < 3; c++) {
    // A zero span needs no special case: the divisions yield ±Infinity, which
    // leaves the interval unconstrained when the channel already matches and
    // empties it when it does not — exactly the right answers.
    const span = b[c]! - a[c]!
    const first = (rgb[c]! - 0.5 - a[c]!) / span
    const second = (rgb[c]! + 0.5 - a[c]!) / span
    lo = Math.max(lo, Math.min(first, second))
    hi = Math.min(hi, Math.max(first, second))
  }
  return lo <= hi
}

function gradientAt(t: number): [number, number, number] {
  const segments = BRAND_STOPS.length - 1
  const scaled = Math.min(t * segments, segments - Number.EPSILON)
  const index = Math.floor(scaled)
  const from = BRAND_STOPS[index]!
  const to = BRAND_STOPS[index + 1]!
  const local = scaled - index
  return [0, 1, 2].map((c) => Math.round(from[c]! + (to[c]! - from[c]!) * local)) as [number, number, number]
}

const TABLE_HEAD = ['role', 'open', 'close', 'purpose'] as const
const NO_SGR = '—'

/** `/palette` self-prints the live spec table (D6): generated FROM
 * `paletteSpec`, so the documented colours can never drift from the emitted
 * ones. Plain text by law — command output travels the same durable notice
 * path every plugin's does, and that path escapes control characters before
 * styling (D7.8); carving an ANSI exception for one command is exactly the
 * hole that rule exists to close. The SGR codes are IN the table instead. */
export function paletteTable(palette: Palette): string {
  const spec = paletteSpec(palette.scheme)
  const rows = [...Object.entries(spec.colors), ...Object.entries(spec.attributes)]
    .map(([role, { open, close, purpose }]) => [role, open === '' ? NO_SGR : open, close === '' ? NO_SGR : close, purpose])
  const widths = TABLE_HEAD.map((head, i) => Math.max(head.length, ...rows.map((row) => row[i]!.length)))
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]!))).join('  ')
  return [`talon palette · ${palette.scheme}`, line(TABLE_HEAD), ...rows.map(line)].join('\n')
}
