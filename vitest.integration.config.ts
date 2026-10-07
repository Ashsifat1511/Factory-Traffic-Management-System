import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['**/*.int.test.ts'], exclude: ['**/node_modules/**'], testTimeout: 30_000, hookTimeout: 120_000, fileParallelism: false, env: { LOG_LEVEL: 'silent' } },
});
