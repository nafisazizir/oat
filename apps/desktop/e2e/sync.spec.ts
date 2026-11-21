/**
 * Task 3.5 e2e: the built app against `next dev` on the throwaway database.
 * - An edit made on the web reaches the desktop within seconds through the SSE invalidation channel (the
 *   pull backstop is 60 s, so seconds means SSE), and the local FTS search box finds it.
 * - A conflicted copy that arrives by sync is listed in the sidebar; the compare dialog resolves it
 *   ("Keep other version"), which syncs as a delete: the server moves the copy to the trash.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { databaseUrlFile } from '../../web/e2e/paths';
import {
  evidence,
  launchApp,
  scaled,
  signInDesktop,
  signInOnWeb,
  syncStatus,
  writeEvidence,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;
let sql: postgres.Sql;

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-sync-'));
  sql = postgres(readFileSync(databaseUrlFile(new URL(webUrl).port), 'utf8').trim(), {
    max: 1,
    onnotice: () => {},
  });
  // `next dev` compiles a route on its first request: do it before anything is timed.
  await fetch(`${webUrl}/api/sync/events`);
  await fetch(`${webUrl}/api/sync/backfill?document=x`);
});

test.afterAll(async () => {
  await app?.close();
  await sql?.end();
  rmSync(userDataDir, { recursive: true, force: true });
});

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

test('edit on the web → the desktop has it within seconds (SSE) and finds it locally', async ({
  browser,
}) => {
  test.setTimeout(scaled(150_000));
  ({ app, page } = await launchApp(userDataDir, webUrl));
  const email = uniqueAddress('desktop-sync');
  await signInDesktop(app, page, browser, email);
  await expect(syncStatus(page)).toHaveAccessibleName('All changes synced', {
    timeout: scaled(30_000),
  });

  // The same user on the web (another browser), creating and editing a note there.
  const context = await browser.newContext();
  const web = await context.newPage();
  await web.goto(`${webUrl}/sign-in`);
  await signInOnWeb(web, email);
  await expect(web).toHaveURL(/\/home$/);
  const workspaceId = await web.getByTestId('app-sidebar').getAttribute('data-workspace-id');
  const origin = { origin: webUrl };
  const created = await web.request.post(`${webUrl}/api/documents`, {
    data: { workspaceId, title: 'Launch checklist' },
    headers: origin,
  });
  expect(created.status()).toBe(201);
  const doc = (await created.json()) as { id: string; version: number };
  // Let the desktop settle on the creation first (its own SSE-triggered pull).
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByLabel('Search notes and transcripts on this Mac');
  await search.fill('checklist');
  await expect(page.getByTestId('local-search-results')).toContainText('Launch checklist', {
    timeout: scaled(15_000),
  });

  const word = `zebra${Math.random().toString(36).slice(2, 7)}`;
  const started = Date.now();
  const edited = await web.request.patch(`${webUrl}/api/documents/${doc.id}`, {
    data: { baseVersion: doc.version, contentJson: paragraph(`Book the ${word} venue`) },
    headers: origin,
  });
  expect(edited.status()).toBe(200);
  await search.fill(word);
  await expect(page.getByTestId('local-search-results')).toContainText('Launch checklist', {
    timeout: scaled(15_000),
  });
  const latencyMs = Date.now() - started;
  // Well under the 60 s pull backstop: the SSE channel carried it.
  expect(latencyMs).toBeLessThan(scaled(15_000));
  await expect(page.getByTestId('search-snippet').first()).toContainText(word);
  writeEvidence('sse-latency.json', { latencyMs, measuredAt: new Date().toISOString() }, '3.5');
  await evidence(page, 'desktop-search', '3.5');
  await page.keyboard.press('Escape');

  // A conflicted copy of the note (as another device's push would create it) arrives by sync…
  const [user] = await sql<{ id: string }[]>`select id from "user" where email = ${email}`;
  const copyId = `copy-${Date.now().toString(36)}`;
  await sql`insert into document (id, workspace_id, owner_id, kind, title, content_json, visibility,
              conflict_of_id, conflict_device, conflict_at)
            values (${copyId}, ${workspaceId}, ${user!.id}, 'page', 'Launch checklist (conflicted copy)',
              ${sql.json(paragraph('Book the old venue'))}, 'private', ${doc.id}, 'Studio Mac', now())`;
  const panel = page.getByTestId('conflicts');
  await expect(panel).toContainText('Conflicted copy from Studio Mac', { timeout: scaled(15_000) });
  await panel.getByRole('button').first().click();
  const dialog = page.getByTestId('conflict-compare');
  await expect(dialog.getByTestId('compare-original')).toContainText(word);
  await expect(dialog.getByTestId('compare-copy')).toContainText('Book the old venue');
  await evidence(page, 'desktop-conflict-compare', '3.5');
  // …and "Keep other version" deletes it here, which the server turns into the trash.
  await dialog.getByRole('button', { name: 'Keep other version' }).click();
  await expect(panel).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await sql<{ trashed: boolean }[]>`
          select deleted_at is not null as trashed from document where id = ${copyId}`
        )[0]?.trashed,
      { timeout: scaled(15_000) },
    )
    .toBe(true);
  await context.close();
});
