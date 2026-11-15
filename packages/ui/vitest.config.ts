import { defineOatConfig } from '../../vitest.shared.ts';

// Components render in jsdom; `src/test-setup.ts` adds the browser APIs Radix expects.
export default defineOatConfig({
  environment: 'jsdom',
  setupFiles: ['./src/test-setup.ts'],
});
