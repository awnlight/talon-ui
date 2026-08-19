/** talon's own slash commands, registered GLOBALLY on the root ctx (Ruling 3:
 * survives D8 rebinding; single-UI process makes global ≡ agent-scoped).
 * Handlers stay thin: everything stateful comes in through deps. */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

export interface TalonCommandDeps {
  requestExit(): void
  statusLines(): string[]
  list(): readonly { name: string; description: string; input?: { hint: string } }[]
}

export function registerTalonCommands(
  commands: { register(def: CommandDefinition): () => void },
  deps: TalonCommandDeps,
): () => void {
  const exitHandler = (): { kind: 'success' } => { deps.requestExit(); return { kind: 'success' } }
  const disposers = [
    commands.register({
      name: 'help', description: 'List available commands',
      handler: () => ({ kind: 'success', text: deps.list().map((c) => `/${c.name} — ${c.description}`).join('\n') }),
    }),
    commands.register({
      name: 'status', description: 'Show session status',
      handler: () => ({ kind: 'success', text: deps.statusLines().join('\n') }),
    }),
    commands.register({ name: 'exit', description: 'Exit talon', handler: exitHandler }),
    commands.register({ name: 'quit', description: 'Exit talon (alias of /exit)', handler: exitHandler }),
  ]
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}

export interface SessionCommandDeps {
  openResume(): void
  newSession(): void
}

/** The session-switching pair (spec D8/§3.5). Both handlers only START the
 * controller's async flow and return success immediately: what the user cares
 * about (the selector, the rebind, every refusal) arrives as a local notice,
 * so `command/done` stays noise-free and replay-identical. */
export function registerSessionCommands(
  commands: { register(def: CommandDefinition): () => void },
  deps: SessionCommandDeps,
): () => void {
  const disposers = [
    commands.register({
      name: 'resume', description: 'Resume a previous session',
      handler: () => { deps.openResume(); return { kind: 'success' } },
    }),
    commands.register({
      name: 'clear', description: 'Start a fresh session',
      handler: () => { deps.newSession(); return { kind: 'success' } },
    }),
  ]
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
