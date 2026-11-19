import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDb, meeting, participant, transcriptSegment } from '@oat/db';
import type { Page } from '@playwright/test';

import type { DocumentDetail } from '../src/lib/api-types';
import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, unique } from './docs-helpers';
import { expect, test } from './fixtures';
import { databaseUrlFile } from './paths';

/**
 * Task 3.4 on the web: a meeting note shows its header (when it was recorded, attendees) and the transcript in
 * a collapsible, resizable side panel; editors add and remove attendees; clicking a line makes the URL that
 * line's deep link; `?t=` opens the panel at the moment. Meetings and transcripts come from the desktop
 * (sync), so they are written into the e2e database directly here; the desktop → web path is covered by
 * the desktop e2e (`apps/desktop/e2e/meeting.spec.ts`).
 */

const EVIDENCE = fileURLToPath(new URL('../../../docs/tasks/evidence/3.4/', import.meta.url));

// Own user per test: meeting notes and trashed notes would show up on the shared user's home and trash.
test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-meeting'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

const TALK = [
  ['system', 'Thanks for joining. Let us go through the pilot timeline first.'],
  ['mic', 'Sure. We planned the Lakeside rollout for early March.'],
  ['system', 'Procurement still needs the security review signed.'],
  ['mic', 'I will send the questionnaire back by Friday.'],
] as const;

/** A recorded meeting note: 40 lines over ~13 minutes, one attendee from the calendar. */
async function seedMeeting(page: Page): Promise<{ doc: DocumentDetail; lines: string[] }> {
  const doc = await apiCreateDocument(page, {
    title: unique('Lakeside pilot sync'),
    kind: 'meeting',
  });
  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  const lines = Array.from({ length: 40 }, (_, i) => `${doc.id}-l${String(i).padStart(2, '0')}`);
  try {
    const [m] = await db
      .insert(meeting)
      .values({
        documentId: doc.id,
        startedAt: new Date('2026-11-12T15:04:00Z'),
        endedAt: new Date('2026-11-12T15:34:20Z'),
      })
      .returning();
    await db.insert(participant).values({
      meetingId: m!.id,
      name: 'Riley Chen',
      email: 'riley@example.com',
      source: 'calendar',
    });
    await db.insert(transcriptSegment).values(
      lines.map((id, i) => {
        const [source, text] = TALK[i % TALK.length]!;
        return {
          id,
          meetingId: m!.id,
          source,
          startMs: i * 20_000,
          endMs: i * 20_000 + 6_000,
          text,
        };
      }),
    );
  } finally {
    await db.$client.end();
  }
  return { doc, lines };
}

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({
      path: `${EVIDENCE}${name}-${scheme}.png`,
      style: 'nextjs-portal { display: none !important; }',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/**
 * Right after a load, a streamed page segment can still sit in the DOM as a hidden copy (`<div hidden
 * id="S:n">`) next to the hydrated one for a moment: wait until it is gone, and match visible elements only.
 */
async function settled(page: Page) {
  await expect(page.locator('div[hidden][id^="S:"]')).toHaveCount(0);
}
const panel = (page: Page) => page.getByTestId('transcript-panel').filter({ visible: true });
const chips = (page: Page) => page.getByTestId('participant-chip').filter({ visible: true });

test('meeting header, attendees, transcript panel (collapse, resize, click → deep link)', async ({
  page,
}) => {
  await page.goto('/home');
  const { doc, lines } = await seedMeeting(page);
  await page.goto(`/d/${doc.id}`);
  await settled(page);

  // Header: when, how long, who (from the calendar).
  const header = page.getByTestId('meeting-header').filter({ visible: true });
  await expect(header.getByTestId('meeting-time')).toContainText('Nov 12');
  await expect(header.getByTestId('meeting-duration')).toHaveText('30 min');
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute('data-source', 'calendar');
  await expect(chips(page).first()).toContainText('Riley Chen');

  // Transcript panel beside the note, me/them lines.
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('40');
  // No player on the web (3.7, D-10): the panel says where the audio is.
  await expect(panel(page).getByTestId('audio-hint')).toHaveText(
    'Audio is on the Mac that recorded this meeting',
  );
  await expect(page.getByTestId('playback')).toHaveCount(0);
  await expect(
    panel(page).locator('[data-testid=transcript-segment][data-source=mic]').first(),
  ).toBeVisible();
  await expect(
    panel(page).locator('[data-testid=transcript-segment][data-source=system]').first(),
  ).toBeVisible();
  await evidence(page, 'web-meeting');

  // Attendees: add (persisted), remove (persisted).
  await page.getByTestId('add-participant').click();
  await page.getByLabel('Name').fill('Dana Scully');
  await page.getByLabel('Email (optional)').fill('dana@example.com');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(1)).toHaveAttribute('data-source', 'manual');
  await evidence(page, 'web-attendees');
  await page.reload();
  await settled(page);
  await expect(chips(page)).toHaveCount(2);
  // Removal is optimistic: the chip goes at once, so wait for the server before reloading.
  const removed = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && /\/participants\//.test(r.url()) && r.ok(),
  );
  await page.getByRole('button', { name: 'Remove Dana Scully' }).click();
  await expect(chips(page)).toHaveCount(1);
  await removed;
  await page.reload();
  await settled(page);
  await expect(chips(page)).toHaveCount(1);

  // Resize with the keyboard on the handle; the width is remembered.
  const width = Number(await panel(page).getAttribute('data-width'));
  const handle = panel(page).getByRole('separator', { name: 'Resize panel' });
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(panel(page)).toHaveAttribute('data-width', String(width + 32));
  // And by dragging it (measured afresh on each attempt: the panel may still be settling).
  await expect(async () => {
    const before = Number(await panel(page).getAttribute('data-width'));
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 60, y, { steps: 4 });
    await page.mouse.up();
    expect(Number(await panel(page).getAttribute('data-width'))).toBe(before + 60);
  }).toPass({ timeout: 20_000 });
  const dragged = Number(await panel(page).getAttribute('data-width'));
  expect(dragged).toBeGreaterThanOrEqual(width + 92);
  await page.reload();
  await settled(page);
  await expect(panel(page)).toHaveAttribute('data-width', String(dragged));

  // Collapse: hidden (remembered), reopened from the header.
  await page.getByRole('button', { name: 'Hide transcript' }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.reload();
  await settled(page);
  await expect(page.getByTestId('meeting-header').filter({ visible: true })).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await evidence(page, 'web-collapsed');
  await page.getByTestId('transcript-toggle').click();
  await expect(panel(page)).toBeVisible();

  // Clicking a line picks it: highlighted, and the URL is now its deep link.
  await panel(page)
    .getByRole('button', { name: /^Them at 0:40:/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}\\?t=40&seg=${lines[2]}$`));
  await expect(panel(page).locator('[data-focused]')).toHaveAttribute('data-segment-id', lines[2]!);
  await page.reload();
  await settled(page);
  await expect(panel(page).locator('[data-focused]')).toHaveAttribute('data-segment-id', lines[2]!);
});

test('a ?t= deep link opens the (collapsed) panel at that moment', async ({ page }) => {
  await page.goto('/home');
  const { doc, lines } = await seedMeeting(page);
  // Remember the panel as closed: the link must open it anyway.
  await page.goto(`/d/${doc.id}`);
  await settled(page);
  await page.getByRole('button', { name: 'Hide transcript' }).click();
  await expect(panel(page)).toHaveCount(0);

  // 11:45 into the meeting → the line spoken then (line 35 starts at 11:40), far down the list.
  await page.goto(`/d/${doc.id}?t=705`);
  await settled(page);
  const focused = panel(page).locator('[data-focused]');
  await expect(focused).toHaveAttribute('data-segment-id', lines[35]!);
  await expect(focused).toBeInViewport();
  await evidence(page, 'web-deep-link');

  // Narrow window: the transcript is a section under the note.
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).not.toHaveAttribute('data-width');
  await expect(page.getByTestId('note-editor')).toBeVisible();
});

test('a trashed meeting note is read-only: no attendee changes', async ({ page }) => {
  await page.goto('/home');
  const { doc } = await seedMeeting(page);
  const res = await page.request.delete(`/api/documents/${doc.id}`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(res.status()).toBe(200);
  await page.goto(`/d/${doc.id}`);
  await settled(page);
  await expect(page.getByTestId('trash-banner')).toBeVisible();
  await expect(chips(page)).toHaveCount(1);
  await expect(page.getByTestId('add-participant')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove Riley Chen' })).toHaveCount(0);
});
