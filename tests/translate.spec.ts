import { describe, expect, it } from 'vitest'
import { translateSessionEvent } from '../src/backend/translate.ts'

describe('translateSessionEvent', () => {
  it('maps user/message to user-message', () => {
    const out = translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    expect(out).toEqual([{ kind: 'user-message', text: 'hi' }])
  })
  it('maps text-delta chunks to stream-delta', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'He' } } })
    expect(out).toEqual([{ kind: 'stream-delta', turn: 1, step: 2, index: 0, block: 'text', text: 'He' }])
  })
  it('maps reasoning-delta chunks with block=reasoning', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 1, text: 'hm' } } })
    expect(out[0]).toMatchObject({ kind: 'stream-delta', block: 'reasoning' })
  })
  it('ignores non-visual chunks (usage, tool-call-delta, finish)', () => {
    for (const chunk of [{ type: 'usage', usage: {} }, { type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '{' }, { type: 'finish' }])
      expect(translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk } })).toEqual([])
  })
  it('maps assistant/message to stream-settle with authoritative content', () => {
    const content = [{ type: 'text', text: 'final' }]
    const out = translateSessionEvent({ type: 'assistant/message', data: { turn: 1, step: 2, message: { content } } })
    expect(out).toEqual([{ kind: 'stream-settle', turn: 1, step: 2, content }])
  })
  it('maps every turn/end reason and names unknown kinds', () => {
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: undefined }])
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: { text: 'Turn cancelled.', tone: 'warning' } }])
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: { text: 'boom', tone: 'error' } }])
    expect(translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'someday-new' } } })).toEqual([{ kind: 'turn-end', turn: 1, notice: { text: 'Turn ended: someday-new.', tone: 'warning' } }])
  })
  it('passes through turn/start and step boundaries', () => {
    expect(translateSessionEvent({ type: 'turn/start', data: { turn: 3 } })).toEqual([{ kind: 'turn-start', turn: 3 }])
    expect(translateSessionEvent({ type: 'step/start', data: { turn: 3, step: 1 } })).toEqual([{ kind: 'step-start', turn: 3, step: 1 }])
    expect(translateSessionEvent({ type: 'step/end', data: { turn: 3, step: 1 }, time: 42 })).toEqual([{ kind: 'step-end', turn: 3, step: 1, time: 42 }])
  })
  it('returns [] for unknown durable event types (skip-safe)', () => {
    expect(translateSessionEvent({ type: 'schedule/change', data: {} })).toEqual([])
  })
  it('textOf: user/message with content undefined yields empty text', () => {
    expect(translateSessionEvent({ type: 'user/message', data: { content: undefined } })).toEqual([{ kind: 'user-message', text: '' }])
  })
  it('textOf: a text block with text undefined yields an empty string for that block', () => {
    expect(translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: undefined }] } })).toEqual([{ kind: 'user-message', text: '' }])
  })
  it('assistant/chunk with an unknown chunk type yields no events', () => {
    expect(translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'audio-delta' } } })).toEqual([])
  })
  it('assistant/message with message undefined settles with empty content', () => {
    expect(translateSessionEvent({ type: 'assistant/message', data: { turn: 1, step: 2, message: undefined } })).toEqual([{ kind: 'stream-settle', turn: 1, step: 2, content: [] }])
  })
  it('stream-delta: chunk index/text undefined fall back to 0 / empty string', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: undefined, text: undefined } } })
    expect(out).toEqual([{ kind: 'stream-delta', turn: 1, step: 1, index: 0, block: 'text', text: '' }])
  })
})

describe('turn-end reason table (spec §3.2 exhaustive-with-named-default)', () => {
  const cases: [string, unknown, { text: string; tone: string } | undefined][] = [
    ['completed', { kind: 'completed' }, undefined],
    ['aborted', { kind: 'aborted', reason: { kind: 'user' } }, { text: 'Turn cancelled.', tone: 'warning' }],
    ['interrupted', { kind: 'interrupted' }, { text: 'Turn cancelled.', tone: 'warning' }],
    ['max-tokens', { kind: 'max-tokens' }, { text: 'Turn stopped: max tokens reached.', tone: 'warning' }],
    ['blocked', { kind: 'blocked' }, { text: 'Turn blocked.', tone: 'warning' }],
    ['error', { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, { text: 'boom', tone: 'error' }],
    ['error-no-message', { kind: 'error', error: {} }, { text: 'Turn failed.', tone: 'error' }],
    ['future-kind', { kind: 'paused-by-plugin' }, { text: 'Turn ended: paused-by-plugin.', tone: 'warning' }],
  ]
  for (const [name, reason, notice] of cases) {
    it(`maps ${name}`, () => {
      const events = translateSessionEvent({ type: 'turn/end', data: { turn: 1, reason } })
      expect(events).toEqual([{ kind: 'turn-end', turn: 1, notice }])
    })
  }
})
