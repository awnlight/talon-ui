import { describe, expect, it } from 'vitest'
import { BRAND_STOPS, brandGradient, createPalette, displayText, onBrandGradient, paletteSpec, paletteTable } from '../src/theme/palette.ts'

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

describe('brand truecolor layer (spec D6/§7.1)', () => {
  it('paints one rgb FOREGROUND per character across the three teal stops', () => {
    const gradient = brandGradient('talon', createPalette(true, 'dark', true))
    expect(gradient.startsWith('\x1b[38;2;45;212;191m')).toBe(true)      // #2DD4BF, the first stop
    expect(gradient.endsWith('\x1b[38;2;13;148;136mn\x1b[39m')).toBe(true) // #0D9488, the last
    expect(gradient).not.toMatch(/\x1b\[48;/)                            // never a background
    expect([...gradient.matchAll(/\x1b\[38;2;/g)].length).toBe(5)        // one per character
  })

  it('falls back to the ANSI-16 brand role without truecolor, and to plain text without colour', () => {
    expect(brandGradient('talon', createPalette(true, 'dark', false))).toBe('\x1b[36mtalon\x1b[39m')
    expect(brandGradient('talon', createPalette(false, 'dark', true))).toBe('talon')
    expect(brandGradient('', createPalette(true, 'dark', true))).toBe('')
    expect(brandGradient('t', createPalette(true, 'dark', true))).toBe('\x1b[38;2;45;212;191mt\x1b[39m')
  })

  it('recognizes every colour the ramp can produce, and nothing else', () => {
    for (const stop of BRAND_STOPS) expect(onBrandGradient((stop[0] << 16) | (stop[1] << 8) | stop[2])).toBe(true)
    // Every colour a real gradient emits must pass the gate that guards it.
    for (const match of brandGradient('a longer talon wordmark', createPalette(true, 'dark', true)).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)) {
      expect(onBrandGradient((Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3]))).toBe(true)
    }
    for (const stray of [0xff0000, 0x00ff00, 0x0000ff, 0xffffff, 0x000000, 0x2dd4c0, 0x2ed4bf]) {
      expect(onBrandGradient(stray), stray.toString(16)).toBe(false)
    }
  })
})

describe('paletteTable (D6: the table cannot drift from the spec)', () => {
  it('prints every role from paletteSpec, with its live SGR codes', () => {
    const table = paletteTable(createPalette(true, 'dark'))
    const spec = paletteSpec('dark')
    const lines = table.split('\n')
    expect(lines[0]).toBe('talon palette · dark')
    expect(lines[1]).toMatch(/^role\s+open\s+close\s+purpose$/)
    for (const [role, { open, close, purpose }] of [...Object.entries(spec.colors), ...Object.entries(spec.attributes)]) {
      const row = lines.find((line) => line.startsWith(`${role} `) || line === role)
      expect(row, role).toBeDefined()
      expect(row).toContain(purpose)
      expect(row).toContain(open === '' ? '—' : open)
      expect(row).toContain(close === '' ? '—' : close)
    }
    expect(lines.length).toBe(2 + Object.keys(spec.colors).length + Object.keys(spec.attributes).length)
    expect(paletteTable(createPalette(true, 'light'))).toContain('34')   // the one scheme-dependent role
  })
})
