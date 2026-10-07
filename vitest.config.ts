import { configDefaults, defineConfig } from 'vitest/config';

// Unit and property tests. Integration tests (*.int.test.ts, need Docker) run with `npm run test:integration`.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.int.test.ts'],
    // `npm run test:coverage`: CI gate of plan §16.5 (domain lines and branches >= 90 %).
    coverage: { provider: 'v8', include: ['packages/domain/src/**'], thresholds: { lines: 90, branches: 90 } },
  },
});
