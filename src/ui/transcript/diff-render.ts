/** The diff card's body (spec §4.2, D12): line-numbered hunks with a two-space
 * indent, `+` success / `−` error / context dim, and a `└ +a −r · n file(s)`
 * summary tail.
 *
 * The durable input is dsh's `FileDiff`, which is ONE PER HUNK and already
 * contextual (`DIFF_CONTEXT = 3` on each side, tool-fs/src/diff.ts), with
 * `oldText: null` for a pure insertion. It carries no file offset —
 * `computeHunkDiffs` drops structuredPatch's `oldStart`/`newStart` before the
 * hunk is persisted — so the dual counters number what a reader can SEE in the
 * hunk rather than inventing a file position the log never recorded. */
import { displayText, type Palette } from '../../theme/palette.js'

/** dsh's durable hunk shape (`tool/result.meta` → `{ diffs }`). */
export interface FileDiff { path: string; oldText: string | null; newText: string }

/** Past this many lines in one hunk the exact walk is abandoned: the LCS below
 * is O(n·m), and a hunk that large is a paste, not something anyone reads line
 * by line (D7.6 — the approximate side-by-side render costs nothing). */
export const MAX_DIFF_LINES = 1000

const INDENT = '  '
const ADDED = '+'
const REMOVED = '−'          // U+2212 MINUS SIGN, the glyph spec §4.2 names
const CONTEXT = ' '

/** Narrow the opaque, replayed `meta` to hunks — malformed or absent payloads
 * answer `undefined` so the card falls back instead of throwing mid-replay
 * (dsh's own `diffsFromMeta` makes the same promise). An empty `diffs` array is
 * a refusal too: that is what a create records, and its change comes from the
 * call arguments instead. */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string' && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
}

interface DiffRow { op: string; num: number; text: string }

/** Spec §4.2: the rendered result is cached by the diffs array's object
 * identity, so a card that re-derives its body never re-walks the LCS. The
 * palette and the head path ride along because they change what the same hunks
 * render as. */
const rendered = new WeakMap<readonly FileDiff[], { palette: Palette; headPath: string | undefined; lines: string[] }>()

/** Render applied hunks as card body lines. `headPath` is the path the card's
 * head already names: the per-file header is suppressed when it would just
 * repeat it (the old TUI's suppression fix). */
export function renderFileDiffs(diffs: readonly FileDiff[], palette: Palette, headPath?: string): string[] {
  const hit = rendered.get(diffs)
  if (hit !== undefined && hit.palette === palette && hit.headPath === headPath) return hit.lines
  const lines = buildLines(diffs, palette, headPath)
  rendered.set(diffs, { palette, headPath, lines })
  return lines
}

function buildLines(diffs: readonly FileDiff[], palette: Palette, headPath: string | undefined): string[] {
  const hunks = diffs.map(walkHunk)
  const paths = [...new Set(diffs.map((diff) => diff.path))]
  const showPaths = paths.length > 1 || paths[0] !== headPath
  const numWidth = String(Math.max(...hunks.flatMap((hunk) => hunk.rows.map((row) => row.num)), 1)).length

  const lines: string[] = []
  let added = 0
  let removed = 0
  let approximate = false
  let shown: string | undefined
  for (const [index, hunk] of hunks.entries()) {
    const path = diffs[index]!.path
    if (showPaths && path !== shown) lines.push(palette.bold(displayText(path)))
    shown = path
    for (const row of hunk.rows) {
      if (row.op === ADDED) added++
      else if (row.op === REMOVED) removed++
      const tone = row.op === ADDED ? palette.success : row.op === REMOVED ? palette.error : palette.dim
      lines.push(`${INDENT}${palette.dim(String(row.num).padStart(numWidth))} ${tone(`${row.op} ${displayText(row.text)}`)}`)
    }
    if (hunk.approximate) {
      approximate = true
      lines.push(palette.dim(`${INDENT}[exact line diff omitted: >${MAX_DIFF_LINES} changed lines]`))
    }
  }
  const files = `${paths.length} file${paths.length === 1 ? '' : 's'}`
  lines.push(palette.dim(`└ +${added} −${removed} · ${files}${approximate ? ' · approximate' : ''}`))
  return lines
}

/** One hunk's rows, plus whether the guard downgraded it. */
interface HunkRows { rows: DiffRow[]; approximate: boolean }

function walkHunk(diff: FileDiff): HunkRows {
  const before = splitSide(diff.oldText)
  const after = splitSide(diff.newText)
  // Past the guard the sides are shown whole, one after the other: every old
  // line removed, every new line added. Approximate, and labelled as such.
  const approximate = before.length + after.length > MAX_DIFF_LINES
  const ops = approximate
    ? [...before.map((text) => ({ op: REMOVED, text })), ...after.map((text) => ({ op: ADDED, text }))]
    : commonSubsequenceOps(before, after)

  // The dual counters (spec §4.2): an addition advances the new side, a removal
  // the old side, a context line both.
  const rows: DiffRow[] = []
  let oldNo = 1
  let newNo = 1
  for (const op of ops) {
    if (op.op === ADDED) rows.push({ op: ADDED, num: newNo++, text: op.text })
    else if (op.op === REMOVED) rows.push({ op: REMOVED, num: oldNo++, text: op.text })
    else { rows.push({ op: CONTEXT, num: newNo, text: op.text }); oldNo++; newNo++ }
  }
  return { rows, approximate }
}

/** An absent side (a create's `oldText: null`) and an empty one (a hunk that
 * removes everything) both mean zero lines — not one blank line. */
function splitSide(text: string | null): string[] {
  return text === null || text === '' ? [] : text.split('\n')
}

/** Hand-rolled LCS over hunk lines. O(n·m) is affordable at hunk scale — the
 * hunks arrive pre-cut with three context lines a side — and the guard above
 * bounds the worst case, so no diff dependency is worth taking (D7.6). */
function commonSubsequenceOps(before: string[], after: string[]): { op: string; text: string }[] {
  const n = before.length
  const m = after.length
  const stride = m + 1
  const lcs = new Int32Array((n + 1) * stride)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * stride + j] = before[i] === after[j]
        ? lcs[(i + 1) * stride + j + 1]! + 1
        : Math.max(lcs[(i + 1) * stride + j]!, lcs[i * stride + j + 1]!)
    }
  }
  const ops: { op: string; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) { ops.push({ op: CONTEXT, text: before[i]! }); i++; j++ }
    else if (lcs[(i + 1) * stride + j]! >= lcs[i * stride + j + 1]!) { ops.push({ op: REMOVED, text: before[i]! }); i++ }
    else { ops.push({ op: ADDED, text: after[j]! }); j++ }
  }
  for (; i < n; i++) ops.push({ op: REMOVED, text: before[i]! })
  for (; j < m; j++) ops.push({ op: ADDED, text: after[j]! })
  return ops
}
