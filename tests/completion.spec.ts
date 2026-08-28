import { describe, expect, it } from 'vitest'
import { createCompletionProvider, type FileCandidate } from '../src/ui/composer/completion.ts'

const provider = () => createCompletionProvider({ commands: () => [
  { name: 'help', description: 'List available commands' },
  { name: 'status', description: 'Show session status' },
  { name: 'resume', description: 'Resume a session', input: { hint: '[filter]' } },
] })
const opts = { signal: new AbortController().signal }

describe('createCompletionProvider — the / branch', () => {
  it('suggests fuzzy-matched commands with the /-inclusive prefix', async () => {
    const s = await provider().getSuggestions(['/st'], 0, 3, opts)
    expect(s).not.toBeNull()
    expect(s!.prefix).toBe('/st')
    expect(s!.items.map((i) => i.value)).toEqual(['status'])
  })
  it('lists everything for a bare slash', async () => {
    const s = await provider().getSuggestions(['/'], 0, 1, opts)
    expect(s!.items.map((i) => i.value)).toEqual(['help', 'status', 'resume'])
  })
  it('folds the argument hint into the description', async () => {
    const s = await provider().getSuggestions(['/re'], 0, 3, opts)
    expect(s!.items[0]!.description).toBe('[filter] — Resume a session')
  })
  it('stays silent off-trigger: no leading slash, after a space, off line 0, or no match', async () => {
    expect(await provider().getSuggestions(['hi'], 0, 2, opts)).toBeNull()
    expect(await provider().getSuggestions(['/help now'], 0, 9, opts)).toBeNull()
    expect(await provider().getSuggestions(['x', '/h'], 1, 2, opts)).toBeNull()
    expect(await provider().getSuggestions(['/zzz'], 0, 4, opts)).toBeNull()
  })
  it('applyCompletion rewrites the line to /name␣ with the cursor after the space', () => {
    const r = provider().applyCompletion(['/st tail'], 0, 3, { value: 'status', label: 'status' }, '/st')
    expect(r.lines).toEqual(['/status tail'])
    expect(r.cursorLine).toBe(0)
    expect(r.cursorCol).toBe('/status '.length)
  })
})

// The block above is T2's pinned test block, carried over byte-exact through
// the T4 rename: the `/` branch did not change when `@` joined it, and this
// file is what proves that. These pin the arms it leaves untaken — each is a
// real contract of the upstream '/'-branch this provider mirrors.
describe('createCompletionProvider — the / arms the pinned block leaves untaken', () => {
  it('reads a missing line as empty text (pi-tui passes its own lines array)', async () => {
    expect(await createCompletionProvider({ commands: () => [{ name: 'help', description: 'x' }] }).getSuggestions([], 0, 0, opts)).toBeNull()
  })
  it('omits the description key entirely when a command has none (upstream drops empty descriptions)', async () => {
    const s = await createCompletionProvider({ commands: () => [{ name: 'help', description: '' }] }).getSuggestions(['/'], 0, 1, opts)
    expect(s!.items).toEqual([{ value: 'help', label: 'help' }])
  })
  it('applyCompletion with nothing after the cursor still lands on /name␣', () => {
    const r = createCompletionProvider({ commands: () => [] }).applyCompletion([], 0, 0, { value: 'help', label: 'help' }, '/')
    expect(r).toEqual({ lines: ['/help '], cursorLine: 0, cursorCol: '/help '.length })
  })
})

describe('createCompletionProvider — the @ branch (spec §8 T4)', () => {
  const workspace: FileCandidate[] = [
    { path: 'src/app/controller.ts', kind: 'file' },
    { path: 'src/ui', kind: 'directory' },
    { path: 'notes/my plan.md', kind: 'file' },
  ]
  const files = (candidates: readonly FileCandidate[] = workspace) => {
    const queries: string[] = []
    const provider = createCompletionProvider({
      commands: () => [{ name: 'help', description: 'x' }],
      files: () => async (query) => { queries.push(query); return candidates },
    })
    return { provider, queries }
  }

  it('asks the service for the path after @, and offers what it answers', async () => {
    const { provider, queries } = files()
    const s = await provider.getSuggestions(['look at @src/'], 0, 13, opts)
    expect(queries).toEqual(['src/'])
    expect(s!.prefix).toBe('@src/')
    expect(s!.items.map((i) => i.value)).toEqual(['@src/app/controller.ts', '@src/ui/', '@"notes/my plan.md"'])
    expect(s!.items.map((i) => i.description)).toEqual(['file', 'directory', 'file'])
  })

  it('does NOT trigger on an @ inside another token, such as an email address', async () => {
    const { provider, queries } = files()
    expect(await provider.getSuggestions(['mail me at devbox@example.com'], 0, 29, opts)).toBeNull()
    expect(queries).toEqual([])
  })

  it('keeps a user-opened quote open, so a path with spaces completes', async () => {
    const { provider, queries } = files([{ path: 'notes/my plan.md', kind: 'file' }])
    const s = await provider.getSuggestions(['see @"notes/my '], 0, 15, opts)
    expect(queries).toEqual(['notes/my '])
    expect(s!.prefix).toBe('@"notes/my ')
    expect(s!.items[0]!.value).toBe('@"notes/my plan.md"')
  })

  it('DROPS a path the grammar cannot represent safely, rather than escaping it into a lie', async () => {
    const { provider } = files([{ path: 'weird\x1b.ts', kind: 'file' }, { path: 'say "hi".ts', kind: 'file' }, { path: 'ok.ts', kind: 'file' }])
    const s = await provider.getSuggestions(['@'], 0, 1, opts)
    expect(s!.items.map((i) => i.value)).toEqual(['@ok.ts'])
  })

  it('escapes the DISPLAYED path even where the value is representable (D7.8)', async () => {
    const { provider } = files([{ path: 'a\u202eb.ts', kind: 'file' }])
    const s = await provider.getSuggestions(['@'], 0, 1, opts)
    expect(s!.items[0]!.label).toBe('a\\u202eb.ts')
  })

  it('finishes a file mention with a space and leaves a directory open to descend', () => {
    const { provider } = files()
    const file = provider.applyCompletion(['see @src/ap tail'], 0, 11, { value: '@src/app/controller.ts', label: 'x' }, '@src/ap')
    expect(file.lines).toEqual(['see @src/app/controller.ts  tail'])
    expect(file.cursorCol).toBe('see @src/app/controller.ts '.length)

    const dir = provider.applyCompletion(['see @sr'], 0, 7, { value: '@src/ui/', label: 'x' }, '@sr')
    expect(dir.lines).toEqual(['see @src/ui/'])
    expect(dir.cursorCol).toBe('see @src/ui/'.length)      // tight against the slash: the next key descends
  })

  it('is inert without a file-reference service, or when the service fails, and never blocks /', async () => {
    const none = createCompletionProvider({ commands: () => [{ name: 'help', description: 'x' }] })
    expect(await none.getSuggestions(['@src'], 0, 4, opts)).toBeNull()
    expect((await none.getSuggestions(['/h'], 0, 2, opts))!.items.map((i) => i.value)).toEqual(['help'])

    const failing = createCompletionProvider({ commands: () => [], files: () => async () => { throw new Error('index is gone') } })
    expect(await failing.getSuggestions(['@src'], 0, 4, opts)).toBeNull()

    const empty = createCompletionProvider({ commands: () => [], files: () => async () => [] })
    expect(await empty.getSuggestions(['@src'], 0, 4, opts)).toBeNull()
  })

  it('applies a file mention even where the token cannot be re-read (a defensive insert)', () => {
    const { provider } = files()
    const r = provider.applyCompletion(['x'], 0, 1, { value: '@a.ts', label: 'x' }, '@')
    expect(r.lines).toEqual(['x@a.ts '])
  })
})
