import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, apiUpdateDocument } from './docs-helpers';
import { expect, test } from './fixtures';
import { EVIDENCE_8_3 } from './paths';

/**
 * 8.3: the post-meeting pipeline end to end. Turn on "Auto-send meeting notes to Notion" (Notion mock), record a
 * meeting the way the desktop syncs it (meeting row + transcript, then the end), and the real agents server
 * (`e2e/web-server.ts`) enhances, indexes and sends it: the note's header shows "Post-meeting: done" and the
 * Notion mock received the page.
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_8_3, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_8_3}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

type Logged = { method: string; path: string; body: string | null };

const scale = Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1);

test('a meeting ends → the pipeline enhances it and auto-sends it to Notion', async ({
  page,
  baseURL,
  playwright,
}) => {
  test.setTimeout(150_000 * scale);
  const email = uniqueAddress('e2e-pipeline');
  await page.goto('/sign-in');
  await signInWithMagicLink(page, email, baseURL!);
  await expect(page).toHaveURL(/\/home$/);

  // Settings: auto-enhance is on by default; connect Notion, pick a page, switch auto-send on.
  await page.goto('/settings/integrations');
  const after = page.locator('[data-testid="after-meetings-card"]:visible');
  await expect(after.getByTestId('pipeline-autoEnhance')).toBeChecked();
  const card = page.locator('[data-testid="notion-card"]:visible');
  await card.getByRole('button', { name: 'Connect Notion' }).click();
  await page.waitForURL(/\/settings\/integrations\?connected=notion$/);
  await card.getByRole('button', { name: 'Choose page or database' }).click();
  await page.getByRole('combobox', { name: 'Search Notion pages and databases' }).fill('meeting');
  await page.getByTestId('notion-target-option').filter({ hasText: 'Meeting notes' }).click();
  await expect(card.getByTestId('notion-target')).toContainText('Meeting notes');
  const autoSend = card.getByTestId('pipeline-autoSendToNotion');
  await expect(autoSend).not.toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/settings/pipeline') && r.request().method() === 'PUT',
  );
  await autoSend.click();
  expect((await saved).status()).toBe(200);
  await expect(autoSend).toBeChecked();
  await expect(card.getByText('When a meeting ends, its notes go to')).toBeVisible();
  await evidence(page, 'settings');
  // Saved on the server (a reload shows it).
  await page.reload();
  await expect(
    page.locator('[data-testid="notion-card"]:visible').getByTestId('pipeline-autoSendToNotion'),
  ).toBeChecked();

  // A meeting recorded on the desktop: the note with the user's lines, then the meeting and its transcript.
  const title = `Pilot sync ${randomUUID().slice(0, 6)}`;
  const doc = await apiCreateDocument(page, { title, kind: 'meeting' });
  const notes = await apiUpdateDocument(page, doc.id, {
    baseVersion: doc.version,
    contentJson: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'pilot in two clinics' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Dana: security review' }] },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(notes.status()).toBe(200);
  const meetingId = randomUUID();
  let version = 0;
  const meetingRow = (endedAt: string | null) => ({
    version: ++version,
    op: 'upsert',
    table: 'meeting',
    row: {
      id: meetingId,
      documentId: doc.id,
      calendarEventId: null,
      startedAt: '2026-11-15T10:00:00.000Z',
      endedAt,
      platform: 'zoom',
    },
  });
  const segments = [
    'We want to start the pilot in two clinics next month.',
    'Dana will send the security review by Friday.',
  ].map((text, i) => ({
    version: ++version,
    op: 'upsert',
    table: 'transcript_segment',
    row: {
      id: `${meetingId}-s${i}`,
      meetingId,
      source: i % 2 ? 'system' : 'mic',
      speakerLabel: null,
      startMs: i * 5000,
      endMs: i * 5000 + 4000,
      text,
    },
  }));
  const push = async (entries: unknown[]) => {
    const res = await page.request.post('/api/sync/push', {
      data: { entries },
      headers: { origin: new URL(page.url()).origin },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = (await res.json()) as { results: { status: string }[] };
    expect(
      body.results.every((r) => r.status === 'ok'),
      JSON.stringify(body),
    ).toBe(true);
  };
  await push([meetingRow(null), ...segments]);

  // Still recording: no pipeline yet.
  await page.goto(`/d/${doc.id}`);
  await expect(page.getByTestId('document-title')).toHaveValue(title);
  await expect(page.getByTestId('pipeline-status')).toHaveCount(0);

  // The meeting ends (the desktop syncs `ended_at`): the pipeline runs silently on its own.
  await push([meetingRow('2026-11-15T10:30:00.000Z')]);
  await page.reload();
  await expect(page.getByTestId('pipeline-status')).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const res = (await (
          await page.request.get(`/api/documents/${doc.id}/pipeline`)
        ).json()) as {
          run: { status: string } | null;
        };
        return res.run?.status ?? null;
      },
      { timeout: 90_000 * scale, intervals: [500] },
    )
    .toBe('completed');
  await evidence(page, 'done');

  // Enhanced (the AI's blocks are in the note now) and sent: the Notion mock received this note's page.
  const detail = (await (await page.request.get(`/api/documents/${doc.id}`)).json()) as {
    version: number;
  };
  expect(detail.version).toBeGreaterThan(doc.version + 1);
  const run = (await (await page.request.get(`/api/documents/${doc.id}/pipeline`)).json()) as {
    run: { steps: { step: string; outcome: string }[] };
  };
  expect(run.run.steps.map((s) => [s.step, s.outcome])).toEqual([
    ['enhance', 'ran'],
    ['index', 'ran'],
    ['notion', 'ran'],
  ]);
  // The note's Notion button loads its status once: after a reload it links to the page the pipeline made.
  await page.reload();
  await expect(page.getByTestId('pipeline-status')).toHaveCount(0);
  await page.getByTestId('document-more').click();
  const link = page.getByTestId('notion-link');
  await expect(link).toContainText('In Notion');
  await expect(page.getByTestId('notion-send')).toHaveText('Update in Notion');
  await evidence(page, 'done-sent');
  const mocksOrigin = new URL((await link.getAttribute('href'))!).origin;
  const api = await playwright.request.newContext();
  const log = (await (await api.get(`${mocksOrigin}/_requests?provider=notion`)).json()) as {
    requests: Logged[];
  };
  // One page under "Meeting notes", titled like the note (other tests may share the mock).
  const created = log.requests.filter(
    (r) => r.method === 'POST' && r.path === '/notion/v1/pages' && !!r.body?.includes(title),
  );
  expect(created).toHaveLength(1);
  // …and its content went in after it (the note's blocks, with the link back to it).
  const pageId = new URL((await link.getAttribute('href'))!).pathname.split('/').pop()!;
  const appended = log.requests.filter(
    (r) =>
      r.method === 'PATCH' &&
      r.path.includes(pageId.replace(/-/g, '').slice(0, 8)) &&
      r.path.endsWith('/children'),
  );
  expect(appended.length).toBeGreaterThan(0);
  expect(appended.some((r) => !!r.body?.includes(doc.id))).toBe(true);
  await api.dispose();
});
