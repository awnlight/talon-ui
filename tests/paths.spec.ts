import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { abbreviateHome } from '../src/ui/paths.ts'

describe('abbreviateHome — POSIX', () => {
  const home = '/home/devbox'
  const at = (path: string): string => abbreviateHome(path, home, 'linux')

  it('abbreviates home itself and anything genuinely under it', () => {
    expect(at(home)).toBe('~')
    expect(at('/home/devbox/proj/app')).toBe('~/proj/app')
    expect(at('/home/devbox/')).toBe('~/')
  })
  it('leaves a near-miss prefix alone — /home/devboxial is a different person', () => {
    expect(at('/home/devboxial/proj')).toBe('/home/devboxial/proj')
    expect(at('/home/devbox-backup')).toBe('/home/devbox-backup')
  })
  it('leaves an unrelated path, and a case-differing one, untouched', () => {
    expect(at('/etc/hosts')).toBe('/etc/hosts')
    expect(at('/HOME/DEVBOX/proj')).toBe('/HOME/DEVBOX/proj')   // POSIX is case-SENSITIVE
  })
  it('is inert with no home, or no path', () => {
    expect(abbreviateHome('/etc', '', 'linux')).toBe('/etc')
    expect(abbreviateHome('', home, 'linux')).toBe('')
  })
})

describe('abbreviateHome — Windows (tested on every platform; ruling 11)', () => {
  const home = 'C:\\Users\\Devbox'
  const at = (path: string): string => abbreviateHome(path, home, 'win32')

  it('abbreviates home and its descendants, keeping the separators the caller used', () => {
    expect(at(home)).toBe('~')
    expect(at('C:\\Users\\Devbox\\proj\\app')).toBe('~\\proj\\app')
    expect(at('C:/Users/Devbox/proj/app')).toBe('~/proj/app')      // mixed separators are legal
  })
  it('compares case-insensitively, because Windows paths do', () => {
    expect(at('c:\\users\\devbox\\proj')).toBe('~\\proj')
    expect(at('C:\\USERS\\DEVBOX')).toBe('~')
  })
  it('REFUSES to abbreviate across drives — the same string is a different place', () => {
    expect(at('D:\\Users\\Devbox\\proj')).toBe('D:\\Users\\Devbox\\proj')
    expect(at('\\\\server\\share\\Users\\Devbox')).toBe('\\\\server\\share\\Users\\Devbox')   // UNC
  })
  it('leaves a near-miss prefix alone here too', () => {
    expect(at('C:\\Users\\Devboxial\\proj')).toBe('C:\\Users\\Devboxial\\proj')
  })
  it('tolerates a home recorded with a trailing separator', () => {
    expect(abbreviateHome('C:\\Users\\Devbox\\proj', 'C:\\Users\\Devbox\\', 'win32')).toBe('~\\proj')
  })
})

describe('abbreviateHome — the live defaults', () => {
  it('reads the real home and platform when none is given', () => {
    expect(abbreviateHome(homedir())).toBe('~')
    expect(abbreviateHome('/definitely/not/home')).toBe('/definitely/not/home')
  })
})
