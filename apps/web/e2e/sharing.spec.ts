import { mkdirSync } from 'node:fs';

import type { Browser, Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, apiUpdateDocument } from './docs-helpers';
import { expect, hydrationAware, test } from './fixtures';
import { EVIDENCE_5_3 } from './paths';

/**
 * Task 5.3 in the browser: share a note by link from the document page, open the link in a fresh browser
 * context (no cookies) → read-only content, no editor, no API access; turn the link off → 404; turn it
 * back on → a new link, the old one stays dead.
 */
test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-share'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_5_3, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_5_3}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

const NOTE = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2, origin: 'ai' },
      content: [{ type: 'text', text: 'Decisions' }],
    },
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Ship the share viewer this week.' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: '<img src=x onerror="window.__pwned=1"> stays text' },
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
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft the plan' }] }],
        },
        {
          type: 'taskItem',
          attrs: { checked: false },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Review with the team' }] },
          ],
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Spec: ' },
        {
          type: 'text',
          text: 'example.com',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/spec' } }],
        },
      ],
    },
  ],
};

/** Opens the share dialog on the current document page. */
async function openShare(page: Page) {
  await page.getByTestId('share-button').click();
  const dialog = page.getByTestId('share-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Private/ })).toBeVisible();
  return dialog;
}

/**
 * Console noise a share 404 produces in `next dev`, and nothing else: Chrome logs the 404 document as a
 * failed resource, and Next.js recovers `notFound()` by rendering the page on the client, where React's
 * dev build warns about the root layout's (server-only) theme script. Anything else — a CSP violation,
 * a hydration error — fails the test.
 */
const EXPECTED_ON_404 = [
  /status of 404/,
  /^Encountered a script tag while rendering React component/,
];

/** A browser context with no cookies at all (a stranger who got the link). */
async function stranger(browser: Browser) {
  const context = await browser.newContext();
  const page = hydrationAware(await context.newPage());
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !EXPECTED_ON_404.some((re) => re.test(m.text()))) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors };
}

test('share via link → a stranger reads it, can’t edit; link off → 404; back on → new link', async ({
  page,
  browser,
}) => {
  const doc = await apiCreateDocument(page, { title: 'Quarterly plan' });
  expect(
    (await apiUpdateDocument(page, doc.id, { baseVersion: 0, contentJson: NOTE })).status(),
  ).toBe(200);
  await page.goto(`/d/${doc.id}`);
  await expect(page.getByTestId('document-title')).toHaveValue('Quarterly plan');

  let dialog = await openShare(page);
  await expect(page.getByTestId('share-summary')).toHaveText('Only you can open this.');
  await expect(dialog.getByRole('radio', { name: /Private/ })).toBeChecked();
  await evidence(page, 'share-dialog-private');

  await dialog.getByText('Anyone with the link', { exact: true }).click();
  const linkInput = dialog.getByTestId('share-link');
  await expect(linkInput).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Anyone with the link/ })).toBeChecked();
  await expect(page.getByTestId('share-summary')).toContainText('anyone with the link can view');
  const link = await linkInput.inputValue();
  expect(link).toMatch(/\/share\/[A-Za-z0-9_-]{22,}$/);
  await evidence(page, 'share-dialog-link');
  await page.keyboard.press('Escape');
  // The page reflects the change, and the editor keeps saving (sharing doesn't touch the content version).
  await expect(page.getByText(/\+ link/)).toBeVisible();
  const title = page.getByTestId('document-title');
  await title.fill('Quarterly plan v2');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // A stranger with no cookies.
  const anon = await stranger(browser);
  const res = await anon.page.goto(link);
  expect(res?.status()).toBe(200);
  const headers = res!.headers();
  expect(headers['content-security-policy']).toContain(`script-src 'self' 'nonce-`);
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-robots-tag']).toBe('noindex, nofollow');
  const view = anon.page.getByTestId('shared-document');
  await expect(view.getByRole('heading', { level: 1, name: 'Quarterly plan v2' })).toBeVisible();
  await expect(view.getByRole('heading', { level: 2, name: 'Decisions' })).toBeVisible();
  await expect(view.getByText('Ship the share viewer this week.')).toBeVisible();
  await expect(view.getByText('<img src=x onerror="window.__pwned=1"> stays text')).toBeVisible();
  expect(await anon.page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  await expect(view.getByRole('link', { name: 'example.com' })).toHaveAttribute(
    'rel',
    'noopener noreferrer nofollow',
  );
  await expect(view.getByRole('checkbox')).toHaveCount(2);
  await expect(view.getByRole('checkbox').first()).toBeDisabled();
  await expect(anon.page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // Read-only: no editor, no title field, no app chrome.
  await expect(anon.page.locator('[contenteditable="true"], textarea')).toHaveCount(0);
  await expect(anon.page.getByTestId('share-button')).toHaveCount(0);
  await expect(anon.page.getByTestId('app-sidebar')).toHaveCount(0);
  await expect(anon.page.getByText('Read-only', { exact: true })).toBeVisible();
  await evidence(anon.page, 'share-view');
  // Hydrated under the CSP: the theme menu works.
  await anon.page.getByTestId('theme-menu').click();
  await expect(anon.page.getByRole('menu')).toBeVisible();
  await anon.page.keyboard.press('Escape');

  // The link opens nothing else: the API still wants a session.
  const api = anon.context.request;
  const origin = new URL(link).origin;
  expect((await api.get(`${origin}/api/documents/${doc.id}`)).status()).toBe(401);
  expect(
    (
      await api.patch(`${origin}/api/documents/${doc.id}`, {
        data: { baseVersion: 2, title: 'pwned' },
        headers: { origin },
      })
    ).status(),
  ).toBe(401);
  expect((await api.get(`${origin}/api/documents/${doc.id}/share`)).status()).toBe(401);

  // Turn the link off → 404 for the stranger.
  dialog = await openShare(page);
  await dialog.getByText('Workspace', { exact: true }).click();
  await expect(dialog.getByTestId('share-link')).toHaveCount(0);
  await page.keyboard.press('Escape');
  const off = await anon.page.goto(link);
  expect(off?.status()).toBe(404);
  await expect(anon.page.getByRole('heading', { name: 'This link isn’t available' })).toBeVisible();
  await expect(anon.page.getByText('Ship the share viewer this week.')).toHaveCount(0);
  await evidence(anon.page, 'share-view-disabled');

  // Back on → a new link; the old one stays dead.
  dialog = await openShare(page);
  await dialog.getByText('Anyone with the link', { exact: true }).click();
  const newLink = await dialog.getByTestId('share-link').inputValue();
  expect(newLink).not.toBe(link);
  // Reset link → yet another; the previous one stops working.
  await dialog.getByRole('button', { name: 'Reset link' }).click();
  await expect(dialog.getByTestId('share-link')).not.toHaveValue(newLink);
  const resetLink = await dialog.getByTestId('share-link').inputValue();
  await page.keyboard.press('Escape');
  expect((await anon.page.goto(link))?.status()).toBe(404);
  expect((await anon.page.goto(newLink))?.status()).toBe(404);
  expect((await anon.page.goto(resetLink))?.status()).toBe(200);
  await expect(anon.page.getByText('Ship the share viewer this week.')).toBeVisible();
  await anon.page.emulateMedia({ colorScheme: 'dark' });
  await anon.page.reload();
  await expect(anon.page.locator('html')).toHaveClass(/\bdark\b/); // theme script allowed by CSP hash
  await evidence(anon.page, 'share-view-dark');

  expect(anon.errors, 'console errors in the public viewer').toEqual([]);
  await anon.context.close();
});

test('an unknown or malformed link is a 404 in the public layout', async ({ browser }) => {
  const anon = await stranger(browser);
  for (const path of ['/share/abc123token', `/share/${'A'.repeat(32)}`, '/share/%3Cscript%3E']) {
    const res = await anon.page.goto(path);
    expect(res?.status()).toBe(404);
    await expect(
      anon.page.getByRole('heading', { name: 'This link isn’t available' }),
    ).toBeVisible();
    await expect(anon.page.getByText('Read-only', { exact: true })).toBeVisible();
    await expect(anon.page.getByTestId('app-sidebar')).toHaveCount(0);
  }
  await evidence(anon.page, 'share-view-unknown');
  expect(anon.errors).toEqual([]);
  await anon.context.close();
});

test('meeting notes: the transcript toggle (off by default) appears for link sharing', async ({
  page,
}) => {
  const doc = await apiCreateDocument(page, { title: 'Design review', kind: 'meeting' });
  await page.goto(`/d/${doc.id}`);
  const dialog = await openShare(page);
  await expect(dialog.getByTestId('share-transcript')).toHaveCount(0);
  await dialog.getByText('Anyone with the link', { exact: true }).click();
  const toggle = dialog.getByTestId('share-transcript');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await evidence(page, 'share-dialog-meeting');
  // Persisted: reopen the dialog.
  await page.keyboard.press('Escape');
  const again = await openShare(page);
  await expect(again.getByTestId('share-transcript')).toBeChecked();
});
