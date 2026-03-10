import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/helpers/setup.ts'],
    testTimeout: 10_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
