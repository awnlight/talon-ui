/** One mounted talon channel: TuiMainScreen + Transcript + Composer +
 * global keys + backend subscriptions. Async results re-enter through the
 * same handlers — no side-channel state (spec §2 data flow). */
import { matchesKey, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui'
import { translateSessionEvent } from '../backend/translate.js'
import type { Palette } from '../theme/palette.js'
import { Composer } from '../ui/composer/composer.js'
import { Transcript } from '../ui/transcript/transcript.js'

export interface ControllerDeps {
  ctx: { on(event: string, fn: (...args: any[]) => void): () => void }
  agent: {
    id: string
    status: 'idle' | 'running'
    session: unknown
    cancel(cause: { kind: 'user' }): void
    followup(message: unknown): void
    steer(message: unknown): void
    whenIdle(): Promise<void>
  }
  terminal: Terminal
  palette: Palette
  exit(code: number): void
}

const HINT_IDLE = 'enter send · shift+enter newline · ctrl+c exit'
const HINT_RUNNING = 'esc interrupt · ctrl+c interrupt'

/**
 * Build a value shaped like dsh's real `UserMessage` (id/role/content/source)
 * so a live agent's `followup`/`steer` accepts it — the task brief's bare
 * `{ content }` object does not match the real wire shape (controller ruling
 * 4). Hand-constructed rather than calling the real `createUserMessage`:
 * `@deepseek-ai/dsh-llm`'s tsconfig path points at raw
 * `packages/llm/llm/src` (not a compiled `.d.ts`), and that package's
 * `src/index.ts:9` imports `@deepseek-ai/cordis` as a value — which has no
 * path mapping and is not installed. Confirmed empirically: importing
 * anything from `@deepseek-ai/dsh-llm` makes `tsc -p tsconfig.json --noEmit`
 * fail with `TS2307: Cannot find module '@deepseek-ai/dsh-llm'`.
 *
 * Shape mirrors `deepseek-harness/packages/llm/llm/src/message.ts:129-143`
 * (`Message`/`UserMessage`: `id`, `role`, `content`, `source`) and
 * `:192-199` (`createUserMessage`: `role: 'user'` + a fresh `MessageId`,
 * which `brand.ts:23-24` shows is just `id as MessageId` — a plain string at
 * runtime, so `crypto.randomUUID()` here is runtime-identical). Matches the
 * real production call site `packages/schedule/schedule/src/runtime.ts:
 * 271-275` and every dsh test call site:
 * `createUserMessage({ content, source: { kind: 'user' } })` passed straight
 * into `agent.followup`/`steer` — both typed to take a complete `UserMessage`,
 * not a partial (`packages/core/agent/lib/types/runtime-types.d.ts:115,123`).
 */
function toUserMessage(text: string) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

export function createController(deps: ControllerDeps): { dispose(): Promise<void> } {
  const { ctx, agent, terminal, palette, exit } = deps
  const tui = new TuiMainScreen(terminal)
  tui.setClearOnShrink(false) // spec D10: shrink clears via normal diff, never a scrollback-wiping full redraw
  const transcript = new Transcript(palette)
  const composer = new Composer(tui, palette)
  composer.setHint(HINT_IDLE)
  tui.addChild(transcript.container)
  tui.addChild(composer.container)
  tui.setFocus(composer.editor)

  let disposed = false
  let running = agent.status === 'running'
  const hasPanel = (): boolean => false // T2 replaces with PanelManager.activePanel !== undefined

  const detachers: (() => void)[] = []

  detachers.push(ctx.on('session/event', (session: unknown, event: { type: string; data: unknown; time?: number }) => {
    if (session !== agent.session || disposed) return
    for (const appEvent of translateSessionEvent(event)) transcript.apply(appEvent)
    tui.requestRender()
  }))

  detachers.push(ctx.on('agent/status', (payload: { agent: unknown; status: 'idle' | 'running' }) => {
    if (payload.agent !== agent || disposed) return
    running = payload.status === 'running'
    composer.setState(running ? 'streaming' : 'idle')
    composer.setHint(running ? HINT_RUNNING : HINT_IDLE)
    tui.requestRender()
  }))

  composer.onSubmit = (text) => {
    /* v8 ignore next -- defensive: dispose() tears down the terminal's input pipeline synchronously (tui.stop() -> terminal.stop()), so no keystroke can reach onSubmit once disposed is true; nothing outside this closure can invoke onSubmit directly to race it either */
    if (disposed) return
    const message = toUserMessage(text)
    if (running) agent.steer(message)
    else agent.followup(message)
    composer.editor.setText('')
    composer.editor.addToHistory(text)
    tui.requestRender()
  }

  let exitRequested = false
  const requestExit = (): void => {
    /* v8 ignore next -- defensive: exitRequested is always false on first entry. Both call sites below only invoke requestExit() once disposal hasn't happened yet, and dispose() (triggered synchronously by the else branch, the only branch ever taken today) tears down every input listener before a second call could ever land — so this re-entrancy guard has nothing to exercise. Kept for a future caller that might invoke requestExit() twice in the same tick. */
    if (exitRequested) return
    exitRequested = true
    /* v8 ignore next 4 -- defensive: no current caller reaches requestExit() while running. Both call sites below guard on `!running` (Ctrl+C cancels-and-returns without calling requestExit while running; Ctrl+D is a no-op while running), so this branch has nothing to exercise today. Kept for a future caller (e.g. a /quit command) that requests exit mid-turn. */
    if (running) {
      agent.cancel({ kind: 'user' })
      void agent.whenIdle().then(() => { void dispose().then(() => exit(0)) })
    } else {
      void dispose().then(() => exit(0))
    }
  }

  detachers.push(tui.addInputListener((data) => {
    /* v8 ignore next -- hasPanel() is hardcoded false until T2 replaces it with PanelManager.activePanel !== undefined; this branch has no way to go true yet */
    if (hasPanel()) return undefined // panels own 100% of input (spec D5)
    if (matchesKey(data, 'ctrl+c')) {
      if (running) { agent.cancel({ kind: 'user' }); return { consume: true } }
      if (composer.editor.getText() !== '') { composer.editor.setText(''); tui.requestRender(); return { consume: true } }
      requestExit()
      return { consume: true }
    }
    // 'escape' is exact/anchored-only in pi-tui 0.84.1 (controller ruling 6):
    // matchesKey checks `data === '\x1b'` or a fully `^...$`-anchored Kitty/
    // modifyOtherKeys escape encoding (dist/keys.js, the "escape" case of
    // matchesKey). Empirically verified against the real package — arrow
    // keys, alt+letter, home/end, F-keys, and bracketed-paste content (all
    // \x1b-prefixed) do NOT match; only a bare ESC byte or a full CSI-u/
    // modifyOtherKeys escape encoding does. No prefix-match guard needed.
    if (matchesKey(data, 'escape') && running) { agent.cancel({ kind: 'user' }); return { consume: true } }
    if (matchesKey(data, 'ctrl+l')) { tui.requestRender(true); return { consume: true } }
    if (matchesKey(data, 'ctrl+d') && composer.editor.getText() === '') {
      if (!running) requestExit()
      return { consume: true }
    }
    return undefined
  }))

  tui.start()

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    for (const detach of detachers.splice(0)) detach()
    tui.stop()
  }

  return { dispose }
}
