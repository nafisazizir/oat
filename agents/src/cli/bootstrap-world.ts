/**
 * `pnpm --filter @oat/agents world:bootstrap`: creates the Workflow world's database on the compose Postgres if
 * it doesn't exist (`WORKFLOW_POSTGRES_URL`, default `oat_workflow`) and applies `@workflow/world-postgres`'s
 * schema (workflow tables + Graphile Worker). Idempotent; run it again after upgrading that package.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import postgres from 'postgres';

import { agentsConfig } from '../env.ts';

export async function ensureDatabase(url: string): Promise<boolean> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected database name "${name}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql`select 1 as ok from pg_database where datname = ${name}`;
    if (row) return false;
    await sql.unsafe(`create database "${name}"`);
    return true;
  } finally {
    await sql.end();
  }
}

/** Runs the package's own `bootstrap` (migrations + Graphile Worker schema) against `url`. */
export function bootstrapWorld(url: string, options: { quiet?: boolean } = {}): void {
  // `package.json` isn't in the package's exports: resolve its entry and walk up to the package root.
  let dir = dirname(createRequire(import.meta.url).resolve('@workflow/world-postgres'));
  while (!existsSync(join(dir, 'package.json')) || !existsSync(join(dir, 'bin'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error('@workflow/world-postgres package root not found');
    dir = up;
  }
  const { bin } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    bin: Record<string, string>;
  };
  if (!bin.bootstrap) throw new Error('@workflow/world-postgres has no bootstrap bin');
  const result = spawnSync(process.execPath, [join(dir, bin.bootstrap)], {
    env: { ...process.env, WORKFLOW_POSTGRES_URL: url },
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `world bootstrap exited with ${result.status}${options.quiet ? `:\n${result.stdout}${result.stderr}` : ''}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = agentsConfig().workflowDatabaseUrl;
  const created = await ensureDatabase(url);
  console.log(created ? 'created the workflow database' : 'workflow database exists');
  bootstrapWorld(url);
}
