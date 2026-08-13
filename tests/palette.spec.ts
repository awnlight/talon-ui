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
