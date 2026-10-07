import { configDefaults, defineConfig } from 'vitest/config';

// Unit and property tests. Integration tests (*.int.test.ts, need Docker) run with `npm run test:integration`.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.int.test.ts'] },
});
