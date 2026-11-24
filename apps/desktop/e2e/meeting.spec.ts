/**
 * Task 3.4 e2e: the meeting note on the desktop. "New meeting note" creates the note and records the
 * `standup-short` fixture (FileSource, never real capture); I type notes and add an attendee while it
 * transcribes; after Stop the notes, the attendee and the transcript are in the local database and — through
 * sync (2.6) — in Postgres; the same note opened on the web shows the notes and the transcript; an attendee
 * added on the web reaches the desktop. Relaunched, the past meeting opens from the sidebar with its stored
 * transcript. Screenshots (light + dark) with `E2E_SCREENSHOTS=1`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { databaseUrlFile } from '../../web/e2e/paths';
import {
  closeAttendees,
  evidence,
  home,
  launchApp,
  openAttendees,
  openTranscript,
  stopRecording,
  scaled,
  signInDesktop,
  signInOnWeb,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

const FIXTURE = 'standup-short';
const NOTE = 'Decision: ship the beta on Friday';
const LAST_WORDS = 'typed right before quitting';

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;
let sql: postgres.Sql;
const email = uniqueAddress('meeting');

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-meeting-'));
  sql = postgres(readFileSync(databaseUrlFile(new URL(webUrl).port), 'utf8').trim(), {
    max: 1,
    onnotice: () => {},
  });
  // `next dev` compiles a route on its first request: do it now, not while recording.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/sync/pull`);
  await fetch(`${webUrl}/api/sync/push`, { method: 'POST', headers: { origin: webUrl } });
});

test.afterAll(async () => {
  await app?.close();
  await sql?.end();
  rmSync(userDataDir, { recursive: true, force: true });
});

async function launch(env: Record<string, string> = {}) {
  await app?.close();
  ({ app, page } = await launchApp(userDataDir, webUrl, {
    OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
    ...env,
  }));
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  return app!;
}

const invoke = <T>(p: Page, channel: string, payload?: unknown) =>
  p.evaluate(
    async ([c, body]) => {
      const oat = window.oat as unknown as {
        invoke(
          c: string,
          b?: unknown,
        ): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
      };
      const r = body === undefined ? await oat.invoke(c) : await oat.invoke(c, body);
      if (!r.ok) throw new Error(r.error!.message);
      return r.value;
    },
    [channel, payload] as const,
  ) as Promise<T>;

/** Desktop screenshots in both schemes (the renderer follows `prefers-color-scheme`). */
async function shots(p: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    if (scheme === 'dark') await expect(p.locator('html')).toHaveClass(/dark/);
    else await expect(p.locator('html')).not.toHaveClass(/dark/);
    await evidence(p, `${name}-${scheme}`, '3.4');
  }
  await p.emulateMedia({ colorScheme: 'light' });
}

let documentId: string;
let meetingId: string;

test('jot during a fixture recording → notes + transcript stored locally, synced, shown on the web', async ({
  browser,
}) => {
  test.setTimeout(scaled(180_000));
  const electronApp = await launch();
  await signInDesktop(electronApp, page, browser, email);

  // Nothing open yet: Home without notes, an empty list.
  await expect(home(page)).toContainText('No notes yet');
  await expect(page.getByTestId('tree-section-private').getByTestId('tree-item')).toHaveCount(0);
  await shots(page, 'desktop-start');

  // "New meeting note": the note is created and opened, and the recording runs into it.
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const title = page.getByTestId('note-title');
  await expect(title).toHaveValue(/^Meeting, /);
  await expect(page.getByTestId('meeting-list-item')).toHaveCount(1);
  await expect(page.getByTestId('meeting-list-item').getByLabel('Recording')).toBeVisible();
  await expect(page.getByTestId('meeting-time')).toHaveAttribute('data-in-progress', 'true');
  ({ meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get'));
  documentId = (await page.getByTestId('meeting-list-item').getAttribute('data-document-id'))!;

  // Jot notes and rename the note while it transcribes.
  const notes = page.getByRole('textbox', { name: 'My notes' });
  await notes.click();
  await page.keyboard.type(NOTE);
  await title.fill('Beta launch sync');
  await expect(page.getByTestId('meeting-list-item')).toContainText('Beta launch sync');
  await expect(page.getByText('Saved on this Mac')).toHaveCount(0);

  // An attendee added by hand (over the bridge: the header has no add for now; just me shows nothing).
  await expect(page.getByTestId('attendees-toggle')).toHaveCount(0);
  await invoke(page, 'meeting:add-participant', {
    documentId,
    name: 'Dana Scully',
    email: 'dana@example.com',
  });
  await expect(page.getByTestId('attendees-toggle')).toHaveText('Dana Scully');

  // The transcript is closed until asked for; opened, the live transcript fills the panel beside the note.
  await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
  const panel = await openTranscript(page);
  await expect(
    panel.locator('[data-testid=transcript-segment][data-source=mic]').first(),
  ).toBeVisible({
    timeout: scaled(20_000),
  });
  await expect(
    panel.locator('[data-testid=transcript-segment][data-source=system]').first(),
  ).toBeVisible({ timeout: scaled(20_000) });
  await panel.getByRole('button', { name: 'Copy transcript' }).click();
  await expect(panel.getByRole('status')).toHaveText('Transcript copied');
  expect(await electronApp.evaluate(({ clipboard }) => clipboard.readText())).not.toBe('');
  await shots(page, 'desktop-live');

  // Collapse the transcript sheet and reopen it from the dock.
  await page.getByRole('button', { name: 'Hide transcript' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId('transcript-toggle').click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy transcript' })).toBeEnabled();

  // Let a few finals arrive, then stop.
  await expect
    .poll(
      async () =>
        (
          await invoke<{ segments: { isFinal: boolean }[] }>(page, 'transcript:get')
        ).segments.filter((s) => s.isFinal).length,
      { timeout: scaled(40_000) },
    )
    .toBeGreaterThanOrEqual(6);
  await stopRecording(page);
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });
  await expect(page.getByTestId('meeting-time')).not.toHaveAttribute('data-in-progress');
  await expect(page.getByRole('button', { name: 'Continue recording' })).toBeVisible();

  // Stored on this Mac: notes, title, attendee, the finals.
  const local = await invoke<{
    title: string;
    contentJson: unknown;
    participants: { name: string }[];
    endedAt: string | null;
  }>(page, 'meeting:get', { documentId });
  expect(local.title).toBe('Beta launch sync');
  expect(JSON.stringify(local.contentJson)).toContain(NOTE);
  expect(local.participants.map((p) => p.name)).toEqual(['Dana Scully']);
  expect(local.endedAt).not.toBeNull();
  const stored = (
    await invoke<{ segments: { id: string; text: string }[] }>(page, 'meeting:transcript', {
      documentId,
    })
  ).segments;
  expect(stored.length).toBeGreaterThanOrEqual(6);

  // Synced into Postgres.
  await expect
    .poll(async () => (await invoke<{ pending: number }>(page, 'sync:now')).pending, {
      timeout: scaled(30_000),
    })
    .toBe(0);
  const [doc] = await sql<{ title: string; content: string }[]>`
    select title, content_json::text as content from document where id = ${documentId}`;
  expect(doc).toMatchObject({ title: 'Beta launch sync' });
  expect(doc!.content).toContain(NOTE);
  expect(
    (await sql`select name from participant where meeting_id = ${meetingId}`).map((r) => r.name),
  ).toEqual(['Dana Scully']);
  const [counted] = await sql<{ n: number }[]>`
    select count(*)::int as n from transcript_segment where meeting_id = ${meetingId}`;
  expect(counted?.n).toBe(stored.length);
  await shots(page, 'desktop-stopped');

  // The web shows the same note: my notes, the attendee, the transcript.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const web = await context.newPage();
  try {
    await web.goto(`${webUrl}/sign-in`);
    await signInOnWeb(web, email);
    await web.goto(`${webUrl}/d/${documentId}`);
    await expect(web.locator('div[hidden][id^="S:"]')).toHaveCount(0);
    await expect(web.getByTestId('document-title')).toHaveValue('Beta launch sync');
    await expect(web.getByRole('textbox', { name: 'Note' })).toContainText(NOTE);
    await openAttendees(web);
    await expect(web.getByTestId('participant-chip')).toHaveText(/Dana Scully/);
    await closeAttendees(web);
    const webPanel = await openTranscript(web);
    await expect(webPanel.getByTestId('transcript-segment').first()).toBeVisible();
    await expect(webPanel).toContainText(stored[0]!.text);
    for (const scheme of ['light', 'dark'] as const) {
      await web.emulateMedia({ colorScheme: scheme });
      await evidence(web, `web-from-desktop-${scheme}`, '3.4');
    }

    // An attendee added on the web reaches the desktop with the next sync.
    const added = await web.request.post(`${webUrl}/api/documents/${documentId}/participants`, {
      headers: { origin: webUrl },
      data: { name: 'Fox Mulder', email: null },
    });
    expect(added.status()).toBe(201);
  } finally {
    await context.close();
  }
  await openAttendees(page);
  await expect
    .poll(
      async () => {
        await invoke(page, 'sync:now');
        return page.getByTestId('participant-chip').count();
      },
      { timeout: scaled(30_000) },
    )
    .toBe(2);
  await expect(page.getByTestId('participant-chip').nth(1)).toContainText('Fox Mulder');
  await closeAttendees(page);
  await expect(page.getByTestId('attendees-toggle')).toHaveAttribute('data-count', '2');

  // Quit right after typing (within the autosave debounce): the app writes it before quitting.
  await page.getByRole('textbox', { name: 'My notes' }).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(LAST_WORDS);
  await app!.close();
  app = undefined;
});

test('relaunched: the past meeting opens from the sidebar with its stored transcript', async () => {
  test.setTimeout(scaled(90_000));
  await launch();
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  // Home lists the note too.
  await expect(home(page).getByTestId('home-note-row')).toHaveText(/Beta launch sync/);
  const item = page.getByTestId('meeting-list-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Beta launch sync');
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('note-title')).toHaveValue('Beta launch sync');
  await expect(page.getByRole('textbox', { name: 'My notes' })).toContainText(NOTE);
  await expect(page.getByRole('textbox', { name: 'My notes' })).toContainText(LAST_WORDS);
  // Recorded on this Mac and mine: it can be continued after the relaunch (offset from the stored parts).
  await expect(page.getByRole('button', { name: 'Continue recording' })).toBeVisible();
  await openAttendees(page);
  await expect(page.getByTestId('participant-chip')).toHaveCount(2);
  await closeAttendees(page);
  const stored = (await invoke<{ segments: unknown[] }>(page, 'meeting:transcript', { documentId }))
    .segments;
  // The transcript panel was left open before the relaunch: that choice is remembered.
  const panel = page.getByTestId('transcript-panel');
  await expect(panel.getByTestId('transcript')).toHaveAttribute(
    'data-count',
    String(stored.length),
  );
  await expect(panel.getByTestId('transcript-segment').first()).toBeVisible();
  // A past note is not live: no "Jump to live".
  await expect(page.getByTestId('jump-to-live')).toHaveCount(0);
  await shots(page, 'desktop-past');
});
