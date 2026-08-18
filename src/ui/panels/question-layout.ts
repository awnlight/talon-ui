// src/ui/panels/question-layout.ts
/** Pure layout helpers for the question panel's two-level pagination (spec
 * §4.4, ported from the recovered QuestionDialog). Both take pre-wrapped PLAIN
 * rows and never style, so slicing can never split an SGR pair — the caller
 * styles (and truncates) whatever comes back. */

/** A window into rows that do not fit: `size` rows from `offset`, which never
 * runs past `maxOffset`. `maxOffset === 0` means "nothing to page here". */
export interface BlockPage { offset: number; size: number; maxOffset: number }
export const IDLE_PAGE: BlockPage = { offset: 0, size: 1, maxOffset: 0 }

/** Window option BLOCKS (each an array of pre-wrapped rows) around the
 * selected index: grow forward first, then backward; reserve marker rows;
 * if the selected block alone exceeds the budget, page WITHIN it. */
export function windowBlocks(blocks: string[][], selectedIndex: number, budget: number, maxVisible: number, page: BlockPage):
  { visible: string[][]; hiddenBefore: number; hiddenAfter: number; page: BlockPage } {
  /** One row per shown `↑/↓ N more` marker, reserved out of the budget. */
  const markers = (start: number, end: number): number => (start > 0 ? 1 : 0) + (end < blocks.length - 1 ? 1 : 0)
  const fits = (start: number, end: number): boolean =>
    end - start + 1 <= maxVisible
    && blocks.slice(start, end + 1).reduce((n, block) => n + block.length, 0) + markers(start, end) <= budget
  let start = selectedIndex
  let end = selectedIndex
  if (fits(start, end)) {
    while (end + 1 < blocks.length && fits(start, end + 1)) end += 1
    while (start > 0 && fits(start - 1, end)) start -= 1
    return { visible: blocks.slice(start, end + 1), hiddenBefore: start, hiddenAfter: blocks.length - 1 - end, page: IDLE_PAGE }
  }
  // Degradation: the selection alone overflows the budget, so page inside it.
  // One row stays reserved for the `… ↑ n lines hidden` head marker, keeping
  // the window height put as the user pages through the block.
  const lines = blocks[selectedIndex]!
  const size = Math.max(1, budget - markers(selectedIndex, selectedIndex) - 1)
  const maxOffset = Math.max(0, lines.length - size)
  const offset = Math.min(Math.max(0, page.offset), maxOffset)
  const view = lines.slice(offset, offset + size)
  return {
    visible: [offset > 0 ? [`… ↑ ${offset} lines hidden`, ...view] : view],
    hiddenBefore: selectedIndex,
    hiddenAfter: blocks.length - 1 - selectedIndex,
    page: { offset, size, maxOffset },
  }
}

/** Compact an over-tall header (question+detail rows) to a page window with
 * a status row: `… lines a-b/total • PgUp/PgDn`. */
export function compactHeader(rows: string[], budget: number, page: BlockPage): { rows: string[]; page: BlockPage } {
  if (rows.length <= budget) return { rows, page: IDLE_PAGE }
  const size = Math.max(1, budget - 1)                       // the status row costs one
  const maxOffset = rows.length - size
  const offset = Math.min(Math.max(0, page.offset), maxOffset)
  const end = Math.min(rows.length, offset + size)
  return {
    rows: [...rows.slice(offset, end), `… lines ${offset + 1}-${end}/${rows.length} • PgUp/PgDn`],
    page: { offset, size, maxOffset },
  }
}
