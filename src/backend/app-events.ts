/** Internal UI vocabulary. The UI state machine consumes ONLY this union;
 * dsh's event surface is translated at the contract boundary (spec D1). */
export interface Notice { text: string; tone: 'info' | 'warning' | 'error' }
export type ContentBlockLike = { type: string; text?: string; [k: string]: unknown }

export type AppEvent =
  | { kind: 'user-message'; text: string }
  | { kind: 'turn-start'; turn: number }
  | { kind: 'turn-end'; turn: number; notice: Notice | undefined }
  | { kind: 'step-start'; turn: number; step: number }
  | { kind: 'step-end'; turn: number; step: number; time: number | undefined }
  | { kind: 'stream-delta'; turn: number; step: number; index: number; block: 'text' | 'reasoning'; text: string }
  | { kind: 'stream-settle'; turn: number; step: number; content: ContentBlockLike[] }
