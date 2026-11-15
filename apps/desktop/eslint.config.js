// @ts-check
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import root from '../../eslint.config.js';

// Root rules; React hooks + browser globals in the renderer; Node globals in main, preload and tests.
export default defineConfig(
  root,
  { ignores: ['out/**', 'playwright-report/**', 'test-results/**'] },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/build/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
);
