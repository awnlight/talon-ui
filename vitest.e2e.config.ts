import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['tests/e2e/*.e2e.ts'], pool: 'forks', testTimeout: 420_000, hookTimeout: 60_000 },
})
