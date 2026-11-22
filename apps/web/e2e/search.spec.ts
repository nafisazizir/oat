import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { createDb, meeting, newId, transcriptSegment } from '@oat/db';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument } from './docs-helpers';
import { expect, test } from './fixtures';
import { databaseUrlFile, EVIDENCE_3_6 } from './paths';
import { verifyFeatureSurface } from './feature-surfaces';

/**
 * Task 3.6 in the browser: ⌘K shows ranked note + transcript hits and opens them from the keyboard; the
 * /search page has Notes / Transcripts tabs. Transcript segments have no API yet (desktop sync, 3.5), so
 * they are written straight into the e2e server's throwaway database. Each test signs up its own user, so
 * its meeting notes never show up in other specs' Home.
 */

/** A unique identifier term, without natural-language stemming of random prefixes. */
const uniqueWord = () => `zq${randomBytes(4).toString('hex')}`;

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function addTranscript(page: Page, documentId: string, lines: Array<[number, string]>) {
  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  try {
    const meetingId = newId();
    await db.insert(meeting).values({ id: meetingId, documentId });
    await db.insert(transcriptSegment).values(
      lines.map(([startMs, text], i) => ({
        id: newId(),
        meetingId,
        source: i % 2 ? ('system' as const) : ('mic' as const),
        startMs,
        endMs: startMs + 4000,
        text,
      })),
    );
  } finally {
    await db.$client.end();
  }
}

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_3_6, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_3_6}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

test.use({ viewport: { width: 1280, height: 800 }, storageState: SIGNED_OUT });

test.beforeEach(async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-search'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

test('command palette separators do not break listbox accessibility', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[cmdk-separator]')).toHaveAttribute('aria-hidden', 'true');
  const { violations } = await new AxeBuilder({ page })
    .include('[role=dialog]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('⌘K finds notes and transcript lines; Enter opens the hit; /search has tabs', async ({
  page,
}) => {
  const word = uniqueWord();
  // Created first so it is never the most recent: ranking includes a recency boost, and the Pricing note
  // (title + body match, newest) must rank first deterministically.
  await apiCreateDocument(page, { title: `Older ${word} notes` });
  const note = await apiCreateDocument(page, {
    title: `Pricing ${word} plan`,
    visibility: 'workspace',
  });
  const res = await page.request.patch(`/api/documents/${note.id}`, {
    data: {
      baseVersion: note.version,
      contentJson: paragraph(`We agreed the ${word} tier costs less & ships <b>soon</b>.`),
    },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(res.status(), await res.text()).toBe(200);
  const call = await apiCreateDocument(page, { title: 'Customer call', kind: 'meeting' });
  await addTranscript(page, call.id, [
    [12_000, 'Thanks for joining, let me share my screen.'],
    [65_400, `The ${word} discount only applies to annual plans.`],
  ]);

  await page.goto('/home');
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(word.slice(0, 5)); // prefix while typing
  const notes = palette.getByTestId('search-result-note');
  await expect(notes.first()).toContainText(`Pricing ${word} plan`);
  await expect(notes).toHaveCount(2);
  const transcript = palette.getByTestId('search-result-transcript');
  await expect(transcript).toHaveCount(1);
  await expect(transcript).toContainText('1:05');
  await expect(transcript).toContainText('Customer call');
  // The highlight is a <mark>, and note text stays text.
  await expect(notes.first().locator('mark').first()).toHaveText(new RegExp(word, 'i'));
  await expect(notes.first()).toContainText('less & ships');
  await expect(notes.first().locator('b')).toHaveCount(0);
  // The best hit is selected: Enter opens it.
  await expect(notes.first()).toHaveAttribute('data-selected', 'true');
  await evidence(page, 'palette-results');
  await verifyFeatureSurface(page, 'search-dialog');
  const [tab] = await Promise.all([
    page.context().waitForEvent('page'),
    notes.first().click({ modifiers: ['ControlOrMeta'] }),
  ]);
  await expect(tab).toHaveURL(new RegExp(`/d/${note.id}$`));
  await tab.close();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/d/${note.id}$`));
  await expect(page.getByTestId('document-title')).toHaveValue(`Pricing ${word} plan`);

  // Keyboard navigation down to the transcript hit.
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox').fill(`${word} discount`);
  await expect(transcript).toHaveCount(1);
  await expect(palette.getByTestId('search-result-note')).toHaveCount(0);
  await expect(transcript).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/d/${call.id}\\?t=65$`));

  // "Search all results" → /search, then the Transcripts tab.
  await page.keyboard.press('ControlOrMeta+k');
  await palette.getByRole('combobox').fill(word);
  await expect(notes).toHaveCount(2);
  await palette.getByRole('option', { name: /Search all results/ }).click();
  await expect(page).toHaveURL(new RegExp(`/search\\?q=${word}$`));
  const main = page.getByRole('main');
  await expect(main.getByTestId('search-page-note')).toHaveCount(2);
  await expect(main.getByRole('tab', { name: /Notes/ })).toContainText('2');
  await evidence(page, 'search-page-notes');
  await verifyFeatureSurface(page, 'search-results');
  await main.getByRole('tab', { name: /Transcripts/ }).click();
  await expect(page).toHaveURL(/tab=transcripts/);
  const line = main.getByTestId('search-page-transcript');
  await expect(line).toHaveCount(1);
  await expect(line).toContainText('1:05');
  await expect(line).toContainText('Them');
  await evidence(page, 'search-page-transcripts');

  // Reload keeps query + tab; no match → empty state.
  await page.reload();
  await expect(main.getByRole('tab', { name: /Transcripts/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await main.getByRole('searchbox').fill(`${word}nothing`);
  await expect(main.getByText(/No transcript lines match/)).toBeVisible();
  await main.getByRole('searchbox').fill('');
  await expect(main.getByText('Search your workspace')).toBeVisible();
  await evidence(page, 'search-page-empty');
});

test('search results in dark mode (evidence only)', async ({ page }) => {
  test.skip(!process.env.E2E_SCREENSHOTS, 'screenshots only');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.setItem('oat-theme', 'dark'));
  const word = uniqueWord();
  await apiCreateDocument(page, { title: `Roadmap ${word}`, visibility: 'workspace' });
  const call = await apiCreateDocument(page, { title: 'Weekly sync', kind: 'meeting' });
  await addTranscript(page, call.id, [
    [3_723_000, `Let us revisit the ${word} roadmap next week.`],
  ]);
  await page.goto('/home');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type(word);
  await expect(page.getByTestId('search-result-transcript')).toContainText('1:02:03');
  await evidence(page, 'palette-results-dark');
  await page.goto(`/search?q=${word}&tab=transcripts`);
  await expect(page.getByTestId('search-page-transcript')).toHaveCount(1);
  await evidence(page, 'search-page-transcripts-dark');
});
