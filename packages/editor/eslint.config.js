// @ts-check
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import root from '../../eslint.config.js';

// Root rules + React hooks rules and browser globals for the editor and its playground.
export default defineConfig(root, {
  files: ['src/**/*.{ts,tsx}', 'playground/**/*.{ts,tsx}', 'e2e/**/*.ts'],
  extends: [reactHooks.configs.flat['recommended-latest']],
  languageOptions: { globals: { ...globals.browser } },
});
