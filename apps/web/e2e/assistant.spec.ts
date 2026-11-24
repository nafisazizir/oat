import { mkdirSync, readFileSync } from 'node:fs';

import { createDb, meeting, transcriptSegment } from '@oat/db';
import { indexDocument } from '@oat/indexing/indexer';
import { hashEmbedding } from '@oat/mocks';
import type { Page } from '@playwright/test';

import type { DocumentDetail } from '../src/lib/api-types';
import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, apiUpdateDocument, unique } from './docs-helpers';
import { expect, test } from './fixtures';
import { databaseUrlFile, EVIDENCE_6_4 } from './paths';
import { verifyFeatureSurface } from './feature-surfaces';

/**
 * Task 6.4 in the browser, against the mock LLM's scripted tool loop (in-process in `web-server.ts`): the note
 * panel streams an answer with citation chips that jump to the transcript moment and the note block; an
 * `updateDocument` proposal needs approval and shows up in the editor; a stale one offers a re-run; the global
 * Assistant page answers across the workspace and its chips open the cited note; a 429 says when to retry.
 *
 * Meetings, transcripts and the search index have no web API (desktop sync / indexing worker), so they are
 * written into the e2e database directly; embeddings use the mock provider's own hashing, so they match the
 * query embeddings the app gets from the mock.
 */

test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page, baseURL }) => {
  // The dev-only Next.js indicator sits over the panel's send/stop button in the bottom-right corner.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal { display: none !important; }';
      document.head.append(style);
    });
  });
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-assistant'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
});

const embeddingModel: Parameters<typeof indexDocument>[0]['embeddingModel'] = {
  specificationVersion: 'v4',
  provider: 'oat-e2e',
  modelId: 'mock-embedding',
  maxEmbeddingsPerCall: 2048,
  supportsParallelCalls: true,
  doEmbed: async ({ values }) => ({
    embeddings: values.map((v) => hashEmbedding(v)),
    usage: { tokens: 0 },
    warnings: [],
  }),
};

const block = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});

const LINES = [
  ['system', 'The pilot starts in the Lakeside clinic on the first of March.'],
  ['mic', 'Great, I will send the onboarding checklist for the Lakeside pilot.'],
] as const;

/** A meeting note with two blocks and a two-line transcript, indexed for search. */
async function seedNote(page: Page): Promise<{ doc: DocumentDetail; segments: string[] }> {
  const created = await apiCreateDocument(page, {
    title: unique('Lakeside pilot'),
    kind: 'meeting',
  });
  const res = await apiUpdateDocument(page, created.id, {
    baseVersion: created.version,
    contentJson: {
      type: 'doc',
      content: [
        block('b-start', 'Lakeside pilot starts on the first of March.'),
        block('b-owner', 'Riley owns the onboarding checklist for the pilot.'),
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const doc = (await res.json()) as DocumentDetail;
  const port = new URL(page.url()).port || '80';
  const db = createDb(readFileSync(databaseUrlFile(port), 'utf8').trim(), { max: 1 });
  const segments = LINES.map((_, i) => `${doc.id}-s${i}`);
  try {
    const [m] = await db
      .insert(meeting)
      .values({ documentId: doc.id, startedAt: new Date('2026-11-12T10:00:00Z') })
      .returning();
    await db.insert(transcriptSegment).values(
      LINES.map(([source, text], i) => ({
        id: segments[i]!,
        meetingId: m!.id,
        source,
        startMs: 65_000 + i * 7_000,
        endMs: 70_000 + i * 7_000,
        text,
      })),
    );
    await indexDocument({ db, embeddingModel }, doc.id);
  } finally {
    await db.$client.end();
  }
  return { doc, segments };
}

async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_6_4, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `${EVIDENCE_6_4}${name}-${scheme}.png`,
      style: 'nextjs-portal { display: none !important; }',
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const panel = (page: Page) => page.getByTestId('assistant-panel');
const editor = (page: Page) => page.getByRole('textbox', { name: 'Note' });

async function ask(page: Page, text: string) {
  const input = page.getByTestId('chat-input');
  await input.fill(text);
  await input.press('Enter');
}

/** The newest assistant answer, once it has been saved and its sources resolved. */
function lastAnswer(page: Page) {
  return page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
}

test('document shortcuts preserve editor links and ignore shifted app shortcuts', async ({
  page,
}) => {
  const { doc } = await seedNote(page);
  await page.goto(`/d/${doc.id}`);
  await expect(page.getByTestId('assistant-toggle')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+j');
  await expect(panel(page)).toBeHidden();
  await editor(page).selectText();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('textbox', { name: 'Link URL' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Title' }).click();
  await page.keyboard.press('ControlOrMeta+Shift+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeHidden();
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel(page)).toBeVisible();
});

test('note panel: streamed answer with citation chips that jump to the transcript and the block', async ({
  page,
}) => {
  const { doc, segments } = await seedNote(page);
  await page.goto(`/d/${doc.id}`);

  // ⌘J opens the panel; the toggle button does too.
  const launcher = page.getByTestId('assistant-toggle');
  await expect(launcher).toBeVisible();
  const collapsed = (await launcher.boundingBox())!;
  await expect(launcher).toHaveCSS('height', '40px');
  expect(
    await launcher.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius)),
  ).toBeGreaterThanOrEqual(20);
  await page.keyboard.press('ControlOrMeta+j');
  await expect(panel(page)).toBeVisible();
  expect(
    await panel(page).evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius)),
  ).toBeGreaterThanOrEqual(24);
  await expect(page.getByTestId('note-dock-row')).toBeHidden();
  const composer = panel(page).locator('[data-slot="input-group"]');
  await expect(composer).toHaveAttribute('data-size', 'lg');
  await expect(composer).toHaveCSS('height', '40px');
  await expect.poll(() => composer.boundingBox()).toEqual(collapsed);
  expect(
    await composer.evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius)),
  ).toBeGreaterThanOrEqual(20);
  const recipes = panel(page).getByTestId('chat-suggestions');
  await expect(recipes).toBeVisible();
  expect(
    await recipes
      .getByRole('button')
      .first()
      .evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius)),
  ).toBeGreaterThanOrEqual(16);

  await ask(page, 'When does the Lakeside pilot start and who sends the onboarding checklist?');
  // Tool activity while it searches, then the answer streams in.
  await expect(panel(page).getByTestId('tool-activity').first()).toBeVisible();
  const answer = lastAnswer(page);
  await expect(answer.getByTestId('tool-activity').first()).toHaveAttribute('data-state', 'done');
  await expect(answer.getByTestId('chat-answer')).toContainText('Lakeside');
  const chips = answer.getByTestId('citation-chip');
  await expect(chips.first()).toHaveAttribute('data-state', 'ready');
  await expect(
    answer.locator('[data-testid="citation-chip"][data-kind="seg"]').first(),
  ).toBeVisible();
  await expect(
    answer.locator('[data-testid="citation-chip"][data-kind="block"]').first(),
  ).toBeVisible();
  await evidence(page, 'note-panel-answer');

  // A transcript chip opens the transcript at that moment, temporarily hiding the chat in the dock.
  const seg = answer.locator('[data-testid="citation-chip"][data-kind="seg"]').first();
  await seg.click();
  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}\\?t=\\d+&seg=`));
  const reader = page.getByTestId('transcript-panel');
  await expect(reader).toBeVisible();
  const focused = reader.locator('[data-focused]');
  await expect(focused).toHaveCount(1);
  expect(segments).toContain(await focused.getAttribute('data-segment-id'));
  await expect(focused).toBeInViewport();
  await expect(panel(page)).toBeHidden();
  await expect(reader.locator('footer').getByTestId('transcript-toggle')).toBeVisible();
  await evidence(page, 'transcript-moment');
  await reader.getByRole('button', { name: 'Hide transcript' }).click();
  await expect(panel(page)).toBeVisible();

  // A block chip scrolls the note to that block and highlights it.
  await answer.locator('[data-testid="citation-chip"][data-kind="block"]').first().click();
  const highlighted = await page
    .locator('[data-highlight-block]')
    .getAttribute('data-highlight-block');
  expect(['b-start', 'b-owner']).toContain(highlighted);
  await expect(editor(page).locator(`[data-id="${highlighted}"]`)).toBeInViewport();

  // The conversation is kept: reopen the panel after closing it and pick it from the history.
  // Closing hands focus back to the toggle; Escape inside the panel closes it too.
  await page.getByRole('button', { name: 'Close assistant' }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.getByTestId('assistant-toggle')).toBeFocused();
  await page.getByTestId('assistant-toggle').click();
  await expect(page.getByTestId('chat-input')).toBeFocused();
  await expect.poll(() => composer.boundingBox()).toEqual(collapsed);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(page.getByTestId('assistant-toggle')).toBeFocused();
  await page.getByTestId('assistant-toggle').click();
  await page.getByRole('button', { name: 'Previous chats' }).click();
  await page.getByRole('menuitem', { name: /When does the Lakeside pilot start/ }).click();
  await expect(lastAnswer(page).getByTestId('citation-chip').first()).toHaveAttribute(
    'data-state',
    'ready',
  );

  // The same note thread from /assistant: follow-ups keep the note's scope.
  await page.getByTestId('nav-assistant').click();
  await expect(page).toHaveURL(/\/assistant$/);
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /When does the Lakeside pilot start/ })
    .click();
  await expect(page.getByTestId('note-thread-banner')).toBeVisible();
  await ask(page, 'Who owns the onboarding checklist?');
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(2);
  await expect(lastAnswer(page).getByTestId('citation-chip').first()).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(page.getByTestId('chat-session')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('chat-error')).toHaveCount(0);
  await evidence(page, 'assistant-note-thread');
});

test('a ?block= link opened directly scrolls to and highlights the block (server-rendered)', async ({
  page,
}) => {
  const { doc } = await seedNote(page);
  await page.goto(`/d/${doc.id}?block=b-owner`);
  await expect(page.locator('[data-highlight-block]')).toHaveAttribute(
    'data-highlight-block',
    'b-owner',
  );
  await expect(editor(page).locator('[data-id="b-owner"]')).toBeInViewport();
});

test('below lg the page assistant is a modal sheet: focus stays inside, Escape closes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  const doc = await apiCreateDocument(page, { title: 'Assistant sheet fixture', kind: 'page' });
  await page.goto(`/d/${doc.id}`);
  await page.getByTestId('assistant-toggle').click();
  const dialog = page.getByRole('dialog', { name: 'Assistant' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('chat-input')).toBeFocused();
  await evidence(page, 'panel-sheet');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab');
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)), {
        message: 'focus stays in the sheet after the focus guard redirects it',
      })
      .toBe(true);
  }
  // One Escape closes the sheet, even while a tooltip of the button in focus is showing (9.3: the tooltip
  // used to swallow the first press, which made this test flaky under load).
  const newChat = dialog.getByRole('button', { name: 'New chat' });
  await newChat.focus();
  // (By name: the tooltip of the button focused before may still be fading out.)
  await expect(page.getByRole('tooltip', { name: 'New chat' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('assistant-toggle')).toBeFocused();

  // The sheet isn't remembered below lg: another note opens without it (it would cover the note).
  const other = await seedNote(page);
  await page.getByTestId('assistant-toggle').click();
  await expect(dialog).toBeVisible();
  await page.goto(`/d/${other.doc.id}`);
  await expect(page.getByTestId('assistant-toggle')).toBeVisible();
  await expect(dialog).toBeHidden();
});

test.describe('with expected HTTP errors', () => {
  // The 409 (stale approval) and 429 (rate limit) responses are logged by the browser as failed resources.
  test.use({ allowConsoleErrors: true });

  test('a proposed edit needs approval, then shows in the editor; a stale one offers a re-run', async ({
    page,
  }) => {
    const { doc } = await seedNote(page);
    await page.goto(`/d/${doc.id}`);
    await page.getByTestId('assistant-toggle').click();

    const propose = (find: string, replace: string) =>
      ask(
        page,
        `mock:tool updateDocument ${JSON.stringify({ documentId: doc.id, edits: [{ find, replace }], summary: 'Fix the date' })}`,
      );

    await propose('first of March', 'second of March');
    const card = lastAnswer(page).getByTestId('proposal-card');
    await expect(card).toHaveAttribute('data-status', 'pending');
    // The card names the document and shows the before/after text, not just the model's summary.
    await expect(card.getByTestId('proposal-document')).toHaveText(doc.title);
    await expect(card.locator('[data-diff="before"]')).toContainText('first of March');
    await expect(card.locator('[data-diff="after"]')).toContainText('second of March');
    // Nothing changed yet.
    await expect(editor(page)).toContainText('first of March');
    await evidence(page, 'proposal-pending');

    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveAttribute('data-status', 'applied');
    await expect(editor(page)).toContainText('Lakeside pilot starts on the second of March.');
    // The editor adopted the new version: typing keeps saving without a conflict.
    await editor(page).locator('[data-id="b-owner"]').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Confirmed.');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

    // A proposal made before the note changed again can't be applied: it says so and offers a re-run.
    await propose('Riley owns', 'Dana owns');
    const second = lastAnswer(page).getByTestId('proposal-card');
    await expect(second).toHaveAttribute('data-status', 'pending');
    await editor(page).locator('[data-id="b-start"]').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Moved?');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    await second.getByRole('button', { name: 'Approve' }).click();
    await expect(second).toHaveAttribute('data-status', 'stale');
    await expect(second.getByRole('status')).toContainText(
      'The note changed since this suggestion',
    );
    await expect(second.getByRole('button', { name: 'Re-run' })).toBeVisible();
    await expect(editor(page)).toContainText('Riley owns');
    await evidence(page, 'proposal-stale');
  });

  test('global Assistant page: answers across the workspace, chips open the cited note; 429 says when', async ({
    page,
  }) => {
    const { doc } = await seedNote(page);
    await page.getByTestId('nav-assistant').click();
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByTestId('chat-empty')).toBeVisible();

    await verifyFeatureSurface(page, 'assistant-empty');

    await ask(page, 'When does the Lakeside pilot start?');
    const answer = lastAnswer(page);
    await expect(answer.getByTestId('citation-chip').first()).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect(page.getByTestId('thread-list')).toContainText(
      'When does the Lakeside pilot start?',
    );
    await evidence(page, 'assistant-page');
    await verifyFeatureSurface(page, 'assistant-answer');

    // Rate limited: the server's 429 (mocked here) becomes a message with the wait.
    await page.route('**/api/chat', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'retry-after': '42' },
        body: JSON.stringify({
          error: { code: 'rate_limited', message: 'Slow down.' },
          retryAfter: 42,
        }),
      }),
    );
    await ask(page, 'And who owns the checklist?');
    await expect(page.getByTestId('chat-error')).toHaveAttribute('data-kind', 'rate_limited');
    await expect(page.getByTestId('chat-error')).toContainText('Try again in 42 s');
    await evidence(page, 'rate-limited');
    await page.unroute('**/api/chat');

    // A chip opens the cited note (transcript moment or block).
    await answer.getByTestId('citation-chip').first().click();
    await expect(page).toHaveURL(new RegExp(`/d/${doc.id}\\?(t=\\d+&seg=|block=)`));
    const kind = new URL(page.url()).searchParams.has('seg') ? 'seg' : 'block';
    if (kind === 'seg') {
      await expect(page.getByTestId('transcript-panel').locator('[data-focused]')).toBeVisible();
    } else {
      await expect(page.locator('[data-highlight-block]')).toBeVisible();
    }

    const chats = page.getByTestId('chats-section');
    const recent = chats.getByRole('link', {
      name: 'When does the Lakeside pilot start?',
      exact: true,
    });
    await recent.click();
    await expect(page).toHaveURL(/\/assistant\?thread=/);
    await expect(recent).toHaveAttribute('data-active', '');
    await expect(lastAnswer(page)).toBeVisible();
    await chats.hover();
    await chats.getByRole('link', { name: 'New chat' }).click();
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByTestId('chat-empty')).toBeVisible();
  });
});

test('an active follow-up cannot be interrupted by opening it in Assistant', async ({ page }) => {
  const { doc } = await seedNote(page);
  await page.goto(`/d/${doc.id}`);
  await page.getByTestId('assistant-toggle').click();
  const expand = page.getByRole('button', { name: 'Open conversation in Assistant' });
  await ask(page, 'Summarize the pilot');
  await expect(expand).toBeEnabled();

  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/chat', async (route) => {
    await hold;
    await route.continue();
  });
  try {
    await ask(page, 'Who owns the checklist?');
    await expect(page.getByTestId('chat-stop')).toBeVisible();
    await expect(expand).toBeDisabled({ timeout: 2_000 });
  } finally {
    release();
  }
  await expect(page.getByTestId('chat-session')).toHaveAttribute('data-status', 'ready');
  await expect(lastAnswer(page).getByTestId('citation-chip').first()).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(expand).toBeEnabled();
  await expand.click();
  await expect(page).toHaveURL(/\/assistant/);
  await expect(page.getByText('Who owns the checklist?', { exact: true })).toBeVisible();
});

test('stop aborts a streaming answer', async ({ page }) => {
  const { doc } = await seedNote(page);
  await page.goto(`/d/${doc.id}`);
  await page.getByTestId('assistant-toggle').click();
  // Slow the stream down enough to press Stop mid-answer.
  await page.route('**/api/chat', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.fulfill({ response });
  });
  await ask(page, 'Summarize the pilot');
  await expect(page.getByTestId('chat-stop')).toBeVisible();
  await page.getByTestId('chat-stop').click();
  await expect(page.getByTestId('chat-session')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
