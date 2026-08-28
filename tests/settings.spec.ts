import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS, SETTINGS_KEYS, TALON_NAMESPACE, assertPreferenceOnly, bindSettings, resolveSettings,
  type SettingsScopeFacet, type TalonSettings,
} from '../src/backend/settings.ts'

function fakeService(stored: Partial<TalonSettings> = {}) {
  let section = { ...stored }
  let observer: ((next: Partial<TalonSettings>) => void) | undefined
  const namespaces: string[] = []
  const patches: object[] = []
  const scope: SettingsScopeFacet = {
    get: () => section,
    watch: (callback) => { observer = callback; return () => { observer = undefined } },
    update: async (patch) => { patches.push(patch); section = { ...section, ...patch }; observer?.(section) },
  }
  return {
    namespaces, patches,
    watching: () => observer !== undefined,
    service: { register: (namespace: string) => { namespaces.push(namespace); return scope } },
  }
}

describe('resolveSettings — an externally edited document cannot strand the UI', () => {
  it('resolves stored values over the defaults', () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings({})).toEqual(DEFAULT_SETTINGS)
    expect(resolveSettings({ scheme: 'light', notifications: false })).toEqual({ scheme: 'light', notifications: false })
  })
  it('discards a value of the wrong shape rather than adopting it', () => {
    expect(resolveSettings({ scheme: 'neon' as never, notifications: 'yes' as never })).toEqual(DEFAULT_SETTINGS)
  })
})

describe('assertPreferenceOnly (spec §3.10 — the law, with teeth)', () => {
  it('accepts the keys this namespace owns', () => {
    expect(SETTINGS_KEYS.sort()).toEqual(['notifications', 'scheme'])
    expect(() => assertPreferenceOnly({ scheme: 'light' })).not.toThrow()
    expect(() => assertPreferenceOnly({})).not.toThrow()
  })
  it('REFUSES session UI state — the thing §3.10 forbids persisting', () => {
    for (const forbidden of [{ cardVisibility: 'hidden' }, { showReasoning: false }, { queued: 2 }, { scheme: 'light', glyphPhase: 'tools' }]) {
      expect(() => assertPreferenceOnly(forbidden), JSON.stringify(forbidden)).toThrow(/refusing to persist/)
    }
  })
})

describe('bindSettings', () => {
  it('runs on the defaults, permanently, with no settings service', async () => {
    const changes: TalonSettings[] = []
    const binding = bindSettings(undefined, {}, (next) => changes.push(next))
    expect(binding.current()).toEqual(DEFAULT_SETTINGS)
    await binding.update({ scheme: 'light' })      // accepted, and simply has nowhere to go
    expect(binding.current()).toEqual(DEFAULT_SETTINGS)
    expect(changes).toEqual([])
    expect(() => binding.dispose()).not.toThrow()
  })

  it('registers the talon namespace, resolves what is stored, and follows a committed change', async () => {
    const fake = fakeService({ scheme: 'light' })
    const changes: TalonSettings[] = []
    const binding = bindSettings(fake.service, {}, (next) => changes.push(next))
    expect(fake.namespaces).toEqual([TALON_NAMESPACE])
    expect(binding.current()).toEqual({ scheme: 'light', notifications: true })

    await binding.update({ notifications: false })
    expect(fake.patches).toEqual([{ notifications: false }])
    expect(binding.current()).toEqual({ scheme: 'light', notifications: false })
    expect(changes.at(-1)).toEqual({ scheme: 'light', notifications: false })
  })

  it('refuses to persist session state, and stops watching on dispose', async () => {
    const fake = fakeService()
    const binding = bindSettings(fake.service, {}, () => {})
    await expect(binding.update({ cardVisibility: 'hidden' } as never)).rejects.toThrow(/refusing to persist/)
    expect(fake.patches).toEqual([])              // nothing reached the store
    expect(fake.watching()).toBe(true)
    binding.dispose()
    expect(fake.watching()).toBe(false)
  })
})
