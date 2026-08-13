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
