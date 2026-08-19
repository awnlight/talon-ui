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
