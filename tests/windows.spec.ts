/** The Windows leg of spec §8 T4 ("Windows 快照稳定"), made verifiable HERE.
 *
 * A Windows machine changes exactly two things about this suite, and neither
 * needs a Windows machine to test:
 *
 *   1. LINE ENDINGS. `core.autocrlf=true` is the Windows default, so a
 *      checkout would rewrite every byte-compared golden and the recorded
 *      session fixture to CRLF. `.gitattributes` pins them to LF; the tests
 *      below assert that the pin actually holds for every committed file, and
 *      that the fixture reader survives CRLF anyway.
 *   2. PATHS. Drive letters, backslashes and case-insensitive comparison —
 *      covered in `tests/paths.spec.ts`, which runs the Windows shapes on
 *      every platform.
 *
 * What still needs a real Windows runner is the PTY leg (ConPTY vs POSIX pty),
 * which is `tests/e2e` and skips itself without an API key regardless. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { readSessionLog } from './helpers/session-log.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./replay/coding-session/session.jsonl', import.meta.url))

/** Every committed text file git would touch on a Windows checkout. */
function committedTextFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '' && /\.(txt|jsonl|ts|md|json|yml|yaml)$/u.test(path))
}

describe('Windows snapshot stability (spec §8 T4)', () => {
  it('commits every golden and fixture with LF endings — a CRLF checkout would fail them all', () => {
    const offenders = committedTextFiles().filter((path) => readFileSync(join(REPO, path), 'utf8').includes('\r'))
    expect(offenders, 'these carry CR and would break the goldens on a Windows checkout').toEqual([])
  })

  it('pins those endings in .gitattributes, so a Windows checkout cannot reintroduce them', () => {
    const attributes = readFileSync(join(REPO, '.gitattributes'), 'utf8')
    expect(attributes).toMatch(/^\* text=auto eol=lf$/mu)
    for (const family of ['*.expected.txt', '*.jsonl']) expect(attributes).toContain(family)
  })

  it('parses a CRLF session log identically to an LF one — the reader is the second lock', () => {
    const lf = readSessionLog(FIXTURE)
    const dir = mkdtempSync(join(tmpdir(), 'talon-crlf-'))
    try {
      const crlf = join(dir, 'session.jsonl')
      writeFileSync(crlf, readFileSync(FIXTURE, 'utf8').replaceAll('\n', '\r\n'))
      const reread = readSessionLog(crlf)
      expect(reread.header).toEqual(lf.header)
      expect(reread.events.length).toBe(lf.events.length)
      expect(reread.events[0]).toEqual(lf.events[0])
      expect(reread.events.at(-1)).toEqual(lf.events.at(-1))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('composes filesystem paths through node:path, in the two modules that build any', () => {
    // Not a source-wide grep for '/': that flagged `routeKey`'s
    // `provider/model`, which is a model route and platform-independent. The
    // check that earns its place is the concrete one — the modules that touch
    // the filesystem go through node:path, so the separator is the platform's.
    for (const path of ['src/app/controller.ts', 'src/ui/composer/paste.ts']) {
      expect(readFileSync(join(REPO, path), 'utf8'), path).toMatch(/from 'node:path'/u)
    }
    expect(join('a', 'b')).toBe(`a${sep}b`)
  })
})
