/** Slash-command completion: mirrors pi-tui CombinedAutocompleteProvider's
 * '/'-branch exactly (fuzzy over names, prefix includes '/', accept inserts
 * '/name '), but reads the live command list through a closure — so
 * commands/change needs no provider rebuild (Ruling 4). File/@ completion is
 * deliberately absent until T4. */
import { fuzzyFilter } from '@earendil-works/pi-tui'
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'

export function createSlashProvider(
  list: () => readonly { name: string; description: string; input?: { hint: string } }[],
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol): Promise<AutocompleteSuggestions | null> {
      if (cursorLine !== 0) return null
      const before = (lines[0] ?? '').slice(0, cursorCol)
      if (!before.startsWith('/') || before.includes(' ')) return null
      const prefix = before.slice(1)
      const items: AutocompleteItem[] = fuzzyFilter([...list()], prefix, (c) => c.name).map((c) => ({
        value: c.name,
        label: c.name,
        ...((): { description?: string } => {
          const description = c.input?.hint !== undefined ? `${c.input.hint} — ${c.description}` : c.description
          return description === '' ? {} : { description }
        })(),
      }))
      return items.length === 0 ? null : { items, prefix: before }
    },
    applyCompletion(lines, cursorLine, cursorCol, item) {
      const line = lines[cursorLine] ?? ''
      const after = line.slice(cursorCol)
      const next = [...lines]
      next[cursorLine] = `/${item.value} ${after.startsWith(' ') ? after.slice(1) : after}`
      return { lines: next, cursorLine, cursorCol: item.value.length + 2 }
    },
  }
}
