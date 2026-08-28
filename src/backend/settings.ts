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
 * that always starts dark with notifications on.
 *
 * The SCHEMA is built here and taken by nobody: `ctx.settings.register` wants a
 * schemastery schema — a CALLABLE that validates and applies defaults, which
 * the service invokes during registration — and passing it in as a parameter is
 * exactly what let a plain JSON-Schema object through to a live boot once. Only
 * this module knows the shape, so only this module supplies it. */
import z from '@deepseek-ai/schemastery'

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

/** The slice of `ctx.settings` talon uses. `schema` is a schemastery schema,
 * which the service CALLS — see `TALON_SETTINGS_SCHEMA`. */
export interface SettingsServiceFacet {
  register(namespace: string, schema: unknown): SettingsScopeFacet
}

/** What the settings service validates this namespace with, and what a
 * configuration surface renders it from. Schemastery, not JSON Schema: the
 * service calls it (`schema(merged)`) to resolve defaults over the stored
 * section, so a plain object throws `schema is not a function` at boot. */
export const TALON_SETTINGS_SCHEMA = z.object({
  scheme: z.union(['dark', 'light'] as const).default(DEFAULT_SETTINGS.scheme).description('Which half of the ANSI-16 palette to resolve.'),
  notifications: z.boolean().default(DEFAULT_SETTINGS.notifications).description('Notify an unfocused terminal when a turn ends.'),
})

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
  onChange: (settings: TalonSettings) => void,
): SettingsBinding {
  if (service === undefined) {
    return { current: () => DEFAULT_SETTINGS, update: async () => {}, dispose: () => {} }
  }
  const scope = service.register(TALON_NAMESPACE, TALON_SETTINGS_SCHEMA)
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
