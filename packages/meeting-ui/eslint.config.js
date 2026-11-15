// @ts-check
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import root from '../../eslint.config.js';

// Root rules + React hooks rules and browser globals.
export default defineConfig(root, {
  files: ['src/**/*.{ts,tsx}'],
  extends: [reactHooks.configs.flat['recommended-latest']],
  languageOptions: { globals: { ...globals.browser } },
});
