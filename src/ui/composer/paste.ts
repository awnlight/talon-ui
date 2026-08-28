/** Paste (spec §8 T4, archaeology §E2).
 *
 * TEXT needs no code here: pi-tui folds a bracketed paste behind a marker
 * while it is being edited and EXPANDS it at submit (`components/editor.js`
 * calls `expandPasteMarkers` before `onSubmit`), so talon already sends the
 * full pasted content. `tests/composer.spec.ts` pins that rather than
 * re-implementing it.
 *
 * IMAGES are the part that needs work, and the part that must fail SOFT. The
 * clipboard lives outside the terminal, so reading it means running a platform
 * command that may be missing, may fail, or may hold no image at all — and any
 * of those is an ordinary Tuesday, not an error worth interrupting anyone
 * over. Every one of them leaves the composer untouched and says so in one dim
 * line.
 *
 * The subprocess is behind a seam on purpose: the command table is data (and
 * is tested as data), while callers inject a reader in tests, so nothing here
 * depends on the machine running the suite having a clipboard at all. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One image lifted off the system clipboard. */
export interface ClipboardImage { mediaType: 'image/png'; data: Uint8Array }
/** The seam: answers `undefined` for "no image", never throws. */
export type ClipboardImageReader = () => Promise<ClipboardImage | undefined>

/** How each platform is asked to write the clipboard image to `%FILE%`.
 * Data, so it can be reviewed and tested without running any of it. */
export const CLIPBOARD_IMAGE_COMMANDS: Record<string, { command: string; args: readonly string[] } | undefined> = {
  darwin: {
    command: 'osascript',
    args: ['-e', 'set f to (open for access POSIX file "%FILE%" with write permission)',
      '-e', 'try', '-e', 'write (the clipboard as «class PNGf») to f', '-e', 'end try',
      '-e', 'close access f'],
  },
  linux: { command: 'sh', args: ['-c', 'wl-paste --type image/png > "%FILE%" 2>/dev/null || xclip -selection clipboard -t image/png -o > "%FILE%"'] },
  win32: {
    command: 'powershell',
    args: ['-NoProfile', '-Command', 'Add-Type -Assembly PresentationCore; $i=[Windows.Clipboard]::GetImage(); if ($i) { $e=New-Object Windows.Media.Imaging.PngBitmapEncoder; $e.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($i)); $s=[IO.File]::Open("%FILE%","Create"); $e.Save($s); $s.Close() }'],
  },
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

/** The command for one platform, with `%FILE%` resolved. `undefined` where
 * talon has no way to ask — which is simply "no image", like an empty
 * clipboard. Pure, so the table is testable without running any of it. */
export function clipboardCommand(platform: string, file: string): { command: string; args: string[] } | undefined {
  const recipe = CLIPBOARD_IMAGE_COMMANDS[platform]
  return recipe === undefined ? undefined : { command: recipe.command, args: recipe.args.map((arg) => arg.replaceAll('%FILE%', file)) }
}

/** Whether these bytes are a PNG. The clipboard tools above are asked for one
 * and asked to write it to a file; an empty or half-written file is the normal
 * shape of "there was no image", so the magic decides rather than the exit code. */
export function isPng(data: Uint8Array): boolean {
  return data.length > PNG_MAGIC.length && PNG_MAGIC.every((byte, i) => data[i] === byte)
}

/* v8 ignore start -- a thin adapter over a PLATFORM CLIPBOARD TOOL: every
   branch here is "the tool is missing / refused / wrote nothing", and no test
   can make a real clipboard hold, or not hold, an image deterministically. The
   logic it wraps is `clipboardCommand` and `isPng` above, both pure and both
   covered; what remains is execFile plus a temp file, and every failure path
   collapses to the same `undefined` the callers are tested against. */
/** Run the platform command into a temp file and read it back. Answers
 * `undefined` for every failure — an unsupported platform, a missing tool, a
 * non-zero exit, an empty file, or bytes that are not a PNG. */
export const readClipboardImage: ClipboardImageReader = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'talon-paste-')).catch(() => undefined)
  if (dir === undefined) return undefined
  const file = join(dir, 'clipboard.png')
  const recipe = clipboardCommand(process.platform, file)
  if (recipe === undefined) return undefined
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(recipe.command, recipe.args, (error) => (error ? reject(error) : resolve()))
    })
    const data = await readFile(file)
    return isPng(data) ? { mediaType: 'image/png', data } : undefined
  } catch {
    return undefined
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
/* v8 ignore stop */

/** What the attachment store gives back for a saved image. */
export interface StoredImage { id: string }
export interface PasteImageDeps {
  read: ClipboardImageReader
  /** `ctx.attachments.saveImages`; absent when no store is composed. */
  save?: (images: readonly { mediaType: string; data: Uint8Array }[]) => Promise<readonly StoredImage[]>
}

/** What a paste attempt did, for the caller to render as one dim line. */
export type PasteImageOutcome =
  | { kind: 'stored'; mention: string }
  | { kind: 'unavailable' }        // no attachment store in this composition
  | { kind: 'empty' }              // the clipboard holds no image
  | { kind: 'failed'; reason: string }

/** The mention an image gets in the prompt: a reference, like every other
 * completion — the bytes live in the attachment store. */
export function imageMention(id: string): string { return `@image:${id}` }

export async function pasteImage(deps: PasteImageDeps): Promise<PasteImageOutcome> {
  if (deps.save === undefined) return { kind: 'unavailable' }
  const image = await deps.read()
  if (image === undefined) return { kind: 'empty' }
  try {
    const [stored] = await deps.save([image])
    return stored === undefined ? { kind: 'empty' } : { kind: 'stored', mention: imageMention(stored.id) }
  } catch (cause) {
    return { kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) }
  }
}
