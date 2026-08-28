import { describe, expect, it } from 'vitest'
import { CLIPBOARD_IMAGE_COMMANDS, clipboardCommand, imageMention, isPng, pasteImage, type ClipboardImage } from '../src/ui/composer/paste.ts'

const PNG: ClipboardImage = { mediaType: 'image/png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }

describe('pasteImage (spec §8 T4 — every failure is ordinary)', () => {
  it('stores the clipboard image and answers the mention that references it', async () => {
    const saved: unknown[] = []
    const outcome = await pasteImage({
      read: async () => PNG,
      save: async (images) => { saved.push(...images); return [{ id: 'att-1' }] },
    })
    expect(outcome).toEqual({ kind: 'stored', mention: '@image:att-1' })
    expect(saved).toEqual([PNG])                       // the bytes go to the store, not into the prompt
  })

  it('says so — and changes nothing — with no attachment store', async () => {
    let read = 0
    expect(await pasteImage({ read: async () => { read += 1; return PNG } })).toEqual({ kind: 'unavailable' })
    expect(read).toBe(0)                               // the clipboard is not even touched
  })

  it('reads an image-free clipboard, and a store that saved nothing, as EMPTY', async () => {
    expect(await pasteImage({ read: async () => undefined, save: async () => [] })).toEqual({ kind: 'empty' })
    expect(await pasteImage({ read: async () => PNG, save: async () => [] })).toEqual({ kind: 'empty' })
  })

  it('reports a store that threw, without letting it escape', async () => {
    const outcome = await pasteImage({ read: async () => PNG, save: async () => { throw new Error('image too large') } })
    expect(outcome).toEqual({ kind: 'failed', reason: 'image too large' })
    expect(await pasteImage({ read: async () => PNG, save: async () => { throw 'plain string' } }))
      .toEqual({ kind: 'failed', reason: 'plain string' })
  })

  it('mentions an image by reference, never by content', () => {
    expect(imageMention('att-1')).toBe('@image:att-1')
  })
})

describe('the clipboard command table (data, reviewed as data)', () => {
  it('covers the three platforms talon runs on, and each writes to the placeholder', () => {
    expect(Object.keys(CLIPBOARD_IMAGE_COMMANDS).sort()).toEqual(['darwin', 'linux', 'win32'])
    for (const [platform, recipe] of Object.entries(CLIPBOARD_IMAGE_COMMANDS)) {
      expect(recipe!.command, platform).not.toBe('')
      expect(recipe!.args.join(' '), platform).toContain('%FILE%')
    }
  })

  it('resolves %FILE% for a known platform and answers nothing for an unknown one', () => {
    const darwin = clipboardCommand('darwin', '/tmp/x.png')!
    expect(darwin.command).toBe('osascript')
    expect(darwin.args.join(' ')).toContain('/tmp/x.png')
    expect(darwin.args.join(' ')).not.toContain('%FILE%')
    expect(clipboardCommand('aix', '/tmp/x.png')).toBeUndefined()   // no way to ask == no image
  })

  it('decides on the PNG magic, not the exit code — an empty or half-written file is no image', () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(true)
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)   // magic alone, no payload
    expect(isPng(new Uint8Array())).toBe(false)
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]))).toBe(false) // a JPEG is not what was asked for
  })
})
