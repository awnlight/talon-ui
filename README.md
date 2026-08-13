# Talon

Talon is a terminal UI for DeepSeek Harness agents. Install the plugin with `dsh plugin --profile talon add <path>` and run agents with `dsh --profile talon`.

## Requirements

This package's `tsconfig.json` resolves `@deepseek-ai/dsh-agent`/`@deepseek-ai/dsh-session` to the sibling `../deepseek-harness` checkout's **compiled** declarations (`packages/*/lib/types/*.d.ts`), which are git-ignored build output, not source. `pnpm typecheck`/`pnpm build` fail on a fresh `../deepseek-harness` clone until it's built:

```bash
cd ../deepseek-harness && pnpm install && pnpm run build:lib:host
```
