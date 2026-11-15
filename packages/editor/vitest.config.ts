import { defineOatConfig } from '../../vitest.shared.ts';

// Schema tests run in Node (proves the headless path). Component tests opt into jsdom with a
// `// @vitest-environment jsdom` docblock; `src/test-setup.ts` adds the browser APIs they need.
export default defineOatConfig({
  setupFiles: ['./src/test-setup.ts'],
});
