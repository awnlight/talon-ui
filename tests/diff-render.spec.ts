import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { diffsFromMeta, MAX_DIFF_LINES, renderFileDiffs, type FileDiff } from '../src/ui/transcript/diff-render.ts'

const p = createPalette(false)
const colored = createPalette(true)
const hunk = (path: string, oldText: string | null, newText: string): FileDiff => ({ path, oldText, newText })

describe('diffsFromMeta (defensive narrowing of an opaque replayed payload)', () => {
  it('accepts the shape dsh persists and rejects everything else', () => {
    const diffs = [hunk('a.ts', 'x', 'y')]
    expect(diffsFromMeta({ diffs })).toEqual(diffs)
    expect(diffsFromMeta({ diffs: [{ path: 'a.ts', oldText: null, newText: 'y' }] })).toEqual([hunk('a.ts', null, 'y')])
    expect(diffsFromMeta(undefined)).toBeUndefined()
    expect(diffsFromMeta(null)).toBeUndefined()
    expect(diffsFromMeta('diffs')).toBeUndefined()
    expect(diffsFromMeta([])).toBeUndefined()                              // an array is not the envelope
    expect(diffsFromMeta({ diffs: [] })).toBeUndefined()                   // a create records no hunks
    expect(diffsFromMeta({ diffs: 'x' })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [{ path: 1, oldText: null, newText: 'y' }] })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [{ path: 'a', oldText: 2, newText: 'y' }] })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [{ path: 'a', oldText: null }] })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [null] })).toBeUndefined()
    expect(diffsFromMeta({ diffs: [['a.ts', null, 'y']] })).toBeUndefined()   // an array is not a hunk
  })
})

describe('renderFileDiffs (spec §4.2 diff card)', () => {
  it('numbers both sides from its own counters and tones +/− and context', () => {
    // One applied hunk as computeHunkDiffs emits it: context, a replacement, context.
    const rows = renderFileDiffs([hunk('src/a.ts', 'const a = 1\nconst b = 2\nconst c = 3', 'const a = 1\nconst b = 9\nconst c = 3')], p)
    expect(rows).toEqual([
      'src/a.ts',
      '  1   const a = 1',
      '  2 − const b = 2',
      '  2 + const b = 9',
      '  3   const c = 3',
      '└ +1 −1 · 1 file',
    ])
  })

  it('is hunk-relative, not file-absolute — the durable FileDiff carries no offset', () => {
    // Two hunks of one file: dsh drops structuredPatch's oldStart/newStart, so
    // the second hunk restarts at 1 rather than inventing a file position.
    const rows = renderFileDiffs([hunk('a.ts', 'one', 'ONE'), hunk('a.ts', 'two', 'TWO')], p, 'a.ts')
    expect(rows).toEqual(['  1 − one', '  1 + ONE', '  1 − two', '  1 + TWO', '└ +2 −2 · 1 file'])
  })

  it('renders a create (oldText null) as all additions', () => {
    expect(renderFileDiffs([hunk('new.ts', null, 'a\nb')], p, 'new.ts')).toEqual([
      '  1 + a',
      '  2 + b',
      '└ +2 −0 · 1 file',
    ])
  })

  it('renders a pure deletion, where the new side is empty', () => {
    expect(renderFileDiffs([hunk('gone.ts', 'a\nb', '')], p, 'gone.ts')).toEqual([
      '  1 − a',
      '  2 − b',
      '└ +0 −2 · 1 file',
    ])
  })

  it('heads each file in bold across a multi-file diff and counts them in the summary', () => {
    const rows = renderFileDiffs([hunk('a.ts', 'x', 'y'), hunk('b.ts', null, 'z')], colored, 'a.ts')
    expect(rows[0]).toBe(colored.bold('a.ts'))
    expect(rows).toContain(colored.bold('b.ts'))
    expect(rows.at(-1)).toBe(colored.dim('└ +2 −1 · 2 files'))
  })

  it('suppresses the path header only when the card head already carries the one path', () => {
    expect(renderFileDiffs([hunk('a.ts', 'x', 'y')], p, 'a.ts')[0]).toBe('  1 − x')
    expect(renderFileDiffs([hunk('a.ts', 'x', 'y')], p, 'other.ts')[0]).toBe('a.ts')
    expect(renderFileDiffs([hunk('a.ts', 'x', 'y')], p)[0]).toBe('a.ts')
  })

  it('abandons the exact walk past the guard and says so', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    const rows = renderFileDiffs([hunk('big.ts', big, big)], p, 'big.ts')
    expect(rows).toContain(`  [exact line diff omitted: >${MAX_DIFF_LINES} changed lines]`)
    expect(rows[0]).toBe('     1 − line 0')                                 // the whole old side, then the whole new side
    expect(rows.at(-1)).toBe(`└ +${MAX_DIFF_LINES + 1} −${MAX_DIFF_LINES + 1} · 1 file · approximate`)
  })

  it('right-aligns the number column to the widest number in the card', () => {
    const rows = renderFileDiffs([hunk('a.ts', null, Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'))], p, 'a.ts')
    expect(rows[0]).toBe('   1 + l0')
    expect(rows[9]).toBe('  10 + l9')
  })

  it('caches the rendered result by the diffs array identity (spec §4.2)', () => {
    const diffs = [hunk('a.ts', 'x', 'y')]
    const first = renderFileDiffs(diffs, p, 'a.ts')
    expect(renderFileDiffs(diffs, p, 'a.ts')).toBe(first)                   // identity: the walk ran once
    expect(renderFileDiffs(diffs, colored, 'a.ts')).not.toBe(first)         // a different palette re-renders
    expect(renderFileDiffs(diffs, p, 'other.ts')).not.toBe(first)           // so does a different head path
    expect(renderFileDiffs([hunk('a.ts', 'x', 'y')], p, 'a.ts')).not.toBe(first)
  })

  it('escapes hostile content in paths and in diff text before toning (D7.8)', () => {
    const rows = renderFileDiffs([hunk('a\x1b]0;evil\x07.ts', null, 'x\x1b[2Jy')], p)
    expect(rows[0]).toBe('a\\x1b]0;evil\\x07.ts')
    expect(rows[1]).toBe('  1 + x\\x1b[2Jy')
  })

  it('keeps every entry a single logical line, so the mount cap and the fold stay honest', () => {
    const rows = renderFileDiffs([hunk('a.ts', 'x\ny', 'x\nz')], p, 'a.ts')
    for (const row of rows) expect(row).not.toContain('\n')
    expect(rows.length).toBe(4)                                             // context + − + + summary
    expect(visibleWidth(rows[0]!)).toBeGreaterThan(0)
  })
})
