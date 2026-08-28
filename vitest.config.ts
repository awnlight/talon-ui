import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-session': fileURLToPath(new URL('../deepseek-harness/packages/core/session', import.meta.url)),
      '@deepseek-ai/dsh-user-questions': fileURLToPath(new URL('../deepseek-harness/packages/interaction/user-questions', import.meta.url)),
      '@deepseek-ai/dsh-commands': fileURLToPath(new URL('../deepseek-harness/packages/interaction/commands', import.meta.url)),
      '@deepseek-ai/schemastery': fileURLToPath(new URL('../deepseek-harness/vendor/schemastery/lib/index.mjs', import.meta.url)),
      '@deepseek-ai/dsh-file-reference/grammar': fileURLToPath(new URL('../deepseek-harness/packages/context/file-reference/src/grammar.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.snapshot.ts'],
    pool: 'forks',
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/backend/app-events.ts'], // type-only module: erases to an empty runtime file, v8 reports 0/0
      thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
