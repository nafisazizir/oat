/**
 * Playwright's web server: a throwaway, migrated Postgres database (`@oat/testkit`) + `next dev` on
 * `E2E_PORT`, pointed at it. Sign-ups made by e2e tests never touch the shared `oat` dev database, and
 * parallel worktrees never see each other's users. The database is dropped when Playwright stops the
 * server (SIGTERM, see `gracefulShutdown` in playwright.config.ts); a hard kill leaks it until the next
 * test run sweeps `oat_test_*` databases older than an hour.
 *
 * It also runs an in-process mocks server with the Google Calendar provider (this checkout's code, not the
 * shared container, which may predate it) and points `GOOGLE_CALENDAR_BASE_URL` at it. Its `next-week`
 * anchor keeps the fixture week upcoming whenever the tests run. The same server runs the Notion provider
 * (8.1) for `NOTION_BASE_URL`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { migrate } from '@oat/db';
import { gcalProvider, notionProvider, startMocks } from '@oat/mocks';
import { createTestDatabase } from '@oat/testkit';

import { databaseUrlFile } from './paths';

const port = process.env.E2E_PORT ?? '3000';
// A `.next/dev` left by an earlier `next dev` whose sources changed since (formatting, edits) sometimes
// made the new dev server rebuild and full-reload every page in a loop (1.4/1.6/3.3 notes); always
// start e2e from a clean dev cache.
rmSync(new URL('../.next/dev', import.meta.url), { recursive: true, force: true });
const db = await createTestDatabase();
await migrate(db.url);
const mocks = await startMocks({
  providers: [() => gcalProvider({ anchor: 'next-week' }), () => notionProvider()],
});
// Specs that need rows the API can't create yet (e.g. transcript segments) write them here directly.
mkdirSync(new URL('./.auth/', import.meta.url), { recursive: true });
writeFileSync(databaseUrlFile(port), db.url);
console.log(`[e2e] database ${db.name} ready; starting next dev on :${port}`);

const child = spawn('pnpm', ['exec', 'next', 'dev', '--port', port], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATABASE_URL: db.url,
    BETTER_AUTH_URL: `http://localhost:${port}`,
    GOOGLE_CALENDAR_BASE_URL: `${mocks.url}/gcal`,
    NOTION_BASE_URL: `${mocks.url}/notion`,
    NOTION_OAUTH_CLIENT_ID: '',
    NOTION_OAUTH_CLIENT_SECRET: '',
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
  await mocks.close().catch(() => undefined);
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
