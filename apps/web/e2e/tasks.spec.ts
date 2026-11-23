import { mkdirSync, readFileSync } from 'node:fs';

import { createDb, meeting, participant, transcriptSegment } from '@oat/db';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, unique } from './docs-helpers';
import { expect, test } from './fixtures';
import { databaseUrlFile, EVIDENCE_8_4 } from './paths';
import { verifyFeatureSurface } from './feature-surfaces';

/**
 * Task 8.4 in the browser: action items in a meeting note get an owner (picker) and a due date (picker), survive
 * enhancement (mock LLM), show up in My tasks (the index worker in `web-server.ts` extracts them from the change
 * log), and ticking one there updates the note.
 */

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-tasks'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' });
const saved = (page: Page) =>
  expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

async function seedMeeting(page: Page, documentId: string) {
  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  try {
    const [m] = await db
      .insert(meeting)
      .values({ documentId, startedAt: new Date(), endedAt: new Date(Date.now() + 30 * 60_000) })
      .returning();
    await db
      .insert(participant)
      .values([
        { meetingId: m!.id, name: 'Riley Chen', email: 'riley@client.test', source: 'calendar' },
      ]);
    const lines = [
      ['system', 'We want to start with a pilot in two clinics.'],
      ['mic', 'I will send the pilot proposal tomorrow.'],
      ['system', 'Riley will book a room for the kickoff.'],
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
  mkdirSync(EVIDENCE_8_4, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: `${EVIDENCE_8_4}${name}.png`,
    fullPage,
    style: 'nextjs-portal { display: none !important; }',
  });
}

const taskRow = (page: Page, text: string) =>
  editor(page).locator('li[data-type="taskItem"]').filter({ hasText: text });

test('assign + date a task, enhance, find it in My tasks, tick it there → the note is updated', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const title = unique('Pilot kickoff');
  const doc = await apiCreateDocument(page, { title, kind: 'meeting' });
  await seedMeeting(page, doc.id);
  await page.goto(`/d/${doc.id}`);

  // Two to-dos, typed as a checklist.
  await editor(page).click();
  await page.keyboard.type('[] Send the pilot proposal');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Book a room for the kickoff');
  await expect(editor(page).locator('li[data-type="taskItem"]')).toHaveCount(2);

  // Assign the first to me from the picker, due tomorrow.
  const first = taskRow(page, 'Send the pilot proposal');
  await first.hover();
  await first.getByRole('button', { name: 'Assign task' }).click();
  const picker = page.getByTestId('task-owner-picker');
  await expect(picker.getByRole('option').first()).toBeVisible();
  await evidence(page, 'owner-picker');
  await picker.getByRole('option').first().click();
  await expect(first.getByRole('button', { name: /^Assigned to / })).toBeVisible();
  await first.hover();
  await first.getByRole('button', { name: 'Set due date' }).click();
  await page.getByTestId('task-due-picker').getByRole('button', { name: 'Tomorrow' }).click();
  await expect(first.getByRole('button', { name: /^Due Tomorrow/ })).toBeVisible();

  // The second goes to an attendee by typed name search.
  const second = taskRow(page, 'Book a room');
  await second.hover();
  await second.getByRole('button', { name: 'Assign task' }).click();
  await page.getByTestId('task-owner-picker').getByRole('combobox').fill('Riley');
  await page
    .getByTestId('task-owner-picker')
    .getByRole('option', { name: /Riley Chen/ })
    .click();
  await expect(
    second.getByRole('button', { name: 'Assigned to Riley Chen. Change' }),
  ).toBeVisible();
  await saved(page);
  await evidence(page, 'editor-chips');

  // Enhance (mock LLM): my tasks stay tasks, with their owners and due dates.
  await page.getByTestId('enhance-button').click();
  await expect(page.getByText('Notes enhanced')).toBeVisible({ timeout: 60_000 });
  await expect(taskRow(page, 'Send the pilot proposal')).toHaveCount(1);
  await expect(
    taskRow(page, 'Send the pilot proposal').getByRole('button', { name: /^Assigned to / }),
  ).toBeVisible();
  await expect(
    taskRow(page, 'Book a room').getByRole('button', { name: 'Assigned to Riley Chen. Change' }),
  ).toBeVisible();

  // My tasks (sidebar): the worker picks the note up from the change log within a moment.
  await page.getByTestId('workspace-switcher').click();
  await page.getByTestId('nav-tasks').click();
  await expect(page).toHaveURL(/\/tasks/);
  const row = page.getByTestId('task-row').filter({ hasText: 'Send the pilot proposal' });
  await expect(async () => {
    await page.reload();
    await expect(row).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(row.getByTestId('task-owner')).toHaveText(/You/);
  await expect(row.getByTestId('task-due')).toHaveText(/Tomorrow/);
  // Assigned to someone else: only under "All in workspace".
  await expect(page.getByTestId('task-row').filter({ hasText: 'Book a room' })).toHaveCount(0);
  await page.getByTestId('tasks-view-all').click();
  const other = page.getByTestId('task-row').filter({ hasText: 'Book a room' });
  await expect(other).toBeVisible();
  await expect(other.getByTestId('task-owner')).toHaveText(/Riley Chen/);
  await expect(page.getByTestId('task-group').first()).toContainText(title);
  await evidence(page, 'my-tasks');
  await verifyFeatureSurface(page, 'tasks');

  // Tick it here → its note is updated.
  await row.getByRole('checkbox').check();
  await expect(row).toHaveAttribute('data-done', 'true');
  await expect(row.getByRole('checkbox')).toBeEnabled();
  await evidence(page, 'my-tasks-done');

  // The link jumps to the block in the note, which shows it done.
  await row.getByRole('link', { name: 'Send the pilot proposal' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}\\?block=`));
  const target = taskRow(page, 'Send the pilot proposal');
  await expect(target).toHaveAttribute('data-checked', 'true');
  await expect(target).toHaveAttribute('data-block-highlight', '');
  await evidence(page, 'block-link');

  // Stored, not just shown: after a reload the note still has it ticked and the list agrees.
  await page.reload();
  await expect(taskRow(page, 'Send the pilot proposal')).toHaveAttribute('data-checked', 'true');
  await page.goto('/tasks?view=assigned&status=done');
  await expect(
    page.getByTestId('task-row').filter({ hasText: 'Send the pilot proposal' }),
  ).toBeVisible();
});

test('⌘K opens My tasks; empty state when nothing is assigned', async ({ page }) => {
  await page.goto('/home');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: 'My tasks' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
  await expect(page.getByText('Nothing assigned to you')).toBeVisible();
  await evidence(page, 'my-tasks-empty');
});
