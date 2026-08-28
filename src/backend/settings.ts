/** talon's persisted PREFERENCES (spec §3.10).
 *
 * The line this module exists to hold: **preference persists, session UI state
 * never does.** The colour scheme and whether to notify are things a user
 * decides once and expects to find again tomorrow. Ctrl+O's visibility mode,
 * Ctrl+R's reasoning toggle, the queued badge, the glyph phase and every panel
 * are things about THIS session on THIS screen — spec §3.10 says they are
 * either ephemeral or strictly derived from recorded events, so they never
 * reach this file and `tests/settings.spec.ts` asserts that they cannot.
 *
 * `ctx.settings` is optional by composition, so everything here degrades to
 * defaults rather than failing: a talon without a settings service is a talon
 * that always starts dark with notifications on. */

/** What talon remembers between runs. Deliberately small. */
export interface TalonSettings {
  /** Which half of the ANSI-16 palette to resolve (`code` is the one role
   * that differs between schemes — D6). */
  scheme: 'dark' | 'light'
  /** Whether an unfocused terminal is notified when a turn ends. */
  notifications: boolean
}

export const DEFAULT_SETTINGS: TalonSettings = { scheme: 'dark', notifications: true }

/** The keys this namespace owns. Anything else is a bug, and the guard below
 * treats it as one rather than quietly persisting session state. */
export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof TalonSettings)[]

/** The slice of one registered `SettingsScope` talon uses. */
export interface SettingsScopeFacet {
  get(): Partial<TalonSettings>
  watch(callback: (next: Partial<TalonSettings>) => void): () => void
  update(patch: object): Promise<void>
}

/** The slice of `ctx.settings` talon uses. */
export interface SettingsServiceFacet {
  register(namespace: string, schema: unknown): SettingsScopeFacet
}

export const TALON_NAMESPACE = 'talon'

/** Resolve one stored section over the defaults, discarding anything the
 * namespace does not own and anything of the wrong shape — an externally
 * edited document must not be able to strand the UI. */
export function resolveSettings(stored: Partial<TalonSettings> | undefined): TalonSettings {
  const scheme = stored?.scheme
  const notifications = stored?.notifications
  return {
    scheme: scheme === 'dark' || scheme === 'light' ? scheme : DEFAULT_SETTINGS.scheme,
    notifications: typeof notifications === 'boolean' ? notifications : DEFAULT_SETTINGS.notifications,
  }
}

/** Refuse a patch carrying anything outside this namespace. The §3.10 law is
 * worth a runtime guard, not just a comment: a future caller reaching for
 * `update({ cardVisibility })` fails here instead of writing session state to
 * a user's home directory. */
export function assertPreferenceOnly(patch: object): void {
  const stray = Object.keys(patch).filter((key) => !SETTINGS_KEYS.includes(key as keyof TalonSettings))
  if (stray.length > 0) throw new Error(`talon settings own only ${SETTINGS_KEYS.join(', ')} — refusing to persist ${stray.join(', ')}`)
}

export interface SettingsBinding {
  current(): TalonSettings
  /** Persist a preference change. Rejects anything that is not one. */
  update(patch: Partial<TalonSettings>): Promise<void>
  dispose(): void
}

/** Bind to the settings service if there is one; otherwise hand back the
 * defaults, permanently. `onChange` fires for a committed external edit too —
 * a user editing the document by hand should see the UI follow. */
export function bindSettings(
  service: SettingsServiceFacet | undefined,
  schema: unknown,
  onChange: (settings: TalonSettings) => void,
): SettingsBinding {
  if (service === undefined) {
    return { current: () => DEFAULT_SETTINGS, update: async () => {}, dispose: () => {} }
  }
  const scope = service.register(TALON_NAMESPACE, schema)
  let settings = resolveSettings(scope.get())
  const stop = scope.watch((next) => {
    settings = resolveSettings(next)
    onChange(settings)
  })
  return {
    current: () => settings,
    update: async (patch) => {
      assertPreferenceOnly(patch)
      await scope.update(patch)
    },
    dispose: stop,
  }
}
