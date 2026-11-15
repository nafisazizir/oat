import { mergeConfig, type ViteUserConfigFnObject } from 'vitest/config';

import { defineOatConfig } from '../vitest.shared.ts';

const base = defineOatConfig() as ViteUserConfigFnObject;

export default ((env) =>
  mergeConfig(base(env), {
    // The int test builds and boots the eve server (~10–20 s) before its first case.
    test: env.mode === 'int' ? { hookTimeout: 180_000, testTimeout: 90_000 } : {},
  })) satisfies ViteUserConfigFnObject;
