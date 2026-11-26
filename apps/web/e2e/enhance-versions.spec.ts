import { mkdirSync, readFileSync } from 'node:fs';

import { createDb, meeting, transcriptSegment } from '@oat/db';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, unique } from './docs-helpers';
import { expect, test } from './fixtures';
import { databaseUrlFile, EVIDENCE_4_5, mocksUrlFile } from './paths';

/**
 * Tasks 4.5 + 4.6 in the browser: "About me" saved in settings reaches the enhance prompt (read back from the
 * mock LLM's request log); then enhance → edit → Regenerate (warns, D-20) → restore version 1 from Note
 * history → restore my original notes → still there after a reload.
 */

// Own user: the profile and meeting notes made here must not leak into other specs' shared user.
test.use({ storageState: SIGNED_OUT });

const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' });
const saved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
const port = (page: Page) => new URL(page.url()).port || '80';

/** Meetings and transcripts have no web API yet (desktop sync, 3.5): seed them in the e2e database. */
async function seedMeeting(page: Page, documentId: string) {
  const db = createDb(readFileSync(databaseUrlFile(port(page)), 'utf8').trim(), { max: 1 });
  try {
    const [m] = await db
      .insert(meeting)
      .values({
        documentId,
        startedAt: new Date('2026-11-12T10:00:00Z'),
        endedAt: new Date('2026-11-12T10:30:00Z'),
      })
      .returning();
    const lines = [
      ['system', 'We run eleven clinics and want to start small.'],
      ['mic', 'A pilot in two clinics makes sense, Lakeside and Mill Street.'],
      ['system', 'Our IT lead will need the security report first.'],
    ] as const;
    await db.insert(transcriptSegment).values(
      lines.map(([source, text], i) => ({
        id: `${documentId}-s${i}`,
        meetingId: m!.id,
        source,
        startMs: i * 6000,
        endMs: i * 6000 + 5000,
        text,
      })),
    );
  } finally {
    await db.$client.end();
  }
}

/** Bodies of the mock LLM's chat requests that contain `needle`. */
async function llmRequestsContaining(page: Page, needle: string): Promise<string[]> {
  const url = readFileSync(mocksUrlFile(port(page)), 'utf8').trim();
  const res = await fetch(`${url}/_requests?provider=llm&limit=500`);
  const { requests } = (await res.json()) as { requests: { path: string; body: string | null }[] };
  return requests
    .filter((r) => r.path.endsWith('/chat/completions') && r.body?.includes(needle))
    .map((r) => r.body!);
}

async function evidence(page: Page, name: string, fullPage = false) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_4_5, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${EVIDENCE_4_5}${name}.png`,
    fullPage,
    style: 'nextjs-portal { display: none !important; }',
  });
}

/** Waits for a run to start streaming and the editor to come back with its result. */
async function waitForRun(page: Page) {
  await expect(page.getByTestId('enhance-preview')).toBeVisible();
  await expect(editor(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('enhance-button')).toBeEnabled();
}

test('About me reaches the prompt; regenerate warns; restore v1; undo brings my notes back', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(150_000);
  const email = uniqueAddress('e2e-versions');
  await page.goto('/sign-in');
  await signInWithMagicLink(page, email, baseURL!);
  await expect(page).toHaveURL(/\/home$/);

  // --- About me (4.6) -------------------------------------------------------------------------------
  await page.goto('/settings');
  await page.getByTestId('settings-profile-link').click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  const marker = unique('Cares about clinic pilots').replace(' ', '-');
  await page.getByLabel('Name', { exact: true }).fill('Riley Versions');
  await page.getByLabel('Role', { exact: true }).fill('Account executive');
  await page.getByLabel('Team or company', { exact: true }).fill('Oat Sales');
  await page
    .getByLabel('What I care about', { exact: true })
    .fill(`${marker}. Security reviews come first.`);
  await page.getByLabel('Names and terms', { exact: true }).fill('Brightsmile\nDentaCore');
  await page.getByTestId('profile-save').click();
  await expect(page.getByText('Profile saved')).toBeVisible();
  await expect(page.getByTestId('profile-save')).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('What I care about', { exact: true })).toHaveValue(
    `${marker}. Security reviews come first.`,
  );
  await expect(page.getByLabel('Names and terms', { exact: true })).toHaveValue(
    'Brightsmile\nDentaCore',
  );
  await page.getByTestId('workspace-switcher').click();
  await expect(page.getByRole('menu')).toContainText('Riley Versions');
  await page.keyboard.press('Escape');
  await evidence(page, 'profile');

  // --- Enhance (v1) ----------------------------------------------------------------------------------
  const doc = await apiCreateDocument(page, { title: unique('Versions call'), kind: 'meeting' });
  await seedMeeting(page, doc.id);
  await page.goto(`/d/${doc.id}`);
  await editor(page).click();
  await page.keyboard.type('pilot in two clinics');
  await page.keyboard.press('Enter');
  await page.keyboard.type('send security report');
  await expect(page.getByTestId('enhance-button')).toHaveText(/Enhance/);
  await page.getByTestId('enhance-button').click();
  await waitForRun(page);
  await expect(page.getByText('Notes enhanced')).toBeVisible();

  // The profile went into the prompt, fenced as data (the mock echoes prompts; its log has the request).
  const prompts = await llmRequestsContaining(page, marker);
  expect(prompts.length).toBeGreaterThan(0);
  expect(prompts[0]).toContain('<oat:about_me>');
  expect(prompts[0]).toContain('Role: Account executive');
  expect(prompts[0]).toContain('Correct spellings of names and terms: Brightsmile, DentaCore');
  expect(prompts[0]).toContain('Riley Versions');

  await expect(page.getByTestId('enhance-button')).toHaveText(/Enhanced/);
  await page.getByTestId('document-more').click();
  await expect(page.getByTestId('history-button')).toBeVisible();
  await page.keyboard.press('Escape');
  const v1Ai = await editor(page).locator('[data-origin="ai"]').count();
  expect(v1Ai).toBeGreaterThan(0);

  // --- Edit, then Regenerate: warned first (D-20) ------------------------------------------------------
  await editor(page)
    .locator('p[data-origin="me"]')
    .filter({ hasText: 'pilot in two clinics' })
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (edited)');
  await saved(page);
  await expect(page.getByTestId('meeting-header').getByTestId('enhance-button')).toBeVisible();
  await page.getByTestId('enhance-button').click();
  const menu = page.getByRole('menu');
  await expect(menu).toHaveAttribute('data-size', 'sm');
  const currentTemplate = menu.getByTestId('enhance-current-template');
  const regenerate = menu.getByRole('menuitem', { name: 'Regenerate', exact: true });
  await expect(regenerate).toHaveJSProperty('tagName', 'BUTTON');
  await expect(regenerate).toBeEmpty();
  await expect(menu.getByTestId('enhance-template').first()).toBeVisible();
  await currentTemplate.click();
  await expect(regenerate).toBeVisible();
  await expect(page.getByTestId('replace-confirm')).toHaveCount(0);
  await page.getByTestId('enhance-regenerate').click();
  const confirm = page.getByTestId('replace-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Regenerate over your edits?');
  await evidence(page, 'regenerate-warning');
  // Cancel keeps everything as it is.
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(editor(page)).toContainText('(edited)');
  // Regenerate for real, with another template from the menu.
  await page.getByTestId('enhance-button').click();
  await page.getByTestId('enhance-template').filter({ hasText: 'Sales discovery' }).click();
  await expect(confirm).toBeVisible();
  await page.getByTestId('replace-confirm-action').click();
  await waitForRun(page);
  // My edited line is one of my lines, so it carries over.
  await expect(editor(page)).toContainText('pilot in two clinics (edited)');

  // --- Note history: two versions; restore version 1 ------------------------------------------------
  await page.getByTestId('document-more').click();
  await page.getByTestId('history-button').click();
  const versions = page.getByTestId('history-version');
  await expect(versions).toHaveCount(2);
  await expect(versions.nth(0)).toContainText('Version 2');
  await expect(versions.nth(0)).toContainText('Sales discovery');
  await expect(versions.nth(0)).toContainText('Current');
  await expect(versions.nth(1)).toContainText('Version 1');
  await expect(versions.nth(1)).toContainText('General');
  await versions.nth(1).click();
  const preview = page.getByTestId('history-preview');
  await expect(preview.getByRole('textbox', { name: 'Version preview' })).toBeVisible();
  await expect(preview).not.toContainText('(edited)');
  await evidence(page, 'history');
  await page.getByTestId('history-restore').click();
  // The body is exactly version 2's output (no edits since): no warning.
  const activeToasts = page.locator(
    '[data-sonner-toast][data-mounted="true"][data-removed="false"]',
  );
  await expect(activeToasts.getByText('Version 1 restored')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Note history' })).toHaveCount(0);
  await expect(editor(page)).not.toContainText('(edited)');
  await expect(editor(page).locator('[data-origin="ai"]').first()).toBeVisible();

  // --- My original notes (Note history), then restore them -------------------------------------------
  await page.getByTestId('document-more').click();
  await page.getByTestId('history-button').click();
  await page.getByTestId('history-original').click();
  const original = page.getByTestId('history-preview');
  await expect(original).toContainText('pilot in two clinics (edited)');
  await expect(original.locator('[data-origin="ai"]')).toHaveCount(0);
  await evidence(page, 'original-notes');

  await page.getByTestId('history-restore').click();
  await expect(activeToasts.getByText('Your original notes are back')).toBeVisible();
  await expect(editor(page).locator('[data-origin="ai"]')).toHaveCount(0);
  await expect(editor(page)).toContainText('pilot in two clinics (edited)');
  await expect(editor(page)).toContainText('send security report');
  await evidence(page, 'undone', true);

  // Stored, and still editable on top (autosave continues from the restored version).
  await page.reload();
  await expect(editor(page).locator('[data-origin="ai"]')).toHaveCount(0);
  await editor(page).getByText('send security report').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' today');
  await saved(page);
  let releaseVersions!: () => void;
  const versionsReady = new Promise<void>((resolve) => {
    releaseVersions = resolve;
  });
  const versionsPath = `**/api/documents/${doc.id}/enhancements`;
  await page.route(versionsPath, async (route) => {
    await versionsReady;
    await route.continue();
  });
  await page.reload();
  await expect(editor(page)).toContainText('send security report today');

  // --- Never lose text: the edited note the regenerate replaced is in Note history ----------------
  // ("send … today" was typed after the undo, so it is not stored anywhere: restoring warns and saves it.)
  await page.getByTestId('document-more').click();
  await expect(page.getByTestId('notion-send')).toBeVisible();
  await expect(page.getByTestId('history-button')).toHaveCount(0);
  releaseVersions();
  await expect(page.getByTestId('history-button')).toBeVisible();
  await page.unroute(versionsPath);
  await page.getByTestId('history-button').click();
  const savedNotes = page.getByTestId('history-snapshot');
  await expect(savedNotes).toHaveCount(1);
  await expect(savedNotes.first()).toContainText('Your edited note');
  await expect(savedNotes.first()).toContainText('Saved before regenerating');
  await savedNotes.first().click();
  await expect(page.getByTestId('history-preview')).toContainText('pilot in two clinics (edited)');
  await expect(
    page.getByTestId('history-preview').locator('[data-origin="ai"]').first(),
  ).toBeVisible();
  await evidence(page, 'history-saved-note');
  await page.getByTestId('history-restore').click();
  await expect(confirm).toContainText('Replace your edited note?');
  await page.getByTestId('replace-confirm-action').click();
  await expect(activeToasts.getByText('Your edited note is back')).toBeVisible();
  await expect(editor(page)).toContainText('pilot in two clinics (edited)');
  await expect(editor(page).locator('[data-origin="ai"]').first()).toBeVisible();
  // …and what it replaced was saved too.
  await page.getByTestId('document-more').click();
  await page.getByTestId('history-button').click();
  await expect(page.getByTestId('history-snapshot')).toHaveCount(2);
  await expect(page.getByTestId('history-snapshot').first()).toContainText(
    'Saved before restoring',
  );
});
