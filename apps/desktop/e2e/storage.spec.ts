/**
 * Task 3.8 e2e: Settings → Storage against the built app. The archive holds synthetic recordings seeded
 * after sign-in (rows in the never-wiped audio index + sparse `.opus` files dated weeks ago, D-28): two of the
 * signed-in account, one of another account and one unattributed from before D-30; plus one real meeting
 * recorded from the `standup-short` fixture (FileSource → archive + transcript in the local database). No
 * microphone, no real capture, no external service.
 *
 * Covered: the list (sizes, parts, titles, sort), the "Other accounts" aggregate (no actions, never deleted),
 * "Recording" + no delete while that meeting records, "Show in Finder" (stubbed `shell.showItemInFolder`),
 * delete one meeting's audio (files gone, transcript still in the local database, audio status `deleted`),
 * and a size cap that — after a confirmation — deletes this account's oldest meeting.
 */
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AudioIndex } from '@oat/local-store';
import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import {
  evidence,
  launchApp,
  openTranscript,
  scaled,
  signInDesktop,
  writeEvidence,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');

const FIXTURE = 'standup-short';
const DAY = 24 * 60 * 60 * 1000;
const MB = 1_000_000;

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;

/** A recording made elsewhere in time: one part, mic + system, `mb` (sparse) per file, `daysAgo`. */
async function seedMeeting(
  index: AudioIndex,
  meetingId: string,
  daysAgo: number,
  mb: number,
  userId: string | null,
) {
  const startedAt = Date.now() - daysAgo * DAY;
  const folder = join(userDataDir, 'audio', meetingId);
  mkdirSync(folder, { recursive: true });
  for (const source of ['mic', 'system'] as const) {
    const path = join(folder, `${source}.opus`);
    const fd = openSync(path, 'w');
    writeSync(fd, 'OggS');
    ftruncateSync(fd, mb * MB); // sparse: the size counts, the disk stays empty
    closeSync(fd);
    const mtime = new Date(startedAt + 30 * 60_000);
    utimesSync(path, mtime, mtime);
    await index.insert({
      id: `${meetingId}-${source}`,
      meetingId,
      source,
      part: 1,
      offsetMs: 0,
      path,
      codec: 'opus',
      sampleRate: 16000,
      startedAt,
      durationMs: 30 * 60_000,
      bytes: mb * MB,
      status: 'complete',
      userId,
    });
  }
}

test.beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-storage-'));
});

/**
 * Seeds the never-wiped audio index next to the running app (its own connection; WAL): two recordings of the
 * signed-in account, one of another account and one from before D-30 that no account owns.
 */
async function seed(userId: string) {
  const index = new AudioIndex({ path: join(userDataDir, 'audio-index.sqlite') });
  try {
    await seedMeeting(index, 'seed-old', 20, 300, userId); // 600 MB, oldest
    await seedMeeting(index, 'seed-mid', 10, 150, userId); // 300 MB
    await seedMeeting(index, 'other-account', 30, 40, 'someone-else'); // 80 MB
    await seedMeeting(index, 'legacy-unknown', 60, 10, null); // 20 MB
  } finally {
    index.close();
  }
}

test.afterAll(async () => {
  await app?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

const invoke = (p: Page, channel: string, payload?: unknown) =>
  p.evaluate(
    ([c, body]) =>
      (window.oat.invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(
        c as string,
        ...(body === undefined ? [] : [body]),
      ),
    [channel, payload] as const,
  ) as Promise<{ ok: boolean; value?: unknown; error?: { code: string } }>;

const rows = (p: Page) => p.getByTestId('storage-meeting');
const rowIds = async (p: Page) =>
  rows(p).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.meetingId));

/** Final transcript segments of a meeting in the account's local database (read-only). */
function localSegments(userId: string, meetingId: string): number {
  const db = new DatabaseSync(join(userDataDir, `oat-${userId}.sqlite`), { readOnly: true });
  try {
    const row = db
      .prepare('SELECT count(*) AS n FROM transcript_segment WHERE meeting_id = ?')
      .get(meetingId) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

test('storage settings: list, show in Finder, delete audio (transcript kept), size cap', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(scaled(150_000));
  ({ app, page } = await launchApp(userDataDir, baseURL!, { OAT_AUDIO_SOURCE: `file:${FIXTURE}` }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1000, 720));
  await app.evaluate(({ shell }) => {
    const g = globalThis as { __oatShown?: string[] };
    g.__oatShown = [];
    shell.showItemInFolder = (path: string) => void g.__oatShown!.push(path);
  });
  await signInDesktop(app, page, browser, uniqueAddress('storage'));
  const state = (await invoke(page, 'state:get')).value as {
    state: { auth: { user: { id: string } } };
  };
  const userId = state.state.auth.user.id;
  await seed(userId);

  // A real meeting: record the fixture until a few finals are saved.
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const meetingId = ((await invoke(page, 'recording:get')).value as { meetingId: string })
    .meetingId;
  await openTranscript(page);
  await expect(
    page.locator('[data-testid=transcript-segment][data-final=true]').nth(2),
  ).toBeVisible({ timeout: scaled(30_000) });

  // While it records: listed as "Recording", and its audio can't be deleted.
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  await page.getByTestId('settings-section-storage').click();
  await expect(page.getByTestId('storage-settings')).toBeVisible();
  const live = page.locator(`[data-testid=storage-meeting][data-meeting-id="${meetingId}"]`);
  await expect(live).toContainText('Recording');
  await expect(live.getByRole('button', { name: 'Delete audio' })).toBeDisabled();
  expect(await invoke(page, 'storage:delete-audio', { meetingId })).toMatchObject({
    ok: false,
    error: { code: 'invalid_state' },
  });
  expect((await invoke(page, 'storage:audio-status', { meetingId })).value).toMatchObject({
    status: 'recording',
  });
  await evidence(page, 'storage-while-recording', '3.8');

  const stopped = await invoke(page, 'recording:stop');
  expect(stopped.ok).toBe(true);
  const segments = localSegments(userId, meetingId);
  expect(segments).toBeGreaterThan(2);

  // The list: three meetings, newest first, the real one titled from its note.
  await expect(live).not.toContainText('Recording');
  await expect(rows(page)).toHaveCount(3);
  expect(await rowIds(page)).toEqual([meetingId, 'seed-mid', 'seed-old']);
  await expect(live).toContainText(/Meeting, /);
  await expect(live.getByRole('button', { name: 'Delete audio' })).toBeEnabled();
  await expect(rows(page).nth(1)).toContainText('Untitled recording');
  await expect(rows(page).nth(1).getByTestId('storage-meeting-size')).toHaveText('300 MB');
  await expect(rows(page).nth(2).getByTestId('storage-meeting-size')).toHaveText('600 MB');
  await expect(page.getByTestId('storage-total')).toHaveText('900 MB');
  // D-30: other accounts' audio (and unclaimed old audio) is one aggregate row, no actions.
  const others = page.getByTestId('storage-other-accounts');
  await expect(others).toContainText('2 meetings');
  await expect(others).toContainText('100 MB');
  await expect(others.getByRole('button')).toHaveCount(0);
  expect(await invoke(page, 'storage:delete-audio', { meetingId: 'other-account' })).toMatchObject({
    ok: true,
    value: { deleted: false, alreadyGone: true },
  });
  await evidence(page, 'storage-list', '3.8');

  // Sort by size, then back to date.
  await page.getByTestId('storage-sort').click();
  await page.getByRole('option', { name: 'Largest first' }).click();
  expect(await rowIds(page)).toEqual(['seed-old', 'seed-mid', meetingId]);
  await page.getByTestId('storage-sort').click();
  await page.getByRole('option', { name: 'Oldest first' }).click();
  expect(await rowIds(page)).toEqual(['seed-old', 'seed-mid', meetingId]);
  await page.getByTestId('storage-sort').click();
  await page.getByRole('option', { name: 'Newest first' }).click();
  expect(await rowIds(page)).toEqual([meetingId, 'seed-mid', 'seed-old']);

  // Show in Finder: main reveals that meeting's folder (inside the audio root), nothing else.
  await live.getByRole('button', { name: 'Show in Finder' }).click();
  await expect
    .poll(() => app!.evaluate(() => (globalThis as { __oatShown?: string[] }).__oatShown))
    .toEqual([join(userDataDir, 'audio', meetingId)]);
  expect(await invoke(page, 'storage:show', { meetingId: '../..' })).toMatchObject({
    ok: false,
    error: { code: 'invalid_payload' },
  });

  // Delete the real meeting's audio: files gone, transcript still there.
  const audioDir = join(userDataDir, 'audio', meetingId);
  expect(existsSync(join(audioDir, 'mic.opus'))).toBe(true);
  await live.getByRole('button', { name: 'Delete audio' }).click();
  const dialog = page.getByTestId('delete-audio-dialog');
  await expect(dialog).toContainText('The transcript and your notes stay');
  await evidence(page, 'storage-delete-confirm', '3.8');
  await dialog.getByRole('button', { name: 'Delete audio' }).click();
  await expect(dialog).toBeHidden();
  await expect(rows(page)).toHaveCount(2);
  expect(existsSync(audioDir)).toBe(false);
  expect(localSegments(userId, meetingId)).toBe(segments);
  expect((await invoke(page, 'storage:audio-status', { meetingId })).value).toMatchObject({
    status: 'deleted',
  });
  await expect(page.getByTestId('storage-settings')).toContainText('1 with audio deleted');

  // Retention: cap at 0.5 GB → the dry run names the oldest meeting; saving deletes it.
  await page.getByTestId('retention-kind').click();
  await page.getByRole('option', { name: 'Limit total size to…' }).click();
  await page.getByLabel('Gigabytes').fill('0.5');
  await expect(page.getByTestId('retention-preview')).toHaveText(
    'Would free 600 MB now (1 meeting).',
  );
  expect(existsSync(join(userDataDir, 'audio', 'seed-old', 'mic.opus'))).toBe(true); // dry run
  await evidence(page, 'storage-retention-preview', '3.8');
  await page.getByTestId('retention-save').click();
  // Saving would delete audio now: confirm first.
  const confirm = page.getByTestId('retention-confirm');
  await expect(confirm).toContainText('Delete the audio of 1 meeting?');
  await expect(confirm).toContainText('removes 600 MB');
  await evidence(page, 'storage-retention-confirm', '3.8');
  await confirm.getByRole('button', { name: 'Delete audio and save' }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(await rowIds(page)).toEqual(['seed-mid']);
  expect(existsSync(join(userDataDir, 'audio', 'seed-old'))).toBe(false);
  expect(existsSync(join(userDataDir, 'audio', 'seed-mid', 'mic.opus'))).toBe(true);
  await expect(page.getByTestId('storage-total')).toHaveText('300 MB');
  for (const id of ['other-account', 'legacy-unknown']) {
    expect(existsSync(join(userDataDir, 'audio', id, 'mic.opus')), id).toBe(true);
  }
  await expect(page.getByTestId('last-sweep')).toContainText('freed 600 MB (1 meeting)');
  await expect(page.getByTestId('retention-preview')).toHaveText('Nothing to delete right now.');
  await evidence(page, 'storage-retention-applied', '3.8');

  // The meeting view hint for a meeting this account knows but this Mac never recorded is covered by
  // unit tests; here: the transcript of the deleted meeting is still served.
  expect(localSegments(userId, meetingId)).toBe(segments);
  writeEvidence(
    'storage.json',
    {
      meetingId,
      segmentsKept: segments,
      seeded: ['seed-old 600 MB', 'seed-mid 300 MB', 'other accounts 100 MB'],
    },
    '3.8',
  );

  await page.getByTestId('settings-close').click();
  await expect(page.getByTestId('recording-bar')).toBeVisible();
});
