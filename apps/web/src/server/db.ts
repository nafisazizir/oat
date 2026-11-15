import 'server-only';

import { createDb, type Db } from '@oat/db';

import { serverEnv } from '@/lib/env';

// One pool per server process. Kept on `globalThis` so `next dev` module reloads reuse it instead of
// leaking a new pool per edit.
const holder = globalThis as typeof globalThis & { __oatDb?: Db };

/** The app's Postgres client (`DATABASE_URL`), created on first use so `next build` needs no database. */
export function getDb(): Db {
  holder.__oatDb ??= createDb(serverEnv().DATABASE_URL);
  return holder.__oatDb;
}

/** Round-trips `select 1` through the pool. */
export async function pingDb(): Promise<void> {
  await getDb().$client`select 1`;
}
