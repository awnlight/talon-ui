import { join } from 'node:path'
import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette } from '../src/theme/palette.ts'
import { classifyTool, commandArg, foldPreview, TOOL_CARD_CLASSES, ToolCardCell, type ToolResult } from '../src/ui/transcript/tool-cards.ts'

const p = createPalette(false)
const colored = createPalette(true)
const ok = (resultText: string): ToolResult => ({ isError: false, errorCode: undefined, resultText, meta: undefined })
const failed = (resultText: string): ToolResult => ({ isError: true, errorCode: 'timeout', resultText, meta: undefined })
const card = (name: string, args: unknown, palette = p): ToolCardCell =>
  new ToolCardCell({ callId: 'c1', name, args, rawArguments: JSON.stringify(args ?? null) }, palette)
/** The shared-machinery tests ride a `generic`-class tool on purpose: they pin
 * the ONE class that owns the head, tone, fold and cache laws (ruling 4), so a
 * per-class builder landing later can never quietly move them. */
const generic = (args: unknown, palette = p): ToolCardCell => card('skill', args, palette)

afterEach(() => vi.restoreAllMocks())

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
    const cell = generic({ name: 'writing-plans' }, colored)
    cell.settle(ok('12 passed\n0 failed'))
    expect(cell.isSettled()).toBe(true)
    expect(cell.render(80)).toEqual([colored.success('◆ skill · writing-plans'), colored.dim('12 passed'), colored.dim('0 failed')])
    expect(cell.contentLineCount()).toBe(3)
  })
  it('settles a failure into the error tone', () => {
    const cell = generic({ name: 'writing-plans' }, colored)
    cell.settle(failed('timed out'))
    expect(cell.render(80)[0]).toBe(colored.error('◆ skill · writing-plans'))
  })
  it('an empty result settles to a head-only card', () => {
    const cell = card('todo_write', { todos: [] })
    cell.settle(ok(''))
    expect(cell.render(80)).toEqual(['◆ todo_write'])
    expect(cell.contentLineCount()).toBe(1)
  })
  it('is uncached while pending and width-cached once settled (§5.1, the streaming precedent)', () => {
    const cell = generic({ name: 'writing-plans' })
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
    const good = generic({ name: 'plans' })
    good.settle(ok(body))
    expect(good.render(80)).toEqual(['◆ skill · plans', 'line 0', 'line 1', 'line 2', '… 4 more lines …', 'line 7', 'line 8', 'line 9'])
    expect(good.contentLineCount()).toBe(8)

    const bad = generic({ name: 'plans' })
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
    const cell = generic({ name: 'run '.repeat(40).trim() })
    cell.settle(ok('output '.repeat(40).trim()))
    const rows = cell.render(24)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(24)
    expect(rows[0]).toContain('…')                        // head truncated, never wrapped
  })
  it('neutralizes control characters in the result body', () => {
    const cell = generic({ name: 'plans' })
    cell.settle(ok('done\x1b]0;evil\x07'))
    expect(cell.render(80).join('\n')).toContain('done\\x1b]0;evil\\x07')
  })
  it('contentLineCount stays width-invariant', () => {
    const cell = generic({ name: 'plans' })
    cell.settle(ok('a very long line that certainly wraps at twenty columns\nb'))
    expect(cell.contentLineCount()).toBe(3)
    cell.render(20)
    expect(cell.contentLineCount()).toBe(3)
  })
  it('renders at width 1 without throwing', () => {
    const cell = generic({ name: 'plans' })
    cell.settle(ok('out'))
    expect(() => cell.render(1)).not.toThrow()
  })
})

/** The durable terminal facts are the call `arguments` plus the RENDERED
 * result text — `tool-bash` publishes no `presentationMeta`, and dsh's own
 * `parseExitStatus` doc says replay keeps only that text, so the exit status is
 * recovered from the marker contract (shell/shell/src/render.ts). Every fixture
 * below is shaped exactly as `renderResult` emits it. */
describe('terminal card (bash/pwsh, spec §4.2 / D12)', () => {
  const HERE = '/workspace/talon-ui'
  const bash = (args: unknown, palette = p): ToolCardCell => card('bash', args, palette)
  const inHere = <T>(run: () => T): T => { vi.spyOn(process, 'cwd').mockReturnValue(HERE); return run() }

  it('carries the bash description on the head line, beside the command (spec §4.2)', () => {
    const cell = bash({ command: 'pnpm test', description: 'Run the test suite' }, colored)
    expect(cell.render(80)[0]).toBe(colored.warning('◇ bash · pnpm test · Run the test suite'))
  })

  it('renders a clean foreground run: cwd lead, $ command, dim output, no badge', () => {
    const cell = inHere(() => {
      const c = bash({ command: 'pnpm test', description: 'Run the test suite' }, colored)
      c.settle(ok('12 passed\n0 failed\n'))
      return c
    })
    expect(cell.render(80)).toEqual([
      colored.success('◆ bash · pnpm test · Run the test suite'),
      colored.dim(HERE),
      colored.dim('$ pnpm test'),
      colored.dim('12 passed'),
      colored.dim('0 failed'),
    ])
  })

  it('flips the head to the error tone on a non-zero exit and badges it, though the result is not an error', () => {
    const cell = inHere(() => {
      const c = bash({ command: 'pnpm test' }, colored)
      c.settle(ok('1 failed\n[exit code: 1]'))
      return c
    })
    expect(cell.render(80)).toEqual([
      colored.error('◆ bash · pnpm test'),
      colored.dim(HERE),
      colored.dim('$ pnpm test'),
      colored.dim('1 failed'),
      colored.dim('[exit 1]'),
    ])
  })

  it('badges a signal kill and never renders the consumed marker twice', () => {
    const cell = inHere(() => { const c = bash({ command: 'sleep 99' }); c.settle(ok('\n[killed by signal: SIGTERM]')); return c })
    const rows = cell.render(80)
    expect(rows[0]).toBe('◆ bash · sleep 99')
    expect(rows.at(-1)).toBe('[signal SIGTERM]')
    expect(rows.join('\n')).not.toContain('killed by signal')
  })

  it('a failing run ignores the fold, exactly like a flagged failure', () => {
    const long = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')
    const cell = inHere(() => { const c = bash({ command: 'ls' }); c.settle(ok(`${long}\n[exit code: 2]`)); return c })
    expect(cell.render(80).length).toBe(1 + 2 + 10 + 1)   // head + lead + every line + badge
    const clean = inHere(() => { const c = bash({ command: 'ls' }); c.settle(ok(long)); return c })
    expect(clean.render(80)).toContain('… 6 more lines …') // the clean twin still folds
  })

  it('only an ANCHORED trailing marker is a badge — marker-like output stays in the body', () => {
    const cell = inHere(() => { const c = bash({ command: 'cat log' }); c.settle(ok('[exit code: 7]\nstill running')); return c })
    const rows = cell.render(80)
    expect(rows[0]).toBe('◆ bash · cat log')               // clean: no badge was consumed
    expect(rows).toContain('[exit code: 7]')
  })

  it('passes the truncation and sandbox notes through — the renderer already put them in the body', () => {
    const cell = inHere(() => {
      const c = bash({ command: 'find /' })
      c.settle(ok('a\n[output truncated; full output: /tmp/spill.txt]\n[sandbox: file access denied under read-only mode]\n[exit code: 1]'))
      return c
    })
    const rows = cell.render(120)
    expect(rows).toContain('[output truncated; full output: /tmp/spill.txt]')
    expect(rows).toContain('[sandbox: file access denied under read-only mode]')
    expect(rows.at(-1)).toBe('[exit 1]')
  })

  it('renders a background start as its own tail line', () => {
    const cell = inHere(() => { const c = bash({ command: 'pnpm dev', run_in_background: true }); c.settle(ok('started background job job-7')); return c })
    expect(cell.render(80)).toEqual(['◆ bash · pnpm dev', HERE, '$ pnpm dev', '└ background job job-7'])
  })

  it('leaves a flagged failure unparsed: the harness text is the body', () => {
    const cell = inHere(() => { const c = bash({ command: 'sleep 99' }, colored); c.settle(failed('AbortError: tool call aborted')); return c })
    expect(cell.render(80)).toEqual([
      colored.error('◆ bash · sleep 99'),
      colored.dim(HERE),
      colored.dim('$ sleep 99'),
      colored.dim('AbortError: tool call aborted'),
    ])
  })

  it('an empty result leaves just the lead', () => {
    const cell = inHere(() => { const c = bash({ command: 'true' }); c.settle(ok('')); return c })
    expect(cell.render(80)).toEqual(['◆ bash · true', HERE, '$ true'])
  })

  it('prefers the workdir argument over the process cwd, and abbreviates home', () => {
    const cell = inHere(() => { const c = bash({ command: 'ls', workdir: join(homedir(), 'proj', 'app') }); c.settle(ok('a')); return c })
    expect(cell.render(80)[1]).toBe('~/proj/app')
    const atHome = inHere(() => { const c = bash({ command: 'ls', workdir: homedir() }); c.settle(ok('a')); return c })
    expect(atHome.render(80)[1]).toBe('~')
    const elsewhere = inHere(() => { const c = bash({ command: 'ls', workdir: '/etc' }); c.settle(ok('a')); return c })
    expect(elsewhere.render(80)[1]).toBe('/etc')
  })

  it('neutralizes hostile controls in the command, the cwd and the badge (D7.8)', () => {
    const cell = inHere(() => {
      const c = bash({ command: 'echo \x1b]0;evil\x07', workdir: '/tmp/\x1b[2Jx' })
      c.settle(ok('out\n[killed by signal: \x1b[31mSIG]'))
      return c
    })
    const joined = cell.render(120).join('\n')
    expect(joined).toContain('$ echo \\x1b]0;evil\\x07')
    expect(joined).toContain('/tmp/\\x1b[2Jx')
    expect(joined).toContain('[signal \\x1b[31mSIG]')
  })

  it('pwsh takes the same card', () => {
    const cell = inHere(() => { const c = card('pwsh', { command: 'Get-Date' }); c.settle(ok('Monday\n[exit code: 3]')); return c })
    expect(cell.render(80)).toEqual(['◆ pwsh · Get-Date', HERE, '$ Get-Date', 'Monday', '[exit 3]'])
  })

  it('survives malformed arguments (unparsed model JSON) without a head or a command', () => {
    const cell = inHere(() => { const c = bash(undefined); c.settle(ok('out')); return c })
    expect(cell.render(80)).toEqual(['◆ bash', HERE, '$ ', 'out'])
  })
})

/** `edit` and `write` persist their applied hunks as `tool/result.meta`; a
 * create records none and `str_replace_editor` publishes no meta at all, so
 * those reconstruct the change from the call arguments — the same fallback
 * dsh's own write presenter takes. */
describe('diff card (edit/write/str_replace_editor, spec §4.2 / D12)', () => {
  const meta = (diffs: unknown): ToolResult => ({ isError: false, errorCode: undefined, resultText: 'ok', meta: { diffs } })

  it('heads on the file path — not the first string argument the model happened to send', () => {
    expect(card('edit', { old_string: 'a', file_path: 'src/a.ts', new_string: 'b' }).render(80)[0]).toBe('◇ edit · src/a.ts')
    expect(card('str_replace_editor', { command: 'str_replace', path: 'src/a.ts' }).render(80)[0]).toBe('◇ str_replace_editor · src/a.ts')
  })

  it('renders the applied hunks from meta, with the path header suppressed by the head', () => {
    const cell = card('edit', { file_path: 'src/a.ts' })
    cell.settle(meta([{ path: 'src/a.ts', oldText: 'let x = 1', newText: 'const x = 1' }]))
    expect(cell.render(80)).toEqual(['◆ edit · src/a.ts', '  1 − let x = 1', '  1 + const x = 1', '└ +1 −1 · 1 file'])
  })

  it('falls back to the arguments when a create recorded no hunks (write)', () => {
    const cell = card('write', { file_path: 'new.ts', content: 'a\nb' })
    cell.settle({ isError: false, errorCode: undefined, resultText: 'wrote new.ts', meta: { diffs: [] } })
    expect(cell.render(80)).toEqual(['◆ write · new.ts', '  1 + a', '  2 + b', '└ +2 −0 · 1 file'])
  })

  it('falls back to the arguments for edit and both diff-shaped str_replace_editor commands', () => {
    const edit = card('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })
    edit.settle(ok('edited'))
    expect(edit.render(80)).toEqual(['◆ edit · a.ts', '  1 − x', '  1 + y', '└ +1 −1 · 1 file'])

    const create = card('str_replace_editor', { command: 'create', path: 'a.ts', file_text: 'hello' })
    create.settle(ok('created'))
    expect(create.render(80)).toEqual(['◆ str_replace_editor · a.ts', '  1 + hello', '└ +1 −0 · 1 file'])

    const replace = card('str_replace_editor', { command: 'str_replace', path: 'a.ts', old_str: 'x', new_str: 'y' })
    replace.settle(ok('replaced'))
    expect(replace.render(80)).toEqual(['◆ str_replace_editor · a.ts', '  1 − x', '  1 + y', '└ +1 −1 · 1 file'])
  })

  it('reads an absent old side as a pure insertion, whichever tool sent it', () => {
    const edit = card('edit', { file_path: 'a.ts', new_string: 'y' })   // an edit that only adds
    edit.settle(ok('edited'))
    expect(edit.render(80)).toEqual(['◆ edit · a.ts', '  1 + y', '└ +1 −0 · 1 file'])

    const replace = card('str_replace_editor', { command: 'str_replace', path: 'a.ts', new_str: 'y' })
    replace.settle(ok('replaced'))
    expect(replace.render(80)).toEqual(['◆ str_replace_editor · a.ts', '  1 + y', '└ +1 −0 · 1 file'])
  })

  it('treats a non-string content argument as no content at all', () => {
    const cell = card('write', { file_path: 'a.ts', content: 12 })
    cell.settle(ok('wrote'))
    expect(cell.render(80)).toEqual(['◆ write · a.ts', '└ +0 −0 · 1 file'])
  })

  it('renders str_replace_editor view/insert as plain result text — they are not diffs', () => {
    const view = card('str_replace_editor', { command: 'view', path: 'a.ts' })
    view.settle(ok('1\tconst x = 1'))
    expect(view.render(80)).toEqual(['◆ str_replace_editor · a.ts', '1\\x09const x = 1'])
  })

  it('shows the failure, not a diff of a change that never landed', () => {
    const cell = card('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, colored)
    cell.settle(failed('old_string did not appear verbatim'))
    expect(cell.render(80)).toEqual([colored.error('◆ edit · a.ts'), colored.dim('old_string did not appear verbatim')])
  })

  it('falls back to plain text when the arguments cannot describe a change either', () => {
    const cell = card('edit', undefined)
    cell.settle(ok('done'))
    expect(cell.render(80)).toEqual(['◆ edit', 'done'])
  })

  it('folds a long diff like every other card, and counts its lines width-free', () => {
    const cell = card('write', { file_path: 'big.ts', content: Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n') })
    cell.settle(ok('wrote'))
    expect(cell.contentLineCount()).toBe(1 + 6 + 1)      // head + the fold + the marker row
    expect(cell.render(80)).toContain('… 7 more lines …')
  })
})
