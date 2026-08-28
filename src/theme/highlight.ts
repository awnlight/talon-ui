/** highlight.js → ANSI-16 highlight engine (spec §8, T3 ruling 13): one
 * module-level hljs instance shared by markdown fences, diff bodies and
 * read excerpts. Pure and deterministic — same input, identical output —
 * so downstream caches may key on it. Input arrives already
 * displayText-escaped and is treated as opaque text; output lines carry
 * ONLY palette-role SGR, split 1:1 with the input's lines (no sequence
 * ever spans a line break). */
import hljs from 'highlight.js'
import type { Palette } from './palette.js'

type RoleName = 'text' | 'dim' | 'accent' | 'code' | 'success' | 'warning'

/** Scope head → palette role (ruling 13). Dotted scopes map by their first
 * segment (`title.function` → title); any scope not listed renders as text. */
const SCOPE_ROLES = new Map<string, RoleName>([
  ['keyword', 'code'],
  ['string', 'success'],
  ['comment', 'dim'],
  ['number', 'warning'],
  ['literal', 'warning'],
  ['title', 'accent'],
  ['function', 'accent'],
])

/** The private-but-stable token tree behind `HighlightResult._emitter`
 * (typed as an opaque Emitter in highlight.js types/index.d.ts:107; the
 * concrete TokenTreeEmitter shape is lib/core.js:201-217). String nodes
 * are RAW source slices — hljs HTML-escapes only inside its HTMLRenderer
 * (lib/core.js:158) — so concatenating the tree reproduces the input
 * byte-for-byte and this engine never has to un-escape anything. */
interface ScopeNode { scope?: string; children: (ScopeNode | string)[] }
interface Run { role: RoleName; text: string }

function collectRuns(node: ScopeNode | string, inherited: RoleName, runs: Run[]): void {
  if (typeof node === 'string') {
    runs.push({ role: inherited, text: node })
    return
  }
  const role = node.scope === undefined ? inherited : SCOPE_ROLES.get(node.scope.split('.')[0]) ?? 'text'
  for (const child of node.children) collectRuns(child, role, runs)
}

/** Split styled runs at newlines and wrap each per-line segment in its
 * role's SGR, merging adjacent same-role segments so a token split by the
 * grammar still styles as one run. */
function toLines(runs: Run[], palette: Palette): string[] {
  const lines: Run[][] = [[]]
  for (const run of runs) {
    const parts = run.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      const part = parts[i]
      if (part === '') continue
      const line = lines[lines.length - 1]
      const last = line[line.length - 1]
      if (last !== undefined && last.role === run.role) last.text += part
      else line.push({ role: run.role, text: part })
    }
  }
  return lines.map((segments) => segments.map((s) => palette[s.role](s.text)).join(''))
}

/** Unknown/absent lang — and any grammar failure — renders the whole block
 * in the code role, line by line (pi-tui's plain-fence fallback path). */
function fallbackLines(code: string, palette: Palette): string[] {
  return code.split('\n').map((line) => (line === '' ? '' : palette.code(line)))
}

export function highlightToAnsi(code: string, lang: string | undefined, palette: Palette): string[] {
  if (lang === undefined || hljs.getLanguage(lang) === undefined) return fallbackLines(code, palette)
  const result = hljs.highlight(code, { language: lang, ignoreIllegals: true })
  // hljs runs in SAFE_MODE by default: a crashing grammar returns a PARTIAL
  // tree with `errorRaised` set instead of throwing (lib/core.js:2187-2196).
  // That tree no longer reconstructs the input, so fall back whole-block
  // rather than break the 1:1 line law.
  if (result.errorRaised !== undefined) return fallbackLines(code, palette)
  const runs: Run[] = []
  collectRuns((result._emitter as unknown as { rootNode: ScopeNode }).rootNode, 'text', runs)
  return toLines(runs, palette)
}
