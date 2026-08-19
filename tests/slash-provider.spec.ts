import { describe, expect, it } from 'vitest'
import { createSlashProvider } from '../src/ui/composer/slash-provider.ts'

const provider = () => createSlashProvider(() => [
  { name: 'help', description: 'List available commands' },
  { name: 'status', description: 'Show session status' },
  { name: 'resume', description: 'Resume a session', input: { hint: '[filter]' } },
])
const opts = { signal: new AbortController().signal }

describe('createSlashProvider', () => {
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

// The block above is the plan's pinned test block, kept byte-exact. These pin
// the arms it leaves untaken — each is a real contract of the upstream
// '/'-branch this provider mirrors, and the per-file 100% coverage gate needs
// all of them.
describe('createSlashProvider — the arms the pinned block leaves untaken', () => {
  it('reads a missing line as empty text (pi-tui passes its own lines array)', async () => {
    expect(await createSlashProvider(() => [{ name: 'help', description: 'x' }]).getSuggestions([], 0, 0, opts)).toBeNull()
  })
  it('omits the description key entirely when a command has none (upstream drops empty descriptions)', async () => {
    const s = await createSlashProvider(() => [{ name: 'help', description: '' }]).getSuggestions(['/'], 0, 1, opts)
    expect(s!.items).toEqual([{ value: 'help', label: 'help' }])
  })
  it('applyCompletion with nothing after the cursor still lands on /name␣', () => {
    const r = createSlashProvider(() => []).applyCompletion([], 0, 0, { value: 'help', label: 'help' }, '/')
    expect(r).toEqual({ lines: ['/help '], cursorLine: 0, cursorCol: '/help '.length })
  })
})
