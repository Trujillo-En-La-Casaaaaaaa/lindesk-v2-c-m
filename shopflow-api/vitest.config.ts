import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Integration and contract suites share one real PostgreSQL instance, so test
    // files run one at a time to keep truncation/seeding isolated between files.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: 'default',
  },
});
