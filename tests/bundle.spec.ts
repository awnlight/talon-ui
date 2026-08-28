/** The bundle layer's one hard law, made a test instead of a boot failure.
 *
 * talon's `cordis.patch.yml` is composed ON TOP of `@deepseek-ai/dsh-base`.
 * A row whose id base already carries is not a harmless override — the loader
 * refuses the whole tree with `duplicate loader entry id`, and the UI never
 * starts. That is precisely what dsh 0.1.2-alpha.1 did to talon: base adopted
 * `storage`, `storage-json`, `storage-domain` and `session-projection-cache`,
 * which talon had been inserting itself since 0.1.1-rc.1, and the next boot
 * died before the first frame.
 *
 * Nothing in the unit suite could see that, because the bundle is data the
 * LOADER reads, not code talon runs. So this file reads both documents and
 * compares them — the drift now fails here, on the checkout that introduced
 * it, rather than in front of whoever next runs `pnpm dsh --profile talon`. */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const TALON_PATCH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const BASE_PATCH = fileURLToPath(new URL('../../deepseek-harness/packages/bundle/base/cordis.patch.yml', import.meta.url))

/** Row ids, read without a YAML dependency: an id line is `- id: <name>`,
 * and a commented one does not count. */
function rowIds(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => /^\s*-\s+id:\s*(\S+)\s*$/u.exec(line)?.[1])
    .filter((id): id is string => id !== undefined)
}

describe('the talon bundle layer composes only what dsh-base does not', () => {
  it('reads its own rows', () => {
    const ids = rowIds(TALON_PATCH)
    // The two rows talon must carry, and its own two plugins.
    expect(ids).toEqual(['tool-ask-user', 'file-reference', 'talon-boot', 'talon'])
  })

  it.runIf(existsSync(BASE_PATCH))('shares NO row id with dsh-base — a duplicate is a boot failure', () => {
    const base = new Set(rowIds(BASE_PATCH))
    expect(base.size, 'the base bundle should have parsed').toBeGreaterThan(20)
    const duplicates = rowIds(TALON_PATCH).filter((id) => base.has(id))
    expect(duplicates, 'dsh-base now carries these; drop them from cordis.patch.yml').toEqual([])
  })

  it.runIf(existsSync(BASE_PATCH))('still needs every row it keeps — base carries neither by name', () => {
    const base = readFileSync(BASE_PATCH, 'utf8')
    for (const pkg of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-file-reference-local']) {
      expect(base, `base now composes ${pkg}: talon's row is redundant`).not.toContain(pkg)
    }
  })
})
