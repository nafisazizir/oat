/** `pnpm --filter @oat/db db:migrate`: apply pending migrations to `DATABASE_URL` (default: compose). */
import { migrate } from '../client.ts';
import { databaseUrl, loadRootEnv, redactUrl } from '../env.ts';

loadRootEnv();
const url = databaseUrl();
console.log(`db:migrate → ${redactUrl(url)}`);
try {
  await migrate(url);
  console.log('db:migrate: up to date');
} catch (err) {
  console.error('db:migrate failed:', err);
  process.exitCode = 1;
}
