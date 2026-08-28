/** The composer's ONE autocomplete provider (spec §3.5, §8 T4).
 *
 * pi-tui accepts a single provider and the archaeology's "at most one popup"
 * convention says the same thing, so the three sources are dispatched here by
 * what the cursor is actually sitting in rather than fighting for the popup:
 *
 *   `/name` at the very start of line 0  → commands
 *   `@path` / `@"path with spaces`       → workspace files
 *
 * What gets inserted is PROMPT TEXT and nothing else. A file mention is a
 * path; the file's contents stay behind the model-facing `read` tool. That is
 * `dsh-file-reference`'s own contract and talon does not widen it.
 *
 * The `@` half is DELEGATED, not reimplemented: the bounded traversal, the
 * cancellation, the tool-result invalidation and the quote grammar all live in
 * `ctx.fileReferences`, so a fix there reaches talon and the web client alike.
 * An absent service simply makes `@` inert — `/` is unaffected. */
import { fuzzyFilter } from '@earendil-works/pi-tui'
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui'
import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import { displayText } from '../../theme/palette.js'

export interface CommandChoice { name: string; description: string; input?: { hint: string } }
/** One path-only candidate (`FileReferenceCandidate`). */
export interface FileCandidate { path: string; kind: 'file' | 'directory' }

/** The slice of `ctx.fileReferences` the composer reads. Absent = no `@`. */
export type FileReferenceLookup = (query: string, signal: AbortSignal) => Promise<readonly FileCandidate[]>

export interface CompletionSources {
  commands: () => readonly CommandChoice[]
  /** Returns `undefined` when no file-reference service is composed. */
  files?: () => FileReferenceLookup | undefined
}

/** Marks a file item so `applyCompletion` knows which grammar to insert with;
 * a command value can never collide, since a command name has no `@`. */
const FILE_PREFIX = '@'

export function createCompletionProvider(sources: CompletionSources): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? ''
      const command = commandToken(lines, cursorLine, cursorCol)
      if (command !== undefined) return commandSuggestions(sources.commands(), command)
      const token = activeAtToken(line, cursorCol)
      if (token === undefined) return null
      const lookup = sources.files?.()
      if (lookup === undefined) return null
      // pi-tui re-queries on every keystroke; the service owns the shared
      // index, so this signal cancels only THIS caller's wait.
      const candidates = await lookup(token.query, new AbortController().signal).catch(() => [])
      const items: AutocompleteItem[] = candidates.flatMap((candidate) => {
        // A path the grammar cannot represent safely (a control character, a
        // quote) is DROPPED rather than escaped: the value is inserted into the
        // user's own prompt, where an escape would be a lie about the path.
        const value = formatFileMention(candidate, token.quoted)
        return value === undefined ? [] : [{ value, label: displayText(candidate.path), description: candidate.kind }]
      })
      return items.length === 0 ? null : { items, prefix: token.prefix }
    },

    applyCompletion(lines, cursorLine, cursorCol, item) {
      const line = lines[cursorLine] ?? ''
      const next = [...lines]
      if (!item.value.startsWith(FILE_PREFIX)) {
        const after = line.slice(cursorCol)
        next[cursorLine] = `/${item.value} ${after.startsWith(' ') ? after.slice(1) : after}`
        return { lines: next, cursorLine, cursorCol: item.value.length + 2 }
      }
      // Replace the token the cursor is in, keeping whatever follows it. A
      // DIRECTORY leaves the cursor tight against its trailing slash so the
      // next keystroke descends; a file gets a trailing space.
      const token = activeAtToken(line, cursorCol)
      const start = token === undefined ? cursorCol : cursorCol - token.prefix.length
      // `formatFileMention` ends a DIRECTORY with its slash (`@dir/`, or the
      // still-open `@"dir/`), which is what keeps completion descending — so
      // that one gets no trailing space, and a finished file mention does.
      const inserted = item.value.endsWith('/') ? item.value : `${item.value} `
      next[cursorLine] = line.slice(0, start) + inserted + line.slice(cursorCol)
      return { lines: next, cursorLine, cursorCol: start + inserted.length }
    },
  }
}

/** The `/name` token, or `undefined` when the cursor is not in one. Commands
 * live only at the very start of the first line — anywhere else a `/` is a
 * path separator, not a command. */
function commandToken(lines: readonly string[], cursorLine: number, cursorCol: number): string | undefined {
  if (cursorLine !== 0) return undefined
  const before = (lines[0] ?? '').slice(0, cursorCol)
  if (!before.startsWith('/') || before.includes(' ')) return undefined
  return before
}

function commandSuggestions(choices: readonly CommandChoice[], before: string): AutocompleteSuggestions | null {
  const items: AutocompleteItem[] = fuzzyFilter([...choices], before.slice(1), (c) => c.name).map((c) => ({
    value: c.name,
    label: c.name,
    ...((): { description?: string } => {
      const description = c.input?.hint !== undefined ? `${c.input.hint} — ${c.description}` : c.description
      return description === '' ? {} : { description }
    })(),
  }))
  return items.length === 0 ? null : { items, prefix: before }
}
