// @ts-check
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

import root from '../../eslint.config.js';

// Root rules + Next.js (core web vitals) + React hooks. `eslint-config-next` is not used: it pulls in
// eslint-plugin-react/import, which lag behind ESLint 10.
export default defineConfig(
  root,
  { ignores: ['next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    plugins: { '@next/next': nextPlugin },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: ['e2e/**/*.ts', '*.config.{ts,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
);
