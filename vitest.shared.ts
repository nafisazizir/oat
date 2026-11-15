import { configDefaults, defineConfig, type ViteUserConfig } from 'vitest/config';

/**
 * Shared Vitest config for every workspace package (used from each package's `vitest.config.ts`).
 *
 * - `vitest run`            unit tests: `src/**` `*.test.{ts,tsx}`, excluding `*.int.test.*`. No services.
 * - `vitest run --mode int` integration tests: `*.int.test.{ts,tsx}` only. May need `pnpm dev:up`.
 */
export function defineOatConfig(overrides: ViteUserConfig['test'] = {}) {
  return defineConfig(({ mode }) => {
    const integration = mode === 'int';
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
