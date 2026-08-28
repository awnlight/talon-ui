import { describe, expect, it } from 'vitest'
import { translateSessionEvent } from '../src/backend/translate.ts'

describe('translateSessionEvent', () => {
  it('maps user/message to user-message', () => {
    const out = translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
    expect(out).toEqual([{ kind: 'user-message', text: 'hi' }])
  })
  it('routes non-user sources to context cards (T2 carryover 11)', () => {
    expect(translateSessionEvent({ type: 'user/message', data: {
      content: [{ type: 'text', text: 'entry one\nentry two\nentry three' }],
      source: { kind: 'skill-catalog', form: 'catalog' },
    } })).toEqual([{ kind: 'context-card', label: 'skill-catalog', summary: undefined, text: 'entry one\nentry two\nentry three' }])
    expect(translateSessionEvent({ type: 'user/message', data: {
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'subagent finished' },
    } })).toEqual([{ kind: 'context-card', label: 'subagent-settled', summary: 'subagent finished', text: 'done' }])
  })
  it('keeps real user prompts as user messages — including sourceless fixtures', () => {
    expect(translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }))
      .toEqual([{ kind: 'user-message', text: 'hi' }])
    expect(translateSessionEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }))
      .toEqual([{ kind: 'user-message', text: 'hi' }])
  })
  it('a context message with no text blocks carries no body', () => {
    expect(translateSessionEvent({ type: 'user/message', data: { content: [], source: { kind: 'agent-instructions', form: 'instructions' } } }))
      .toEqual([{ kind: 'context-card', label: 'agent-instructions', summary: undefined, text: '' }])
  })
  it('maps text-delta chunks to stream-delta', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'text-delta', index: 0, text: 'He' } } })
    expect(out).toEqual([{ kind: 'stream-delta', turn: 1, step: 2, index: 0, block: 'text', text: 'He' }])
  })
  it('maps reasoning-delta chunks with block=reasoning', () => {
    const out = translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 1, text: 'hm' } } })
    expect(out[0]).toMatchObject({ kind: 'stream-delta', block: 'reasoning' })
  })
  it('ignores non-visual chunks (tool-call-delta, finish)', () => {
    for (const chunk of [{ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '{' }, { type: 'finish' }])
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
  it('translates tool/call into a card event: parsed args plus the verbatim raw string (real dsh wire shape)', () => {
    expect(translateSessionEvent({ type: 'tool/call', data: { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{"command":"ls -la"}' } }))
      .toEqual([{ kind: 'tool-call-card', turn: 1, step: 2, callId: 'c1', name: 'bash', args: { command: 'ls -la' }, rawArguments: '{"command":"ls -la"}' }])
  })
  it('tool/call with malformed JSON arguments keeps the raw string and leaves args undefined', () => {
    const malformed = { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c4', name: 'bash', arguments: '{"command": <bad' } }
    expect(() => translateSessionEvent(malformed)).not.toThrow()
    expect(translateSessionEvent(malformed))
      .toEqual([{ kind: 'tool-call-card', turn: 1, step: 1, callId: 'c4', name: 'bash', args: undefined, rawArguments: '{"command": <bad' }])
  })
  it('tool/call still accepts object-shaped arguments fixtures, re-encoding the raw string', () => {
    expect(translateSessionEvent({ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c5', name: 'bash', arguments: { command: 'pwd' } } }))
      .toEqual([{ kind: 'tool-call-card', turn: 1, step: 1, callId: 'c5', name: 'bash', args: { command: 'pwd' }, rawArguments: '{"command":"pwd"}' }])
  })
  it('tool/call falls back to empty callId/name/raw arguments when fields are missing', () => {
    expect(translateSessionEvent({ type: 'tool/call', data: {} }))
      .toEqual([{ kind: 'tool-call-card', turn: undefined, step: undefined, callId: '', name: '', args: undefined, rawArguments: '' }])
  })
  it('translates tool/result: text blocks verbatim, correlated by the block callId', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: { turn: 1, step: 1, message: { content: [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }], isError: false },
    ] } } })).toEqual([{ kind: 'tool-result-card', callId: 'c1', isError: false, errorCode: undefined, resultText: 'first\nsecond', meta: undefined }])
  })
  it('tool/result pretty-prints a non-text result block (dsh ui-cordis resultText precedent)', () => {
    const image = { type: 'image', attachment: { id: 'a1' } }
    const out = translateSessionEvent({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'head' }, image] },
    ] } } })
    expect(out).toEqual([{ kind: 'tool-result-card', callId: 'c2', isError: false, errorCode: undefined, resultText: `head\n${JSON.stringify(image, null, 2)}`, meta: undefined }])
  })
  it('tool/result carries the failure identity and forces isError', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c3', content: [{ type: 'text', text: 'boom' }] },
    ] }, error: { name: 'ToolExecutionError', code: 'timeout' } } }))
      .toEqual([{ kind: 'tool-result-card', callId: 'c3', isError: true, errorCode: 'timeout', resultText: 'boom', meta: undefined }])
  })
  it('tool/result with an empty content and an error names it `<name>: <code>`', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c4', content: [], isError: true },
    ] }, error: { name: 'ToolExecutionError', code: 'interrupted' } } }))
      .toEqual([{ kind: 'tool-result-card', callId: 'c4', isError: true, errorCode: 'interrupted', resultText: 'ToolExecutionError: interrupted', meta: undefined }])
  })
  it('tool/result marks a block-level isError with no failure identity', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c5', content: [{ type: 'text', text: 'refused' }], isError: true },
    ] } } }))
      .toEqual([{ kind: 'tool-result-card', callId: 'c5', isError: true, errorCode: undefined, resultText: 'refused', meta: undefined }])
  })
  it('tool/result passes meta through untouched (the producing tool owns its shape)', () => {
    const meta = { diffs: [{ path: '/a', oldText: null, newText: 'x' }] }
    const out = translateSessionEvent({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c6', content: [{ type: 'text', text: 'ok' }] },
    ] }, meta } })
    expect(out[0]).toMatchObject({ kind: 'tool-result-card', callId: 'c6', meta })
    expect((out[0] as { meta: unknown }).meta).toBe(meta)
  })
  it('tool/result with no message at all stays an empty, successful, uncorrelated card event', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: {} }))
      .toEqual([{ kind: 'tool-result-card', callId: '', isError: false, errorCode: undefined, resultText: '', meta: undefined }])
  })
  it('tool/result with a text block missing its text yields an empty string for that block', () => {
    expect(translateSessionEvent({ type: 'tool/result', data: { message: { content: [
      { type: 'tool-result', toolCallId: 'c7', content: [{ type: 'text' }] },
    ] } } }))
      .toEqual([{ kind: 'tool-result-card', callId: 'c7', isError: false, errorCode: undefined, resultText: '', meta: undefined }])
  })
  it('translates the approval audit pair', () => {
    expect(translateSessionEvent({ type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'c1' } }))
      .toEqual([{ kind: 'approval-asked', id: 'a1', toolName: 'bash' }])
    expect(translateSessionEvent({ type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } }))
      .toEqual([{ kind: 'approval-decided', id: 'a1', outcome: 'allowed-once' }])
  })
  it('approval/asked falls back to an empty toolName when missing', () => {
    expect(translateSessionEvent({ type: 'approval/asked', data: { id: 'a2' } }))
      .toEqual([{ kind: 'approval-asked', id: 'a2', toolName: '' }])
  })
  it('translates command/run and command/done', () => {
    expect(translateSessionEvent({ type: 'command/run', data: { commandId: 'c1', name: 'status', args: undefined, source: { kind: 'user' } } }))
      .toEqual([{ kind: 'command-run', name: 'status', args: undefined }])
    expect(translateSessionEvent({ type: 'command/run', data: { commandId: 'c1', name: 'help', args: 'verbose', source: { kind: 'user' } } }))
      .toEqual([{ kind: 'command-run', name: 'help', args: 'verbose' }])
    expect(translateSessionEvent({ type: 'command/done', data: { commandId: 'c1', kind: 'success', text: 'ok' } }))
      .toEqual([{ kind: 'command-done', result: 'success', text: 'ok' }])
    expect(translateSessionEvent({ type: 'command/done', data: { commandId: 'c1', kind: 'error', text: 'nope' } }))
      .toEqual([{ kind: 'command-done', result: 'error', text: 'nope' }])
    expect(translateSessionEvent({ type: 'command/done', data: { commandId: 'c1', kind: 'success' } }))
      .toEqual([{ kind: 'command-done', result: 'success', text: undefined }])
  })
  it('command/run args arrive as parseCommand rawInput (separator whitespace kept, empty when absent)', () => {
    // Real wire shape, verified against dsh's own parser: parseCommand's
    // lookahead leaves the separator in rawInput, and execute always records
    // that verbatim string (commands/src/index.ts:101-107, :307-312), so
    // `/help verbose` logs args ' verbose' and `/status` logs args ''.
    expect(translateSessionEvent({ type: 'command/run', data: { commandId: 'c1', name: 'help', args: ' verbose', source: { kind: 'user' } } }))
      .toEqual([{ kind: 'command-run', name: 'help', args: 'verbose' }])
    expect(translateSessionEvent({ type: 'command/run', data: { commandId: 'c1', name: 'status', args: '', source: { kind: 'user' } } }))
      .toEqual([{ kind: 'command-run', name: 'status', args: undefined }])
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

describe('compaction (spec §4.1, rulings 6 and 7)', () => {
  it('a compact checkpoint becomes the permanent marker, NOT a context card', () => {
    expect(translateSessionEvent({ type: 'user/message', data: {
      content: [{ type: 'text', text: 'summary of the earlier conversation' }],
      source: { kind: 'plugin', plugin: 'compact', compactionId: 'k1' },
    } })).toEqual([{ kind: 'compaction-marker' }])
  })
  it('every other plugin source keeps the context-card path', () => {
    expect(translateSessionEvent({ type: 'user/message', data: {
      content: [{ type: 'text', text: 'note' }],
      source: { kind: 'plugin', plugin: 'skills' },
    } })).toEqual([{ kind: 'context-card', label: 'plugin', summary: undefined, text: 'note' }])
  })
  it('start and end drive the live indicator; summary and prune render nothing', () => {
    expect(translateSessionEvent({ type: 'compaction/start', data: { compactionId: 'k1', turn: 3 } }))
      .toEqual([{ kind: 'compaction-live', phase: 'start' }])
    expect(translateSessionEvent({ type: 'compaction/end', data: { compactionId: 'k1', turn: 3 } }))
      .toEqual([{ kind: 'compaction-live', phase: 'end' }])
    expect(translateSessionEvent({ type: 'compaction/summary', data: { compactionId: 'k1' } })).toEqual([])
    expect(translateSessionEvent({ type: 'compaction/prune', data: { shadowedSeqs: [1, 2] } })).toEqual([])
  })
})

describe('retry + interrupted (spec §4.1, rulings 8 and 9)', () => {
  const retry = (over: Record<string, unknown>) => translateSessionEvent({ type: 'llm/retry', data: {
    retryId: 'r1', turn: 1, step: 2, provider: 'deepseek', policyKey: 'p', retry: 2, delayMs: 750,
    failure: { message: 'connection reset', code: 'ECONNRESET' }, ...over,
  } })

  it('carries the attempt, the limit and the failure message', () => {
    expect(retry({ mode: 'normal', maxRetries: 5 }))
      .toEqual([{ kind: 'retry-notice', turn: 1, step: 2, retry: 2, limit: 5, delayMs: 750, message: 'connection reset' }])
  })
  it('reads the always-retry mode as an unbounded limit', () => {
    expect(retry({ mode: 'always' })[0]).toMatchObject({ limit: '∞' })
  })
  it('survives a failure with no message', () => {
    expect(retry({ mode: 'always', failure: {} })[0]).toMatchObject({ message: '' })
  })
  it('renders nothing for retry-started — the notice already said it', () => {
    expect(translateSessionEvent({ type: 'llm/retry-started', data: { retryId: 'r1', turn: 1, step: 2, retry: 2 } })).toEqual([])
  })
  it('an interrupted assistant message settles like any other (ruling 9)', () => {
    expect(translateSessionEvent({ type: 'assistant/message', data: {
      turn: 1, step: 1, interrupted: true, message: { content: [{ type: 'text', text: 'the delivered prefix' }] },
    } })).toEqual([{ kind: 'stream-settle', turn: 1, step: 1, content: [{ type: 'text', text: 'the delivered prefix' }] }])
  })
})

describe('footer metrics events (spec §3.8/§3.2)', () => {
  it('normalizes a usage report, defaulting every bucket a provider omits', () => {
    expect(translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'usage', usage: { inputTokens: 10 } } } }))
      .toEqual([{ kind: 'usage', turn: 1, step: 2, usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }])
    expect(translateSessionEvent({ type: 'assistant/chunk', data: { turn: 1, step: 2, chunk: { type: 'usage' } } })[0])
      .toMatchObject({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })
  })
  it('reports a settled message and its usage together, and the message alone without it', () => {
    const both = translateSessionEvent({ type: 'assistant/message', data: {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 5, outputTokens: 2 },
    } })
    expect(both.map((e) => e.kind)).toEqual(['stream-settle', 'usage'])
    expect(translateSessionEvent({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [] } } }).map((e) => e.kind))
      .toEqual(['stream-settle'])
  })
  it('carries the model and the window, and tolerates a request that declares no window', () => {
    expect(translateSessionEvent({ type: 'request/context', data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 64000 } }))
      .toEqual([{ kind: 'request-context', model: 'deepseek-chat', contextWindow: 64000 }])
    expect(translateSessionEvent({ type: 'request/context', data: { provider: 'p' } }))
      .toEqual([{ kind: 'request-context', model: '', contextWindow: undefined }])
  })
  it('counts an inbox splice both ways, and reads a cancelled one as a clear', () => {
    expect(translateSessionEvent({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [{}, {}] } }))
      .toEqual([{ kind: 'inbox-spliced', inserted: 2, removed: 0, cancelled: false }])
    expect(translateSessionEvent({ type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 3, outcome: 'canceled' } }))
      .toEqual([{ kind: 'inbox-spliced', inserted: 0, removed: 3, cancelled: true }])
  })
})

describe('session/title (spec §8 T4)', () => {
  it('carries the title, and reads a title-free event as empty', () => {
    expect(translateSessionEvent({ type: 'session/title', data: { title: 'Fix the login flow', messageSeqs: [], source: { kind: 'llm' } } }))
      .toEqual([{ kind: 'session-title', title: 'Fix the login flow' }])
    expect(translateSessionEvent({ type: 'session/title', data: {} })).toEqual([{ kind: 'session-title', title: '' }])
  })
})

describe('the durable workflow record (spec §3.9)', () => {
  it('maps all four events, and narrows an unknown settlement to a terminal one', () => {
    expect(translateSessionEvent({ type: 'tool-workflow/run-start', data: { runId: 'r1', name: 'review-changes' } }))
      .toEqual([{ kind: 'workflow-run-start', runId: 'r1', name: 'review-changes' }])
    expect(translateSessionEvent({ type: 'tool-workflow/agent-start', data: { runId: 'r1', seq: 2, label: 'review:bugs', phase: 'Review', childId: 'c' } }))
      .toEqual([{ kind: 'workflow-agent-start', runId: 'r1', seq: 2, label: 'review:bugs', phase: 'Review' }])
    expect(translateSessionEvent({ type: 'tool-workflow/agent-start', data: { runId: 'r1', seq: 3, label: 'x' } })[0])
      .toMatchObject({ phase: undefined })
    for (const [outcome, expected] of [['completed', 'completed'], ['cancelled', 'cancelled'], ['failed', 'failed'], ['who-knows', 'failed']]) {
      expect(translateSessionEvent({ type: 'tool-workflow/agent-end', data: { runId: 'r1', seq: 1, outcome } })[0])
        .toMatchObject({ kind: 'workflow-agent-end', outcome: expected })
    }
    for (const [reason, expected] of [['completed', 'completed'], ['cancelled', 'cancelled'], ['error', 'error'], ['exploded', 'error']]) {
      expect(translateSessionEvent({ type: 'tool-workflow/run-end', data: { runId: 'r1', stopReason: reason } })[0])
        .toMatchObject({ kind: 'workflow-run-end', stopReason: expected })
    }
  })

  it('reads a record missing its fields as an empty, zeroed one rather than throwing', () => {
    // A truncated or hand-edited log must still translate: the card then shows
    // an unnamed run rather than taking the frame down.
    expect(translateSessionEvent({ type: 'tool-workflow/run-start', data: {} }))
      .toEqual([{ kind: 'workflow-run-start', runId: '', name: '' }])
    expect(translateSessionEvent({ type: 'tool-workflow/agent-start', data: {} }))
      .toEqual([{ kind: 'workflow-agent-start', runId: '', seq: 0, label: '', phase: undefined }])
    expect(translateSessionEvent({ type: 'tool-workflow/agent-end', data: {} }))
      .toEqual([{ kind: 'workflow-agent-end', runId: '', seq: 0, outcome: 'failed' }])
    expect(translateSessionEvent({ type: 'tool-workflow/run-end', data: {} }))
      .toEqual([{ kind: 'workflow-run-end', runId: '', stopReason: 'error' }])
  })
})
