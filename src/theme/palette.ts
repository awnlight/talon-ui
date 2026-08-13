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
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, (c) => `\\x${c.codePointAt(0)!.toString(16).padStart(2, '0')}`)
}
