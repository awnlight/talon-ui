/** One mounted talon channel: TuiMainScreen + Transcript + Composer +
 * global keys + backend subscriptions. Async results re-enter through the
 * same handlers — no side-channel state (spec §2 data flow). */
import { matchesKey, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { attachApprovalResponder } from '../backend/approval.js'
import { translateSessionEvent } from '../backend/translate.js'
import type { Palette } from '../theme/palette.js'
import { Composer } from '../ui/composer/composer.js'
import { ApprovalPanel } from '../ui/panels/approval-panel.js'
import { PanelManager } from '../ui/panels/panel-manager.js'
import { Transcript } from '../ui/transcript/transcript.js'

export interface ControllerDeps {
  /** The plugin's ROOT ctx — NOT a per-agent scope (root-ctx flip, T2 Task
   * 5). dsh's event dispatch is scope-filtered per agent, so a listener
   * bound to `agent.ctx` goes deaf across Task 16's in-process rebind;
   * binding the root here keeps listening. The per-event identity checks
   * below (`session !== bound.session`, `payload.agent !== bound`) are the
   * ONLY filter keeping other agents' events out — required for D8. */
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

export function createController(deps: ControllerDeps): { dispose(): Promise<void>; panels: PanelManager } {
  const { ctx, agent, terminal, palette, exit } = deps
  const tui = new TuiMainScreen(terminal)
  tui.setClearOnShrink(false) // spec D10: shrink clears via normal diff, never a scrollback-wiping full redraw
  const transcript = new Transcript(palette)
  const composer = new Composer(tui, palette)
  composer.setHint(HINT_IDLE)

  let disposed = false
  let running = agent.status === 'running'
  // Identity target for the two per-event filters below. Always `agent`
  // today; Task 16's in-process rebind reassigns this in place so the
  // listeners registered against the root ctx (see ControllerDeps.ctx) keep
  // matching the live agent instead of going deaf.
  let bound = agent
  const panels = new PanelManager({
    setFocus: (c) => tui.setFocus(c),
    focusHome: () => composer.editor,
    requestRender: () => tui.requestRender(),
    onActiveChange: (active) => {
      composer.setState(active ? 'waiting' : running ? 'streaming' : 'idle')
      tui.requestRender()
    },
  })
  const hasPanel = (): boolean => panels.active !== undefined

  tui.addChild(transcript.container)
  tui.addChild(panels.container)
  tui.addChild(composer.container)
  tui.setFocus(composer.editor)

  const detachers: (() => void)[] = []
  // Tool-call previews, keyed by callId, so an approval prompt for that call
  // can enrich its header (spec D9); cleared per turn — a callId is only
  // ever relevant to the turn that issued it.
  const pendingCalls = new Map<string, string>()

  detachers.push(ctx.on('session/event', (session: unknown, event: { type: string; data: unknown; time?: number }) => {
    if (session !== bound.session || disposed) return
    for (const appEvent of translateSessionEvent(event)) {
      if (appEvent.kind === 'tool-call' && appEvent.preview !== undefined) pendingCalls.set(appEvent.callId, appEvent.preview)
      if (appEvent.kind === 'turn-end') pendingCalls.clear()
      transcript.apply(appEvent)
    }
    tui.requestRender()
  }))

  detachers.push(ctx.on('agent/status', (payload: { agent: unknown; status: 'idle' | 'running' }) => {
    if (payload.agent !== bound || disposed) return
    running = payload.status === 'running'
    composer.setState(panels.active ? 'waiting' : running ? 'streaming' : 'idle')
    composer.setHint(running ? HINT_RUNNING : HINT_IDLE)
    tui.requestRender()
  }))

  // The approval/request waterfall responder (spec D9): claims only this
  // controller's bound agent's requests by identity, presents them through
  // the same PanelManager FIFO every other panel uses. A signal abort while
  // the panel is showing force-closes it 'cancelled'; teardown rejects (the
  // real ApprovalService normalizes a rejection to 'unavailable' — fail
  // closed, Ruling 7).
  detachers.push(attachApprovalResponder(ctx as never, {
    isBound: (a) => a === bound,
    present: (req) => panels.enqueue<ApprovalOutcome>({
      create: (finish) => new ApprovalPanel({
        toolName: req.toolName,
        preview: req.callId === undefined ? undefined : pendingCalls.get(req.callId),
        reason: req.reason,
        cwd: process.cwd(),
      }, finish, palette),
      forced: (reason) => reason === 'aborted' ? { outcome: 'cancelled' } : { error: new Error('talon-ui torn down before the approval was answered') },
    }, req.signal === undefined ? {} : { signal: req.signal }),
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
    panels.disposeAll()
    tui.stop()
  }

  return { dispose, panels }
}
