/**
 * Task 2.7 e2e: a recording never silently loses anything.
 *
 * 1. Transcription goes down mid-recording (the in-process Deepgram mock's `/_mock/outage` switch) and stays
 *    down past the end of the `standup-short` fixture (FileSource, never real capture): the panel says the
 *    rest is missing; once transcription is back the gap is transcribed from the saved audio (the mock's
 *    pre-recorded API) and the stored transcript is the fixture's ground truth, without duplicates.
 * 2. The Electron main process is killed (SIGKILL) while recording: after a relaunch the audio is repaired,
 *    the meeting is closed, the note says "Oat quit unexpectedly — recording saved up to …", every final
 *    saved before the kill is there and nothing is duplicated (the tail is back-filled).
 *
 * The STT endpoint is an in-process `@oat/mocks` instance (this checkout's code: the pre-recorded endpoint
 * and the outage switch aren't in the shared container until it is rebuilt), reached via `OAT_STT_URL`; it
 * accepts the bearer tokens the web app grants from the container mock (`acceptAnyBearer`). Loopback only.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type RunningMocks, startMocks, sttProvider } from '@oat/mocks';
import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import { evidence, launchApp, openTranscript, scaled, signInDesktop } from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

const FIXTURE = 'standup-short';
const truth = JSON.parse(
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/audio/${FIXTURE}.segments.json`, import.meta.url)),
    'utf8',
  ),
) as { source: 'mic' | 'system'; startMs: number; endMs: number; text: string }[];

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

interface Stored {
  id: string;
  source: 'mic' | 'system';
  startMs: number;
  endMs: number;
  text: string;
  backfilled?: boolean;
}

let mocks: RunningMocks;
let webUrl: string;
const dirs: string[] = [];
let app: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  mocks = await startMocks({ providers: [() => sttProvider({ acceptAnyBearer: true })] });
  // `next dev` compiles a route on its first request: do it now, not while recording.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/sync/pull`);
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  await mocks?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const outage = (down: boolean) =>
  fetch(`${mocks.url}/stt/_mock/outage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ down }),
  });

async function launch(userDataDir: string) {
  ({ app, page } = await launchApp(userDataDir, webUrl, {
    OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
    OAT_STT_URL: `${mocks.url.replace('http', 'ws')}/stt/v1/listen`,
  }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  return app;
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

const transcript = async (documentId: string) =>
  (await invoke<{ segments: Stored[] }>(page, 'meeting:transcript', { documentId })).segments;

function expectNoDuplicates(segments: Stored[]) {
  expect(new Set(segments.map((s) => s.id)).size).toBe(segments.length);
  for (const source of ['mic', 'system'] as const) {
    const list = segments.filter((s) => s.source === source).sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < list.length; i++) {
      expect(
        list[i]!.startMs,
        `${source} segment ${i} overlaps the previous one`,
      ).toBeGreaterThanOrEqual(list[i - 1]!.endMs);
    }
  }
}

async function startNewMeeting() {
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  const item = page.getByTestId('meeting-list-item');
  await expect(item).toHaveCount(1);
  const documentId = (await item.getAttribute('data-document-id'))!;
  return { meetingId, documentId };
}

test('STT down past the end of the recording → filled in from the saved audio once it is back', async ({
  browser,
}) => {
  test.setTimeout(scaled(180_000));
  const dir = mkdtempSync(join(tmpdir(), 'oat-desktop-backfill-'));
  dirs.push(dir);
  const electronApp = await launch(dir);
  await signInDesktop(electronApp, page, browser, uniqueAddress('backfill'));
  const { meetingId, documentId } = await startNewMeeting();

  // A few seconds of live transcript, then transcription goes down (sockets dropped, every reconnect 503).
  await expect
    .poll(async () => (await transcript(documentId)).length, { timeout: scaled(30_000) })
    .toBeGreaterThanOrEqual(2);
  await outage(true);
  const liveBefore = await transcript(documentId);
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(60_000),
  });

  // The note's transcript says what is missing and that it will be filled in.
  await openTranscript(page);
  const notice = page.getByTestId('transcript-notice');
  await expect(notice.first()).toBeVisible({ timeout: scaled(20_000) });
  await expect(notice.first()).toHaveAttribute('data-kind', /^(filling|retrying)$/);
  await expect(notice.first()).toContainText(/of transcript/);
  const pending = await invoke<{ pendingMs: number; doneMs: number }>(
    page,
    'meeting:transcript-status',
    { meetingId },
  );
  expect(pending.pendingMs).toBeGreaterThan(10_000);
  await evidence(page, 'backfill-pending', '2.7');

  // Transcription is back: the gap is transcribed from the archive.
  await outage(false);
  await expect(page.getByTestId('transcript-notice')).toHaveAttribute('data-kind', 'filled', {
    timeout: scaled(60_000),
  });
  const status = await invoke<{ pendingMs: number; failedMs: number; segments: number }>(
    page,
    'meeting:transcript-status',
    { meetingId },
  );
  expect(status).toMatchObject({ pendingMs: 0, failedMs: 0 });
  expect(status.segments).toBeGreaterThan(0);

  const segments = await transcript(documentId);
  expectNoDuplicates(segments);
  // Everything said live before the outage is still there, untouched.
  for (const s of liveBefore) expect(segments).toContainEqual(s);
  // Live + back-filled = the fixture's ground truth, word for word, per side.
  for (const source of ['mic', 'system'] as const) {
    const got = segments
      .filter((s) => s.source === source)
      .sort((a, b) => a.startMs - b.startMs)
      .map((s) => s.text)
      .join(' ');
    const expected = truth
      .filter((t) => t.source === source)
      .map((t) => t.text)
      .join(' ');
    expect(words(got), source).toBe(words(expected));
  }
  expect(segments.filter((s) => s.backfilled)).toHaveLength(status.segments);
  // The panel shows them all.
  await expect(page.getByTestId('transcript-panel').getByTestId('transcript')).toHaveAttribute(
    'data-count',
    String(segments.length),
  );
  await evidence(page, 'backfill-filled', '2.7');
  // The batch requests went to the pre-recorded API, after the outage.
  const batches = mocks.log
    .list({ provider: 'stt' })
    .filter((r) => r.method === 'POST' && r.path === '/stt/v1/listen');
  expect(batches.some((r) => r.status === 200)).toBe(true);
  await app!.close();
  app = undefined;
});

test('killed while recording → relaunch repairs the audio, closes the meeting, keeps every final', async ({
  browser,
}) => {
  test.setTimeout(scaled(180_000));
  const dir = mkdtempSync(join(tmpdir(), 'oat-desktop-crash-'));
  dirs.push(dir);
  const email = uniqueAddress('crash');
  const electronApp = await launch(dir);
  await signInDesktop(electronApp, page, browser, email);
  const { meetingId, documentId } = await startNewMeeting();
  await expect
    .poll(async () => (await transcript(documentId)).length, { timeout: scaled(40_000) })
    .toBeGreaterThanOrEqual(4);
  const beforeKill = await transcript(documentId);

  // Kill the main process: no before-quit, no stop, files left open.
  const child = electronApp.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
  await electronApp.close().catch(() => {});
  app = undefined;

  await launch(dir);
  await expect(page.getByTestId('signed-in-email')).toHaveText(email);
  const item = page.getByTestId('meeting-list-item');
  await expect(item).toHaveCount(1);
  await item.click();

  // Closed, repaired, explained.
  await expect
    .poll(
      async () =>
        (await invoke<{ endedAt: string | null }>(page, 'meeting:get', { documentId })).endedAt,
      {
        timeout: scaled(20_000),
      },
    )
    .not.toBeNull();
  await expect(page.getByTestId('meeting-time')).not.toHaveAttribute('data-in-progress');
  await openTranscript(page);
  const recovered = page.locator('[data-testid=transcript-notice][data-kind=recovered]');
  await expect(recovered).toContainText('Oat quit unexpectedly — recording saved up to');
  const storage = await invoke<{ meetings: { meetingId: string; status: string }[] }>(
    page,
    'storage:list',
  );
  expect(storage.meetings.find((m) => m.meetingId === meetingId)?.status).toBe('partial');

  // The tail after the last saved final is back-filled; nothing before the kill is lost or duplicated.
  await expect
    .poll(
      async () =>
        (await invoke<{ pendingMs: number }>(page, 'meeting:transcript-status', { meetingId }))
          .pendingMs,
      { timeout: scaled(60_000) },
    )
    .toBe(0);
  const after = await transcript(documentId);
  for (const s of beforeKill) expect(after).toContainEqual(s);
  expectNoDuplicates(after);
  const status = await invoke<{ failedMs: number; recoveredAt: number | null }>(
    page,
    'meeting:transcript-status',
    { meetingId },
  );
  expect(status.failedMs).toBe(0);
  expect(status.recoveredAt).not.toBeNull();
  // A meeting recorded here can be continued after the crash.
  await expect(page.getByRole('button', { name: 'Continue recording' })).toBeVisible();
  await evidence(page, 'crash-recovered', '2.7');
});
