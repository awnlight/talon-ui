import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      '@deepseek-ai/dsh-session': fileURLToPath(new URL('../deepseek-harness/packages/core/session', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.snapshot.ts'],
    pool: 'forks',
  },
})
