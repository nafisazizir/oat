import { defineOatConfig } from '../../vitest.shared.ts';

export default defineOatConfig({
  coverage: {
    provider: 'v8',
    // Authorization logic must stay fully covered (task 1.7, FACTORY §3). `pnpm test` runs with coverage
    // in this package, so the threshold is enforced on every run.
    include: ['src/permissions.ts'],
    reporter: ['text'],
    thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
});
