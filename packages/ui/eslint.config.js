// @ts-check
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import root from '../../eslint.config.js';

// Root rules + React hooks rules and browser globals for components and the gallery.
export default defineConfig(root, {
  files: ['src/**/*.{ts,tsx}', 'gallery/**/*.{ts,tsx}'],
  extends: [reactHooks.configs.flat['recommended-latest']],
  languageOptions: { globals: { ...globals.browser } },
});
