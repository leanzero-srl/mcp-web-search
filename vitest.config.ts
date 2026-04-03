import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    include: ['tests/integration/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    timeout: 120000,
    hookTimeout: 60000,
    silent: false,
    reportFile: 'vitest-results.json',
  },
});