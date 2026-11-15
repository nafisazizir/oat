import { mkdirSync, readFileSync } from 'node:fs';

import { createDb, meeting, participant, transcriptSegment } from '@oat/db';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, unique } from './docs-helpers';
import { expect, test } from './fixtures';
import { databaseUrlFile, EVIDENCE_4_4 } from './paths';

/**
 * Task 4.4 in the browser: a meeting note with my rough notes + a transcript, enhanced with the mock LLM
 * (in-process, slowed down by `web-server.ts` so the stream can be watched): the read-only preview streams,
 * a reload mid-stream re-attaches to the running job, and the result replaces the body with my lines marked
 * `me` and the AI's additions `ai`.
 */

// Own user per test: meeting notes made here must not show up in other specs' shared user (e.g. Home's empty
// state in smoke.spec.ts).
test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-enhance'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' });
const saved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

/** Meetings and transcripts have no web API yet (desktop sync, 3.5): seed them in the e2e database. */
async function seedMeeting(page: Page, documentId: string) {
  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  try {
    const [m] = await db
      .insert(meeting)
      .values({
        documentId,
        startedAt: new Date('2026-11-12T10:00:00Z'),
        endedAt: new Date('2026-11-12T10:30:00Z'),
      })
      .returning();
    await db.insert(participant).values([
      { meetingId: m!.id, name: 'Riley Chen', email: 'riley@oat.test', source: 'calendar' },
      {
        meetingId: m!.id,
        name: 'Tomás Vidal',
        email: 'tomas@clinicgroup.test',
        source: 'calendar',
      },
    ]);
    const lines = [
      ['system', 'We run eleven clinics and want to start small.'],
      ['mic', 'A pilot in two clinics makes sense, Lakeside and Mill Street.'],
      ['system', 'Our IT lead Arjun will need the SOC 2 report before anything else.'],
      ['mic', 'I will send the SOC 2 report and the integration docs by Wednesday.'],
      ['system', 'Mei Lin signs off on anything over twenty thousand.'],
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

async function evidence(page: Page, name: string, fullPage = false) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_4_4, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${EVIDENCE_4_4}${name}.png`,
    fullPage,
    style: 'nextjs-portal { display: none !important; }',
  });
}

test('enhances a meeting note: streams, re-attaches after a reload, keeps my lines as mine', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const doc = await apiCreateDocument(page, { title: unique('Clinic discovery'), kind: 'meeting' });
  await seedMeeting(page, doc.id);
  await page.goto(`/d/${doc.id}`);

  await editor(page).click();
  await page.keyboard.type('pilot in two clinics');
  await page.keyboard.press('Enter');
  await page.keyboard.type('send SOC 2 report');
  // Typed right before the click: Enhance saves it first, so the AI sees it.
  await page.getByTestId('enhance-button').click();

  const preview = page.getByTestId('enhance-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('enhance-button')).toBeDisabled();
  await expect(preview.locator('h2').first()).toBeVisible();
  await evidence(page, 'enhance-streaming');

  // Reload mid-stream: the page finds the running job and follows its stream again.
  await page.reload();
  await expect(page.getByTestId('enhance-preview')).toBeVisible();
  await expect(page.getByTestId('enhance-button')).toBeDisabled();

  // Done: the editor is back with the enhanced body.
  await expect(editor(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Notes enhanced')).toBeVisible();
  const mine = (text: string) =>
    editor(page).locator('p[data-origin="me"]').filter({ hasText: text });
  await expect(mine('pilot in two clinics')).toHaveCount(1);
  await expect(mine('send SOC 2 report')).toHaveCount(1);
  await expect(editor(page).locator('h2[data-origin="ai"]').first()).toBeVisible();
  await expect(editor(page).locator('p[data-origin="ai"]').first()).toBeVisible();
  await expect(page.getByTestId('enhance-button')).toBeEnabled();
  await evidence(page, 'enhance-done', true);

  // It is the stored body now, and still editable (autosave continues on the new version).
  await page.reload();
  await expect(mine('pilot in two clinics')).toHaveCount(1);
  await editor(page).locator('p[data-origin="me"]').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (confirmed)');
  await saved(page);
  await page.reload();
  await expect(editor(page).getByText('(confirmed)')).toBeVisible();
});

test('a failed run never loses what I typed (editor kept, autosave continues)', async ({
  page,
}) => {
  const doc = await apiCreateDocument(page, { title: unique('Failing run'), kind: 'meeting' });
  // The run fails: the start succeeds, its stream reports `failed` (client-side failure path, deterministic).
  const runId = 'e2e-failing-run';
  await page.route(`**/api/documents/${doc.id}/enhance`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            attached: false,
            enhancement: { id: runId, documentId: doc.id, status: 'generating' },
          },
        })
      : route.fallback(),
  );
  await page.route(`**/api/enhancements/${runId}/stream`, (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
      body:
        'id: 1\nevent: failed\ndata: ' +
        JSON.stringify({
          type: 'failed',
          enhancement: {
            id: runId,
            status: 'failed',
            error: {
              code: 'model_error',
              message: 'The AI service didn’t respond. Try again in a moment.',
            },
          },
        }) +
        '\n\n',
    }),
  );
  await page.goto(`/d/${doc.id}`);
  await editor(page).click();
  await page.keyboard.type('first line typed');
  await page.keyboard.press('Enter');
  await page.keyboard.type('second line typed');
  await page.getByTestId('enhance-button').click();

  await expect(page.getByTestId('enhance-error')).toContainText('didn’t respond');
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toContainText('first line typed');
  await expect(editor(page)).toContainText('second line typed');
  await evidence(page, 'enhance-failed');

  // The next keystroke saves on top of what I typed, not over it.
  await editor(page).getByText('second line typed').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await saved(page);
  await page.reload();
  await expect(editor(page)).toContainText('first line typed');
  await expect(editor(page)).toContainText('second line typed!');
});

test.describe('template menu and errors', () => {
  // The refused start (422) is logged by the browser as a failed resource load; that's the point here.
  test.use({ allowConsoleErrors: true });

  test('picks a template from the menu, and explains when there is nothing to enhance', async ({
    page,
  }) => {
    const empty = await apiCreateDocument(page, { title: unique('Empty call'), kind: 'meeting' });
    await page.goto(`/d/${empty.id}`);
    await page.getByTestId('enhance-template-menu').click();
    const items = page.getByTestId('enhance-template');
    await expect(items.first()).toBeVisible();
    await expect(items).toContainText([
      'General',
      '1:1',
      'Sales discovery',
      'Standup',
      'Interview',
    ]);
    await evidence(page, 'enhance-template-menu');
    await items.filter({ hasText: '1:1' }).click();
    const error = page.getByTestId('enhance-error');
    await expect(error).toContainText('nothing to enhance');
    await evidence(page, 'enhance-nothing');
    await error.getByRole('button', { name: 'Dismiss' }).click();
    await expect(error).toHaveCount(0);

    // Pages have no Enhance button.
    const pageDoc = await apiCreateDocument(page, { title: unique('Plain page'), kind: 'page' });
    await page.goto(`/d/${pageDoc.id}`);
    await expect(page.getByTestId('document-title')).toBeVisible();
    await expect(page.getByTestId('enhance-button')).toHaveCount(0);
  });
});
