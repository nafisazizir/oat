import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

import manifest from './package.json' with { type: 'json' };
import { workspacePackages } from './src/lib/workspace-packages';

/** Walks up from the cwd to the monorepo root (the folder with `pnpm-workspace.yaml`). */
function findRepoRoot(from = process.cwd()): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Loads the repo-root `.env` (DEV.md: Next.js on its own only reads `apps/web/.env*`). Variables already
 * set in the shell win: `process.loadEnvFile` never overrides. In `next dev` only, a missing `.env` falls
 * back to `.env.example`, whose defaults point at the local compose stack (D-11), so a fresh checkout boots.
 */
function loadRootEnv(phase: string) {
  const root = findRepoRoot();
  if (!root) return;
  const env = join(root, '.env');
  const example = join(root, '.env.example');
  if (existsSync(env)) process.loadEnvFile(env);
  else if (phase === PHASE_DEVELOPMENT_SERVER && existsSync(example)) process.loadEnvFile(example);
}

export default function config(phase: string): NextConfig {
  loadRootEnv(phase);
  return {
    reactStrictMode: true,
    typedRoutes: true,
    // D-15: every @oat/* dependency is TypeScript source; Next compiles them (derived from package.json).
    transpilePackages: workspacePackages(manifest),
    // The dev indicator would sit on top of the sidebar footer; errors still open the overlay.
    devIndicators: { position: 'bottom-right' },
  };
}
