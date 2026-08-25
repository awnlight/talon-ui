import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { classifyTool, commandArg, foldPreview, TOOL_CARD_CLASSES, ToolCardCell, type ToolResult } from '../src/ui/transcript/tool-cards.ts'

const p = createPalette(false)
const colored = createPalette(true)
const ok = (resultText: string): ToolResult => ({ isError: false, errorCode: undefined, resultText, meta: undefined })
const failed = (resultText: string): ToolResult => ({ isError: true, errorCode: 'timeout', resultText, meta: undefined })
const card = (name: string, args: unknown, palette = p): ToolCardCell =>
  new ToolCardCell({ callId: 'c1', name, args, rawArguments: JSON.stringify(args ?? null) }, palette)

describe('classifyTool (T3 ruling 1 registry)', () => {
  it('maps every registered name to its class', () => {
    const expected: Record<string, string> = {
      bash: 'terminal', pwsh: 'terminal',
      edit: 'diff', write: 'diff', str_replace_editor: 'diff',
      read: 'read', read_image: 'read',
      grep: 'search', glob: 'search',
      web_search: 'web', web_fetch: 'web',
      todo_write: 'generic', skill: 'generic', subagent: 'generic', subagent_fork: 'generic',
      report: 'generic', workflow: 'generic', ralph: 'generic', job_output: 'generic',
      job_list: 'generic', job_kill: 'generic', get_goal: 'generic', create_goal: 'generic',
      update_goal: 'generic', list_agents: 'generic', send_message: 'generic',
      interrupt_agent: 'generic', exit_plan_mode: 'generic', ask_user_question: 'generic',
    }
    expect(TOOL_CARD_CLASSES).toEqual(expected)                       // the table itself is the contract
    for (const [name, cls] of Object.entries(expected)) expect(classifyTool(name)).toBe(cls)
  })
  it('sends an unknown name to the unregistered fallback (D13)', () => {
    expect(classifyTool('mcp__notion__search')).toBe('unregistered')
    expect(classifyTool('')).toBe('unregistered')
  })
})

describe('commandArg (the approval prompt preview, spec D9)', () => {
  it('reads the bash command argument, and nothing else', () => {
    expect(commandArg({ command: 'pnpm test', description: 'checks' })).toBe('pnpm test')
    expect(commandArg({ path: '/x' })).toBeUndefined()
    expect(commandArg({ command: 12 })).toBeUndefined()
    expect(commandArg(undefined)).toBeUndefined()
    expect(commandArg('raw string')).toBeUndefined()
  })
})

describe('foldPreview (the single collapsed fold rule)', () => {
  it('leaves six or fewer lines untouched', () => {
    const body = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(foldPreview(body, p)).toEqual(body)
    expect(foldPreview([], p)).toEqual([])
  })
  it('splits head/tail around one dim middle marker beyond six lines', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`)
    expect(foldPreview(body, p)).toEqual(['line 0', 'line 1', 'line 2', '… 4 more lines …', 'line 7', 'line 8', 'line 9'])
    expect(foldPreview(body, colored)[3]).toBe(colored.dim('… 4 more lines …'))
  })
})

describe('ToolCardCell lifecycle (pending → settle, spec §4.2 / ruling 4)', () => {
  it('renders the pending head and a dim running body in the warning tone', () => {
    const cell = card('bash', { command: 'pnpm test' }, colored)
    expect(cell.render(80)).toEqual([colored.warning('◇ bash · pnpm test'), colored.dim('└ running…')])
    expect(cell.contentLineCount()).toBe(2)
    expect(cell.isSettled()).toBe(false)
  })
  it('renders a head with no key argument when no string argument is present', () => {
    expect(card('todo_write', { todos: [] }).render(80)[0]).toBe('◇ todo_write')
    expect(card('list_agents', undefined).render(80)[0]).toBe('◇ list_agents')
  })
  it('settles in place: same cell, ◆ head, success tone, dim body from the class builder', () => {
    const cell = card('bash', { command: 'pnpm test' }, colored)
    cell.settle(ok('12 passed\n0 failed'))
    expect(cell.isSettled()).toBe(true)
    expect(cell.render(80)).toEqual([colored.success('◆ bash · pnpm test'), colored.dim('12 passed'), colored.dim('0 failed')])
    expect(cell.contentLineCount()).toBe(3)
  })
  it('settles a failure into the error tone', () => {
    const cell = card('bash', { command: 'sleep 99' }, colored)
    cell.settle(failed('timed out'))
    expect(cell.render(80)[0]).toBe(colored.error('◆ bash · sleep 99'))
  })
  it('an empty result settles to a head-only card', () => {
    const cell = card('todo_write', { todos: [] })
    cell.settle(ok(''))
    expect(cell.render(80)).toEqual(['◆ todo_write'])
    expect(cell.contentLineCount()).toBe(1)
  })
  it('is uncached while pending and width-cached once settled (§5.1, the streaming precedent)', () => {
    const cell = card('bash', { command: 'ls' })
    expect(cell.render(80)).not.toBe(cell.render(80))     // live tail: recomputed every frame
    cell.settle(ok('a\nb'))
    const rows = cell.render(80)
    expect(cell.render(80)).toBe(rows)                    // reference identity — the perf law
    const narrow = cell.render(60)                        // width change recomputes
    expect(narrow).not.toBe(rows)
    cell.invalidate()
    expect(cell.render(60)).not.toBe(narrow)              // invalidate drops the cache
  })
  it('folds a long body in the collapsed default and lets a failure ignore the fold', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const good = card('bash', { command: 'ls' })
    good.settle(ok(body))
    expect(good.render(80)).toEqual(['◆ bash · ls', 'line 0', 'line 1', 'line 2', '… 4 more lines …', 'line 7', 'line 8', 'line 9'])
    expect(good.contentLineCount()).toBe(8)

    const bad = card('bash', { command: 'ls' })
    bad.settle(failed(body))
    expect(bad.render(80).length).toBe(11)                // head + all ten lines: a failure always shows everything
    expect(bad.contentLineCount()).toBe(11)
  })
})

describe('ToolCardCell display law (width-crash + D7.8)', () => {
  it('keeps the head on ONE row even when the key argument spans lines, and neutralizes controls', () => {
    const cell = card('ba\x1bsh', { command: 'echo one\necho \x07two' })
    expect(cell.render(80)).toEqual(['◇ ba\\x1bsh · echo one', '└ running…'])
  })
  it('truncates the head and wraps the body so no row exceeds the width', () => {
    const cell = card('bash', { command: 'run '.repeat(40).trim() })
    cell.settle(ok('output '.repeat(40).trim()))
    const rows = cell.render(24)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(24)
    expect(rows[0]).toContain('…')                        // head truncated, never wrapped
  })
  it('neutralizes control characters in the result body', () => {
    const cell = card('bash', { command: 'ls' })
    cell.settle(ok('done\x1b]0;evil\x07'))
    expect(cell.render(80).join('\n')).toContain('done\\x1b]0;evil\\x07')
  })
  it('contentLineCount stays width-invariant', () => {
    const cell = card('bash', { command: 'ls' })
    cell.settle(ok('a very long line that certainly wraps at twenty columns\nb'))
    expect(cell.contentLineCount()).toBe(3)
    cell.render(20)
    expect(cell.contentLineCount()).toBe(3)
  })
  it('renders at width 1 without throwing', () => {
    const cell = card('bash', { command: 'ls' })
    cell.settle(ok('out'))
    expect(() => cell.render(1)).not.toThrow()
  })
})
