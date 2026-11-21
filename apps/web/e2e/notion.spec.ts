import { mkdirSync } from 'node:fs';

import { type Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, apiUpdateDocument } from './docs-helpers';
import { expect, test } from './fixtures';
import { EVIDENCE_8_1 } from './paths';

/**
 * 8.1: connect Notion (the in-process Notion mock from `e2e/web-server.ts`; consent auto-approves) → choose a
 * target database → "Send to Notion" on a note → the mock's request log shows the created page → edit and
 * "Update in Notion" replaces the content of the same page → disconnect.
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_8_1, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_8_1}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

type Logged = { method: string; path: string; body: string | null; status: number };

const paragraphs = (...texts: string[]) => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

test('connect Notion → choose a database → send a note → update it → disconnect', async ({
  page,
  baseURL,
  playwright,
}) => {
  const email = uniqueAddress('e2e-notion');
  await page.goto('/sign-in');
  await signInWithMagicLink(page, email, baseURL!);
  await expect(page).toHaveURL(/\/home$/);

  await page.goto('/settings/integrations');
  // `:visible`: skips the hidden copy React keeps while it swaps in a streamed boundary.
  const card = page.locator('[data-testid="notion-card"]:visible');
  await expect(card.getByTestId('notion-status')).toHaveText('Not connected');
  await evidence(page, 'integrations-not-connected');

  // OAuth: POST → Notion (mock) consent, auto-approved → callback → back here.
  await card.getByRole('button', { name: 'Connect Notion' }).click();
  await page.waitForURL(/\/settings\/integrations\?connected=notion$/);
  await expect(card.getByTestId('notion-status')).toHaveText('Connected');
  await expect(card.getByTestId('notion-workspace')).toHaveText('Oat Mock Notion');
  await expect(card.getByRole('status')).toContainText('Notion is connected');
  await expect(card.getByTestId('notion-target')).toHaveText('No page or database chosen yet.');

  // Choose the "Meetings" database from a search.
  await card.getByRole('button', { name: 'Choose page or database' }).click();
  const options = page.getByTestId('notion-target-option');
  await expect(options.first()).toBeVisible();
  await expect(options).toContainText([
    'Scratchpad',
    'Reading list',
    'Meetings',
    'Meeting notes',
    'Team Home',
  ]);
  await page.getByRole('combobox', { name: 'Search Notion pages and databases' }).fill('meet');
  await expect(options).toHaveText([/Meetings\s*Database/, /Meeting notes\s*Page/]);
  await evidence(page, 'integrations-target-picker');
  await options.filter({ hasText: 'Meetings' }).first().click();
  await expect(page.getByText('Notes will go to “Meetings”')).toBeVisible();
  await expect(card.getByTestId('notion-target')).toContainText('Meetings');
  await expect(card.getByTestId('notion-target')).toContainText('Database');
  await evidence(page, 'integrations-connected');

  // A note, sent from its page.
  const doc = await apiCreateDocument(page, { title: 'Customer call', kind: 'meeting' });
  const updated = await apiUpdateDocument(page, doc.id, {
    baseVersion: doc.version,
    contentJson: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Decisions' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Ship the ' },
                    { type: 'text', text: 'beta', marks: [{ type: 'bold' }] },
                    { type: 'text', text: ' on Monday' },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Send the recap' }] }],
            },
          ],
        },
      ],
    },
  });
  expect(updated.status()).toBe(200);
  const version = ((await updated.json()) as { version: number }).version;

  await page.goto(`/d/${doc.id}`);
  const send = page.getByTestId('notion-send');
  await page.getByTestId('document-more').click();
  await expect(send).toHaveText('Send to Notion');
  await send.click();
  await expect(page.getByText('Sent to Notion', { exact: true })).toBeVisible();
  const link = page.getByTestId('notion-link');
  await expect(link).toContainText('In Notion');
  await expect(send).toHaveText('Update in Notion');
  await evidence(page, 'document-sent');

  // The mock's request log shows the created page (title, properties, blocks).
  const href = (await link.getAttribute('href'))!;
  const mocksOrigin = new URL(href).origin;
  const api = await playwright.request.newContext();
  const log = (await (await api.get(`${mocksOrigin}/_requests?provider=notion`)).json()) as {
    requests: Logged[];
  };
  // This note's create (other tests may share the mock).
  const create = log.requests.find(
    (r) => r.method === 'POST' && r.path === '/notion/v1/pages' && !!r.body?.includes(doc.id),
  );
  expect(create?.status).toBe(200);
  const body = JSON.parse(create!.body!) as {
    parent: { database_id: string };
    properties: Record<string, unknown>;
  };
  expect(body.parent.database_id).toBeTruthy();
  expect(body.properties).toMatchObject({
    Name: { title: [{ text: { content: 'Customer call' } }] },
    'Oat link': { url: `${baseURL}/d/${doc.id}` },
    Date: { date: { start: expect.any(String) } },
  });
  // The content follows in `PATCH /blocks/{page}/children` (after the metadata line, if any).
  const pageId = new URL(href).pathname.split('/').at(-1)!;
  const append = log.requests.find(
    (r) => r.method === 'PATCH' && r.path.replace(/-/g, '').includes(`/blocks/${pageId}/children`),
  );
  const appended = JSON.parse(append!.body!) as { children: Array<{ type: string }> };
  expect(appended.children.map((c) => c.type)).toEqual([
    'heading_2',
    'bulleted_list_item',
    'to_do',
  ]);

  // The Notion copy (mock viewer).
  const viewer = await page.context().newPage();
  await viewer.goto(href);
  await expect(viewer.getByRole('heading', { level: 1 })).toContainText('Customer call');
  await expect(viewer.locator('main')).toContainText('Ship the beta on Monday');
  await evidence(viewer, 'notion-page-created');

  // Edit in Oat, update in Notion: same page, replaced content.
  expect(
    (
      await apiUpdateDocument(page, doc.id, {
        baseVersion: version,
        title: 'Customer call (follow-up)',
        contentJson: paragraphs('Everything changed.'),
      })
    ).status(),
  ).toBe(200);
  await page.reload();
  await page.getByTestId('document-more').click();
  await expect(page.getByTestId('notion-link')).toContainText('Notion copy is older');
  await page.getByTestId('notion-send').click();
  await expect(page.getByText('Updated in Notion', { exact: true })).toBeVisible();
  await expect(page.getByTestId('notion-link')).toHaveAttribute('href', href);
  await viewer.reload();
  await expect(viewer.getByRole('heading', { level: 1 })).toContainText(
    'Customer call (follow-up)',
  );
  await expect(viewer.locator('main')).toContainText('Everything changed.');
  await expect(viewer.locator('main')).not.toContainText('Ship the beta');
  await evidence(viewer, 'notion-page-updated');
  await viewer.close();

  // Phone width: the actions get a row of their own (no sideways scrolling) and "Send to Notion" moves into
  // "More actions" (9.3b).
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('top-bar-actions').getByTestId('document-actions')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByTestId('document-more').click();
  await expect(page.getByTestId('notion-send')).toBeVisible();
  await evidence(page, 'document-sent-phone');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByTestId('top-bar-actions').getByTestId('document-actions')).toBeVisible();

  // Disconnect: the note page then asks to connect first.
  await page.goto('/settings/integrations');
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByTestId('notion-status')).toHaveText('Not connected');
  await page.goto(`/d/${doc.id}`);
  await page.getByTestId('document-more').click();
  await expect(page.getByTestId('notion-send')).toHaveText('Send to Notion');
  await page.getByTestId('notion-send').click();
  await expect(page.getByText('Connect Notion first')).toBeVisible();
  await api.dispose();
});
