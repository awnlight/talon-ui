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
    case 'user/message':
      return [{ kind: 'user-message', text: textOf(d.content) }]
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
    default:
      return []
  }
}
