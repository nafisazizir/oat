/**
 * `pnpm --filter @oat/db db:reset [--seed]`: drop and recreate the dev database named in `DATABASE_URL`
 * (default: compose `oat`), then apply all migrations (and seed with `--seed`). For when migrations were
 * rewritten before release. Refuses anything but a loopback host — there is no override.
 * Terminates open connections to that database (DROP ... WITH (FORCE)).
 */
import postgres from 'postgres';
import { createDb, migrate } from '../client.ts';
import { databaseUrl, isLocalDatabase, loadRootEnv, redactUrl } from '../env.ts';
import { seed } from '../seed.ts';

loadRootEnv();
const url = databaseUrl();
const target = new URL(url);
const name = decodeURIComponent(target.pathname.slice(1));

if (!isLocalDatabase(url)) {
  console.error(`db:reset: refusing to reset non-local database ${redactUrl(url)}.`);
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]*$/.test(name) || name === 'postgres' || name.startsWith('template')) {
  console.error(`db:reset: refusing to reset database "${name}".`);
  process.exit(1);
}

const admin = new URL(process.env.OAT_DATABASE_ADMIN_URL?.trim() || url);
if (!process.env.OAT_DATABASE_ADMIN_URL?.trim()) admin.pathname = '/postgres';
if (!isLocalDatabase(admin.toString())) {
  console.error(`db:reset: admin URL ${redactUrl(admin.toString())} is not local.`);
  process.exit(1);
}

console.log(`db:reset → dropping and recreating ${redactUrl(url)}`);
const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
try {
  await sql.unsafe(`drop database if exists "${name}" with (force)`);
  // template1 carries vector + pg_trgm in the compose image; migration 0000 creates them anyway.
  await sql.unsafe(`create database "${name}"`);
} finally {
  await sql.end();
}

await migrate(url);
console.log('db:reset: migrated');

if (process.argv.includes('--seed')) {
  const db = createDb(url, { max: 1 });
  try {
    const { inserted } = await seed(db);
    console.log(`db:reset: seeded ${JSON.stringify(inserted)}`);
  } finally {
    await db.$client.end();
  }
}
