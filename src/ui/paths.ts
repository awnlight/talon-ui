/** How talon shows a filesystem path (spec §8 T4, the Windows leg).
 *
 * One implementation, because there were two: the footer and the terminal card
 * each abbreviated `$HOME` their own way, and each was POSIX-only.
 *
 * Windows makes three demands that a `startsWith(home + '/')` cannot meet:
 *   - `\` and `/` are BOTH separators, and a path may mix them;
 *   - path comparison is case-insensitive (`C:\Users\Devbox` is `c:\users\devbox`);
 *   - and a path on another DRIVE is not under the home directory at all,
 *     however much of the string happens to match.
 *
 * `platform` and `home` are parameters rather than reads so the Windows shapes
 * are tested on every platform — which is the only way this file gets tested
 * at all until a Windows runner exists. */
import { homedir } from 'node:os'

const TILDE = '~'

/** Replace a leading home directory with `~`. Anything not genuinely under
 * home — a different drive, a different user, a near-miss prefix — is returned
 * untouched: an abbreviation that lies about WHERE a path is is worse than a
 * long path. */
export function abbreviateHome(path: string, home: string = homedir(), platform: string = process.platform): string {
  const windows = platform === 'win32'
  const fold = (value: string): string => (windows ? value.replaceAll('\\', '/').toLowerCase() : value)
  const foldedPath = fold(path)
  const foldedHome = fold(home).replace(/\/+$/u, '')
  if (foldedHome === '' || foldedPath === '') return path
  if (foldedPath === foldedHome) return TILDE
  // The separator must be REAL, not a prefix accident: `/home/devboxial` is
  // not under `/home/devbox`.
  if (!foldedPath.startsWith(`${foldedHome}/`)) return path
  return TILDE + path.slice(home.replace(/[\\/]+$/u, '').length)
}

/** The LAST segment of a path — what the FOOTER shows.
 *
 * Bottom-bar width is the scarcest space in the whole UI, and a working
 * directory spends it fastest: `~/Dev/proj/for-private/agents/deepseek-harness`
 * is 44 columns of mostly-constant prefix sitting beside the handful of
 * segments that actually change. The full path belongs in the boot banner,
 * which has room for it and is read once; the footer keeps the one segment
 * that tells you WHICH project you are in.
 *
 * `~` and a bare root answer themselves rather than emptying — a footer that
 * says nothing about where you are is worse than one that says `~`. */
export function projectName(path: string, home?: string, platform?: string): string {
  const abbreviated = abbreviateHome(path, home, platform)
  const segments = abbreviated.split(/[\\/]+/u).filter((segment) => segment !== '')
  return segments[segments.length - 1] ?? abbreviated
}
