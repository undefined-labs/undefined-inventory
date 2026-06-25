import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['reflect-metadata', './tests/setup.ts'],
    include: ['src/**/*.spec.ts', 'tests/**/*.test.ts'],
    exclude: ['dist', 'node_modules'],
  },
})
