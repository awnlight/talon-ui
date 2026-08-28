/** Internal UI vocabulary. The UI state machine consumes ONLY this union;
 * dsh's event surface is translated at the contract boundary (spec D1). */
export interface Notice { text: string; tone: 'info' | 'warning' | 'error' }
export type ContentBlockLike = { type: string; text?: string; [k: string]: unknown }

export type AppEvent =
  | { kind: 'user-message'; text: string }
  // Context injected as a user-role message by something other than the user
  // (skill catalogs, agent instructions, subagent notices): same durable event
  // type, different `source.kind` — never rendered as 'You' (carryover 11).
  | { kind: 'context-card'; label: string; summary: string | undefined; text: string }
  | { kind: 'turn-start'; turn: number }
  | { kind: 'turn-end'; turn: number; notice: Notice | undefined }
  | { kind: 'step-start'; turn: number; step: number }
  | { kind: 'step-end'; turn: number; step: number; time: number | undefined }
  | { kind: 'stream-delta'; turn: number; step: number; index: number; block: 'text' | 'reasoning'; text: string }
  | { kind: 'stream-settle'; turn: number; step: number; content: ContentBlockLike[] }
  // One tool card, in two halves (D12): the call opens it, the result settles
  // it in place. `args` is the parsed arguments object when the model's raw
  // JSON parses, `undefined` when it does not — `rawArguments` always carries
  // the verbatim string, so an expanded card can show exactly what was sent.
  | { kind: 'tool-call-card'; turn: number; step: number; callId: string; name: string; args: unknown; rawArguments: string }
  | { kind: 'tool-result-card'; callId: string; isError: boolean; errorCode: string | undefined; resultText: string; meta: unknown }
  | { kind: 'approval-asked'; id: string; toolName: string }
  | { kind: 'approval-decided'; id: string; outcome: string }
  | { kind: 'command-run'; name: string; args: string | undefined }
  | { kind: 'command-done'; result: 'success' | 'error'; text: string | undefined }
  // The one AppEvent no session event translates to: UI-local feedback the
  // durable log never carries (an unknown command, a failed execution).
  | { kind: 'notice'; notice: Notice }
