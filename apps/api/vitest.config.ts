import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test/global-setup.ts'],
    // Test files share one database, one Redis DB and one local chain, so they run one after another.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
    include: ['src/**/*.test.ts'],
  },
});
