import { fileURLToPath } from 'node:url';

import { mergeConfig, type ViteUserConfigFnObject } from 'vitest/config';

import { defineOatConfig } from '../../vitest.shared.ts';

// Unit tests for app logic (env, navigation, theme, loaders). Browser flows are Playwright (`pnpm e2e`).
const base = defineOatConfig() as ViteUserConfigFnObject;
const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default ((env) =>
  mergeConfig(base(env), {
    resolve: {
      alias: {
        '@/': local('./src/'),
        // Tests run server modules directly; resolve `server-only` the way React Server Components do.
        'server-only': local('./node_modules/server-only/empty.js'),
      },
    },
  })) satisfies ViteUserConfigFnObject;
