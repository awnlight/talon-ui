/** Closed-manifest law (spec §7.1): the declared checkpoint universe and the
 * .expected.txt files on disk are the same set — no orphan snapshots, no
 * undeclared checkpoints. */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHECKPOINTS } from './helpers/checkpoint.ts'

describe('snapshot manifest', () => {
  it('declared checkpoints and .expected.txt files are the same set', () => {
    const dir = fileURLToPath(new URL('./snapshots', import.meta.url))
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.expected.txt')).map((f) => f.replace(/\.expected\.txt$/, '')).sort()
    expect(onDisk).toEqual([...CHECKPOINTS].sort())
  })
})
