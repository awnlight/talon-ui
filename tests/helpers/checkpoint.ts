/** Semantic-snapshot checkpoint discipline (spec §7.1): the theme invariant
 * is embedded HERE so no checkpoint can forget it, and the name must be
 * pre-declared so the manifest spec can prove declared = observed = disk. */
import { expect } from 'vitest'
import type { HeadlessTerminal } from '../../src/testing/headless-terminal.ts'

export const CHECKPOINTS = [
  'conversation-roundtrip',
  'approval-panel',
] as const

export type CheckpointName = (typeof CHECKPOINTS)[number]

export const observedCheckpoints: string[] = []

export async function checkpoint(name: CheckpointName, terminal: HeadlessTerminal): Promise<void> {
  expect(CHECKPOINTS, `checkpoint "${name}" must be declared in CHECKPOINTS`).toContain(name)
  observedCheckpoints.push(name)
  expect(terminal.themeViolations(), `theme violations at checkpoint "${name}"`).toEqual([])
  await expect(terminal.snapshot()).toMatchFileSnapshot(`snapshots/${name}.expected.txt`)
}

/** Call from afterAll in every file that snapshots: pins observed === owned. */
export function expectObserved(owned: readonly CheckpointName[]): void {
  expect([...observedCheckpoints].sort()).toEqual([...owned].sort())
}
