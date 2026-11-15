/**
 * `pnpm --filter @oat/agents agent:build`: `eve build` without leaving the machine (D-11).
 *
 * - `EVE_TELEMETRY_DISABLED=1`: eve's CLI sends usage telemetry to Vercel by default.
 * - An empty, fresh AI Gateway model catalog in `.eve/cache/model-catalog.json`: `eve build` otherwise GETs
 *   `https://ai-gateway.vercel.sh/v1/models/catalog` (to learn context windows) unless that cache is under 5 min
 *   old. Our agent sets `modelContextWindowTokens` on its model selection, so the catalog isn't needed; offline
 *   the fetch would only fail into a build warning, online it is a call to an external service.
 * - `--skip-sandbox-prewarm`: the agent has no sandbox tools (`defaultTools: false`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS_DIR = fileURLToPath(new URL('../..', import.meta.url));
const EVE_BIN = join(AGENTS_DIR, 'node_modules', '.bin', 'eve');

/** Writes the empty catalog eve treats as fresh for 5 minutes (shape of eve 1.0.0-rc.18's cache, v2). */
export function seedEmptyModelCatalog(appDir: string = AGENTS_DIR): void {
  const dir = join(appDir, '.eve', 'cache');
  mkdirSync(dir, { recursive: true });
  const cache = {
    fetchedAt: new Date().toISOString(),
    kind: 'eve-model-catalog-cache',
    models: [],
    providerAliases: {},
    version: 2,
  };
  writeFileSync(join(dir, 'model-catalog.json'), `${JSON.stringify(cache, null, 2)}\n`);
}

export function buildAgent(options: { quiet?: boolean } = {}): void {
  seedEmptyModelCatalog();
  const result = spawnSync(EVE_BIN, ['build', '--skip-sandbox-prewarm'], {
    cwd: AGENTS_DIR,
    env: { ...process.env, EVE_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(
      `eve build failed (${result.status}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) buildAgent();
