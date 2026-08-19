import type { AppEvent, ContentBlockLike, Notice } from './app-events.js'

interface RawEvent { type: string; data: unknown; time?: number }

function turnEndNotice(reason: { kind: string; error?: { message?: string } }): Notice | undefined {
  switch (reason.kind) {
    case 'completed': return undefined
    case 'aborted': case 'interrupted': return { text: 'Turn cancelled.', tone: 'warning' }
    case 'error': return { text: reason.error?.message ?? 'Turn failed.', tone: 'error' }
    case 'max-tokens': return { text: 'Turn stopped: max tokens reached.', tone: 'warning' }
    case 'blocked': return { text: 'Turn blocked.', tone: 'warning' }
    default: return { text: `Turn ended: ${reason.kind}.`, tone: 'warning' } // exhaustive-with-named-default (spec §3.2)
  }
}

function textOf(content: ContentBlockLike[] | undefined): string {
  return (content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n\n')
}

/** Translate one dsh session event into zero-or-more AppEvents. Unknown
 * event types return [] (skip-safe across the 40-type durable vocabulary). */
export function translateSessionEvent(event: RawEvent): AppEvent[] {
  const d = event.data as Record<string, any>
  switch (event.type) {
    case 'user/message': {
      // `source.kind === 'user'` is the ONLY real typed prompt (dsh's
      // MessageSourceMap, llm/src/message.ts:100); every other kind is
      // injected context. An absent source keeps fixture/legacy logs on the
      // prompt path.
      const kind = (d.source as { kind?: string } | undefined)?.kind ?? 'user'
      if (kind === 'user') return [{ kind: 'user-message', text: textOf(d.content) }]
      const source = d.source as { form?: string; summary?: string }
      const text = textOf(d.content)
      return [{
        kind: 'context-card',
        label: kind,
        summary: source.form === 'notice' ? source.summary : undefined,
        lines: text === '' ? 0 : text.split('\n').length,
      }]
    }
    case 'turn/start':
      return [{ kind: 'turn-start', turn: d.turn }]
    case 'turn/end':
      return [{ kind: 'turn-end', turn: d.turn, notice: turnEndNotice(d.reason) }]
    case 'step/start':
      return [{ kind: 'step-start', turn: d.turn, step: d.step }]
    case 'step/end':
      return [{ kind: 'step-end', turn: d.turn, step: d.step, time: event.time }]
    case 'assistant/chunk': {
      const chunk = d.chunk as { type: string; index?: number; text?: string }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        return [{
          kind: 'stream-delta', turn: d.turn, step: d.step, index: chunk.index ?? 0,
          block: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: chunk.text ?? '',
        }]
      }
      return []
    }
    case 'assistant/message':
      return [{ kind: 'stream-settle', turn: d.turn, step: d.step, content: d.message?.content ?? [] }]
    case 'tool/call': {
      const raw = d.arguments
      const args = typeof raw === 'string'
        ? (() => { try { return JSON.parse(raw) as Record<string, unknown> } catch { return undefined } })()
        : (raw as Record<string, unknown> | undefined)
      const command = args?.command
      return [{ kind: 'tool-call', callId: String(d.callId ?? ''), name: String(d.name ?? ''), preview: typeof command === 'string' ? command : undefined }]
    }
    case 'approval/asked':
      return [{ kind: 'approval-asked', id: String(d.id), toolName: String(d.toolName ?? '') }]
    case 'approval/decided':
      return [{ kind: 'approval-decided', id: String(d.id), outcome: String(d.outcome) }]
    case 'command/run': {
      // dsh records `args` as parseCommand's verbatim rawInput — the separator
      // whitespace stays in it and an argument-less command records '' (the
      // lookahead + `line.slice(match[0].length)` at commands/src/index.ts:
      // 101-107, recorded at :307-312). Trim it to the UI's own vocabulary:
      // the argument text, or undefined when there is none.
      const args = typeof d.args === 'string' ? d.args.trim() : ''
      return [{ kind: 'command-run', name: String(d.name), args: args === '' ? undefined : args }]
    }
    case 'command/done':
      return [{ kind: 'command-done', result: d.kind === 'error' ? 'error' : 'success', text: d.text }]
    default:
      return []
  }
}
