/**
 * Playwright's web server: a throwaway, migrated Postgres database (`@oat/testkit`) + `next dev` on
 * `E2E_PORT`, pointed at it. Sign-ups made by e2e tests never touch the shared `oat` dev database, and
 * parallel worktrees never see each other's users. The database is dropped when Playwright stops the
 * server (SIGTERM, see `gracefulShutdown` in playwright.config.ts); a hard kill leaks it until the next
 * test run sweeps `oat_test_*` databases older than an hour.
 */
import { spawn } from 'node:child_process';

import { migrate } from '@oat/db';
import { createTestDatabase } from '@oat/testkit';

const port = process.env.E2E_PORT ?? '3000';
const db = await createTestDatabase();
await migrate(db.url);
console.log(`[e2e] database ${db.name} ready; starting next dev on :${port}`);

const child = spawn('pnpm', ['exec', 'next', 'dev', '--port', port], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: db.url,
    BETTER_AUTH_URL: `http://localhost:${port}`,
  },
});

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  try {
    await db.drop();
  } catch (error) {
    console.error(`[e2e] could not drop ${db.name}:`, error);
  }
  process.exit(code);
}

process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
child.on('exit', (code) => void shutdown(code ?? 1));
