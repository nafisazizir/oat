import { existsSync } from 'node:fs';
import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

/** Repo-root `.env` (created by `pnpm dev:up` from `.env.example`). */
const ROOT_ENV = new URL('./.env', import.meta.url);

/**
 * Shared Vitest config for every workspace package (used from each package's `vitest.config.ts`).
 *
 * - `vitest run`            unit tests: `src/**` `*.test.{ts,tsx}`, excluding `*.int.test.*`. No services.
 * - `vitest run --mode int` integration tests: `*.int.test.{ts,tsx}` only. May need `pnpm dev:up`.
 *   Loads the root `.env` first if it exists; variables already set in the shell win over the file.
 */
export function defineOatConfig(overrides: ViteUserConfig['test'] = {}) {
  return defineConfig(({ mode }) => {
    const integration = mode === 'int';
    // process.loadEnvFile never overrides variables that are already set. Workers inherit process.env.
    if (integration && existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
    return {
      test: {
        include: integration ? ['src/**/*.int.test.{ts,tsx}'] : ['src/**/*.test.{ts,tsx}'],
        exclude: integration
          ? [...configDefaults.exclude]
          : [...configDefaults.exclude, 'src/**/*.int.test.{ts,tsx}'],
        ...overrides,
      },
    };
  });
}
