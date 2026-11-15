/**
 * `pnpm --filter @oat/db db:seed`: insert dev demo data into `DATABASE_URL` (default: compose). Run
 * `db:migrate` first. Refuses non-local databases unless `OAT_SEED_ALLOW_REMOTE=1`.
 */
import { createDb } from '../client.ts';
import { databaseUrl, isLocalDatabase, loadRootEnv, redactUrl } from '../env.ts';
import { seed } from '../seed.ts';

loadRootEnv();
const url = databaseUrl();
if (!isLocalDatabase(url) && process.env.OAT_SEED_ALLOW_REMOTE !== '1') {
  console.error(
    `db:seed: refusing to seed non-local database ${redactUrl(url)} (set OAT_SEED_ALLOW_REMOTE=1).`,
  );
  process.exit(1);
}

console.log(`db:seed → ${redactUrl(url)}`);
const db = createDb(url, { max: 1 });
try {
  const { inserted, segmentsSource } = await seed(db);
  const total = Object.values(inserted).reduce((a, b) => a + b, 0);
  console.log(
    `db:seed: inserted ${total} rows ${JSON.stringify(inserted)} (transcript: ${segmentsSource})`,
  );
} catch (err) {
  console.error('db:seed failed:', err);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
