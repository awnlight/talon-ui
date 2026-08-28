/** Read a committed `session.jsonl` back into the session events it stores.
 *
 * Line 0 is the session HEADER record, not an event. Delta runs are stored
 * PACKED — one `text-chunks` / `reasoning-chunks` / `tool-call-chunks` row per
 * run — so the file is decoded through dsh's own `decodeStorageRecord` rather
 * than a hand-rolled reader: the fixture then exercises exactly the bytes a
 * live session wrote, and a future packing change surfaces here instead of
 * silently reshaping the replay. */
import { readFileSync } from 'node:fs'
import { decodeStorageRecord } from '@deepseek-ai/dsh-session'

export interface LoggedSession {
  header: { id: string; cwd?: string; createdAt?: number }
  events: { type: string; data: unknown; time?: number }[]
}

export function readSessionLog(path: string): LoggedSession {
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '')
  const [head, ...rest] = lines
  const header = JSON.parse(head!) as LoggedSession['header'] & { type?: string }
  if (header.type !== 'session') throw new Error(`${path}: line 0 is not a session header`)
  const events = rest.flatMap((line) => decodeStorageRecord(JSON.parse(line)) as unknown as LoggedSession['events'])
  return { header, events }
}
