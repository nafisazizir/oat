// @ts-check
import { defineConfig } from 'eslint/config';
import globals from 'globals';

import root from '../../eslint.config.js';

// Root rules, Node globals. The acceptance journey sits on top of every app and reuses their e2e helpers
// (apps/desktop/e2e, apps/web/e2e): test code importing test code, so the D-29 layering rule (no imports
// from `apps/`, meant for packages and agents) is off here.
export default defineConfig(
  root,
  { ignores: ['playwright-report/**', 'test-results/**'] },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: { 'no-restricted-imports': 'off' },
  },
);
