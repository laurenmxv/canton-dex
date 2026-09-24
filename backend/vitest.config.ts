import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', './test/support/require-executed-tests.ts'],
    projects: [
      { test: { name: 'unit', include: ['test/unit/**/*.test.ts'] } },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          // The scenarios share one live stack, so they run one file at a time.
          poolOptions: { forks: { singleFork: true } },
          // Ledger workflows poll for up to 90 s per step.
          testTimeout: 600_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
