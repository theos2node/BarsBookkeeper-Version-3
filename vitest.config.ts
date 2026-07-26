import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 80,
        lines: 85,
      },
    },
  },
})
