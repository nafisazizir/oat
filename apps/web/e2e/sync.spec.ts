import { mkdirSync, readFileSync } from 'node:fs';

import { createDb, document as documentTable, newId } from '@oat/db';
import { ensureBlockIds } from '@oat/editor';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, apiUpdateDocument, unique } from './docs-helpers';
import { expect, sidebarSelector, test } from './fixtures';
import { databaseUrlFile, EVIDENCE_3_5 } from './paths';

/**
 * Task 3.5 in the browser: a conflicted copy (as a desktop's sync push creates it) shows its banner, the
 * compare dialog and "Keep this copy"; the sidebar updates live (SSE) when the note is renamed elsewhere.
 * The copy is written straight into the e2e server's throwaway database (desktop pushes use a bearer).
 */

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_3_5, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_3_5}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

test.use({ viewport: { width: 1280, height: 800 }, storageState: SIGNED_OUT });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-sync'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

test('conflicted copy: banner, side-by-side compare, keep this copy', async ({ page }) => {
  const title = unique('Roadmap');
  const original = await apiCreateDocument(page, { title });
  const saved = await apiUpdateDocument(page, original.id, {
    baseVersion: original.version,
    contentJson: paragraph('Ship the beta in March.'),
  });
  expect(saved.status()).toBe(200);
  const copyId = newId();
  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  try {
    await db.insert(documentTable).values({
      id: copyId,
      workspaceId: original.workspaceId,
      ownerId: original.ownerId,
      kind: 'page',
      title: `${title} (conflicted copy)`,
      // As a sync push stores it (block ids assigned), so the editor has nothing to re-save.
      contentJson: ensureBlockIds(paragraph('Ship the beta in April.')),
      visibility: 'private',
      conflictOfId: original.id,
      conflictDevice: 'Studio Mac',
      conflictAt: new Date(),
    });
  } finally {
    await db.$client.end();
  }

  await page.goto(`/d/${copyId}`);
  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toContainText('Conflicted copy from Studio Mac');
  await evidence(page, 'web-conflict-banner');
  await banner.getByRole('button', { name: 'Compare' }).click();
  const dialog = page.getByTestId('conflict-compare');
  await expect(dialog.getByTestId('compare-original')).toContainText('Ship the beta in March.');
  await expect(dialog.getByTestId('compare-copy')).toContainText('Ship the beta in April.');
  await evidence(page, 'web-conflict-compare');
  await dialog.getByRole('button', { name: 'Keep this copy' }).click();

  await expect(page).toHaveURL(new RegExp(`/d/${original.id}$`));
  await expect(page.getByText('Ship the beta in April.')).toBeVisible();
  await expect(page.getByTestId('conflict-banner')).toHaveCount(0);
  // The copy went to the trash: it is no longer a conflict.
  const resolved = await page.request.get(`/api/sync/conflicts/${copyId}`, { maxRetries: 1 });
  expect(resolved.status()).toBe(404);
});

test('the sidebar updates live when the note is renamed elsewhere', async ({ page }) => {
  const doc = await apiCreateDocument(page, { title: unique('Before') });
  await page.goto('/home');
  const sidebar = page.locator(sidebarSelector);
  await expect(sidebar.getByText(doc.title)).toBeVisible();
  // The live channel is connected (a change made before it connects isn't replayed to a fresh page).
  await expect(page.locator('html[data-sync-live]')).toHaveCount(1);
  const renamed = unique('Renamed elsewhere');
  // Another tab/device: the request doesn't go through this page's editor, so this tab didn't save it.
  const res = await apiUpdateDocument(page, doc.id, { baseVersion: doc.version, title: renamed });
  expect(res.status()).toBe(200);
  await expect(sidebar.getByText(renamed)).toBeVisible({ timeout: 15_000 });
});
