import { describe, expect, it } from 'vitest'
import { FOCUS_REPORTING_OFF, FOCUS_REPORTING_ON, Notifier, focusReport } from '../src/ui/notify.ts'

const spy = () => { const written: string[] = []; return { written, write: (d: string) => written.push(d) } }

describe('focusReport (DEC 1004)', () => {
  it('recognizes focus in and out, and nothing else', () => {
    expect(focusReport('\x1b[I')).toBe('in')
    expect(focusReport('\x1b[O')).toBe('out')
    for (const other of ['\x1b[A', 'I', 'O', '', '\x1b[2J']) expect(focusReport(other)).toBeUndefined()
  })
})

describe('Notifier (spec §8 T4 — notify only while unfocused)', () => {
  it('asks the terminal to report focus, and stops asking on teardown', () => {
    const terminal = spy()
    const notifier = new Notifier(terminal)
    notifier.start()
    notifier.stop()
    expect(terminal.written).toEqual([FOCUS_REPORTING_ON, FOCUS_REPORTING_OFF])
  })

  it('notifies while unfocused and goes quiet the moment focus arrives', () => {
    const terminal = spy()
    const notifier = new Notifier(terminal)
    // A terminal that ignores DEC 1004 sends nothing, and the safe failure is
    // to notify: a redundant notification beats a missed one.
    notifier.notify('turn finished')
    expect(terminal.written).toEqual(['\x1b]9;turn finished\x07'])

    expect(notifier.observe('\x1b[I')).toBe(true)      // focused: consumed, and quiet
    notifier.notify('turn finished')
    expect(terminal.written).toHaveLength(1)

    expect(notifier.observe('\x1b[O')).toBe(true)      // unfocused again
    notifier.notify('turn finished')
    expect(terminal.written).toHaveLength(2)
  })

  it('passes ordinary input through untouched', () => {
    const notifier = new Notifier(spy())
    expect(notifier.observe('hello')).toBe(false)
  })

  it('obeys the persisted preference', () => {
    const terminal = spy()
    const notifier = new Notifier(terminal)
    notifier.setEnabled(false)
    notifier.notify('turn finished')
    expect(terminal.written).toEqual([])
    notifier.setEnabled(true)
    notifier.notify('turn finished')
    expect(terminal.written).toHaveLength(1)
  })

  it('sanitizes, flattens and bounds the message — it names a session the model titled', () => {
    const terminal = spy()
    const notifier = new Notifier(terminal)
    notifier.notify('done\x1b]0;evil\x07 ‮spoof\n\nnext')
    expect(terminal.written[0]).toBe('\x1b]9;done\\x1b]0;evil\\x07 \\u202espoof next\x07')
    notifier.notify('x'.repeat(500))
    expect(terminal.written[1]!.length).toBeLessThan(140)
    notifier.notify('   ')                              // nothing to say: say nothing
    expect(terminal.written).toHaveLength(2)
  })
})
