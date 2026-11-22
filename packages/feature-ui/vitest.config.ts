import { defineOatConfig } from '../../vitest.shared.ts';

// Pure helpers run in Node; component tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
export default defineOatConfig({
  setupFiles: ['./src/test-setup.ts'],
});
