import { fileURLToPath } from 'node:url';

import { mergeConfig, type ViteUserConfigFnObject } from 'vitest/config';

import { defineOatConfig } from '../vitest.shared.ts';

const base = defineOatConfig() as ViteUserConfigFnObject;
const web = (path: string) => fileURLToPath(new URL(`../apps/web/${path}`, import.meta.url));

export default ((env) =>
  mergeConfig(base(env), {
    resolve: {
      alias: {
        // The spike's web seam (src/post-meeting/web.ts) imports apps/web server modules (see tsconfig.json).
        '@/': web('src/'),
        'server-only': web('node_modules/server-only/empty.js'),
      },
    },
    // The int test builds and boots the eve server (~10–20 s) before its first case.
    test: env.mode === 'int' ? { hookTimeout: 180_000, testTimeout: 90_000 } : {},
  })) satisfies ViteUserConfigFnObject;
