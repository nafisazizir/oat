// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Non-type-aware rules only, so `pnpm lint` stays fast. `pnpm typecheck` covers type errors.
export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/.next/**',
      '**/.next-*/**',
      '**/.turbo/**',
      '**/coverage/**',
      'research/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Layering (D-29, 8.3): apps sit on top. Packages, tools and the background agents (`agents/`) never import
      // app code (relative paths into `apps/`, or the apps' package names); shared server logic lives in
      // `@oat/services`. Every package config extends this file, so the rule applies everywhere.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|/)apps/',
              message: 'Do not import app code (D-29 layering): move shared logic into a package.',
            },
            {
              group: ['@oat/web', '@oat/web/*', '@oat/desktop', '@oat/desktop/*'],
              message: 'Do not import app code (D-29 layering): move shared logic into a package.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.config.{js,ts,mjs,cjs}',
      '*.{js,ts,mjs,cjs}',
      'scripts/**/*.{js,ts,mjs,cjs}',
      'docker/**/*.{js,mjs}',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
);
