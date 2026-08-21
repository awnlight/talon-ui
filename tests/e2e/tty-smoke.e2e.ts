import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const harness = fileURLToPath(new URL('../../../deepseek-harness', import.meta.url))
const profile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'talon')
const python = ((): string | undefined => {
  try { return execFileSync('which', ['python3']).toString().trim() || undefined } catch { return undefined }
})()
const ready = process.env.DEEPSEEK_API_KEY !== undefined && python !== undefined && existsSync(harness) && existsSync(profile)

describe.skipIf(!ready)('tty smoke (live model + real PTY)', () => {
  it('boots, streams, approves a sandbox escalation, and exits with the goodbye line', () => {
    const result = spawnSync(python!, [fileURLToPath(new URL('./tty-smoke.py', import.meta.url))], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
      timeout: 400_000,
    })
    expect(result.status).toBe(0)
  })
})
