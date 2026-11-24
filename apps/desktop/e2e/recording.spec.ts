/**
 * Task 2.5 e2e: the built app records the `standup-short` fixture (FileSource, realtime, via
 * `OAT_AUDIO_SOURCE`) through the real pipeline — RecordingController → DeepgramProvider ×2 against the
 * Deepgram-compatible mock (token from the web app's `POST /api/stt/token`) + the Opus archive — and
 * shows the live transcript. No microphone, no real capture, no external service.
 *
 * Task 2.6: the finals are persisted in the app's SQLite database and synced (outbox → `POST
 * /api/sync/push`) into the e2e server's Postgres, queried here; with the sync API down (`OAT_SYNC_URL`
 * at a dead port) the outbox grows, and once a proxy brings it back it drains without duplicates.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';

import { databaseUrlFile } from '../../web/e2e/paths';
import {
  evidence,
  home,
  launchApp,
  openTranscript,
  scaled,
  signInDesktop,
  syncStatus,
  writeEvidence,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');
test.describe.configure({ mode: 'serial' });

const FIXTURE = 'standup-short';
const truth = JSON.parse(
  readFileSync(
    fileURLToPath(new URL(`../../../fixtures/audio/${FIXTURE}.segments.json`, import.meta.url)),
    'utf8',
  ),
) as { source: 'mic' | 'system'; startMs: number; endMs: number; text: string }[];

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);

/** Share of the truth's words found in order in `words` (LCS / truth length). */
function wordRecall(words: string[], expected: string[]): number {
  const dp = Array.from({ length: words.length + 1 }, () =>
    new Array<number>(expected.length + 1).fill(0),
  );
  for (let i = 1; i <= words.length; i++) {
    for (let j = 1; j <= expected.length; j++) {
      dp[i]![j] =
        words[i - 1] === expected[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[words.length]![expected.length]! / expected.length;
}

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;
let webUrl: string;
/** The e2e server's throwaway Postgres (written by apps/web's `e2e/web-server.ts`). */
let sql: postgres.Sql;

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-rec-'));
  sql = postgres(readFileSync(databaseUrlFile(new URL(webUrl).port), 'utf8').trim(), {
    max: 1,
    onnotice: () => {},
  });
  // `next dev` compiles a route on its first request: do it now, not during the latency measurement.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
  await fetch(`${webUrl}/api/sync/pull`);
  await fetch(`${webUrl}/api/sync/push`, { method: 'POST', headers: { origin: webUrl } });
});

test.afterAll(async () => {
  await app?.close();
  await sql?.end();
  rmSync(userDataDir, { recursive: true, force: true });
});

const mainState = (p: Page) =>
  p.evaluate(async () => {
    const r = await window.oat.invoke('state:get');
    if (!r.ok) throw new Error(r.error.message);
    return r.value.state;
  });

const syncNow = (p: Page) =>
  p.evaluate(async () => {
    const r = await window.oat.invoke('sync:now');
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  });

/** Final segments of a meeting in Postgres, as `[id, text]` sorted by id. */
const serverSegments = async (meetingId: string) =>
  (
    await sql<{ id: string; text: string }[]>`
      select id, text from transcript_segment where meeting_id = ${meetingId} and is_final`
  )
    .map((r) => [r.id, r.text])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));

const sortedFinals = (segments: { id: string; text: string; isFinal: boolean }[]) =>
  segments
    .filter((s) => s.isFinal && s.text !== '')
    .map((s) => [s.id, s.text])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));

/** A tiny HTTP proxy to the web app: the "sync API is back" switch for the offline test. */
async function startProxy(port: number, target: string): Promise<Server> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(name)) continue;
      if (typeof value === 'string') headers.set(name, value);
    }
    try {
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const out: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(name)) {
          out[name] = value;
        }
      });
      res.writeHead(upstream.status, out);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}

/** A port nothing listens on (yet). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function launch(env: Record<string, string>) {
  await app?.close();
  ({ app, page } = await launchApp(userDataDir, webUrl, env));
  return app!;
}

const recordingState = (p: Page) =>
  p.evaluate(async () => {
    const r = await window.oat.invoke('recording:get');
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  });

const transcript = (p: Page) =>
  p.evaluate(async () => {
    const r = await window.oat.invoke('transcript:get');
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  });

/** Archive files of a meeting as the main process sees them. */
const archiveFiles = (electronApp: ElectronApplication, meetingId: string) =>
  electronApp.evaluate(({ app: a }, id) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const dir = path.join(a.getPath('userData'), 'audio', id);
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .sort()
          .map((name) => ({ name, bytes: fs.statSync(path.join(dir, name)).size }))
      : [];
  }, meetingId);

test('fixture meeting → live me/them transcript, pause/resume, archive on disk', async ({
  browser,
}) => {
  test.setTimeout(scaled(150_000));
  const electronApp = await launch({ OAT_AUDIO_SOURCE: `file:${FIXTURE}` });
  // Fit fewer lines so this short fixture overflows while the recording is still live.
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(900, 480),
  );
  await signInDesktop(electronApp, page, browser, uniqueAddress('rec'));

  // Empty state before the first recording: Home without notes (a transcript belongs to a note now).
  await expect(home(page)).toContainText('No notes yet');
  await evidence(page, 'empty', '2.5');

  // Note when each source's first segment (and first interim) becomes visible.
  await page.evaluate(() => {
    const seen: Record<string, number> = {};
    (window as unknown as { __seen: Record<string, number> }).__seen = seen;
    const check = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid=transcript-segment]')) {
        const source = el.dataset.source!;
        seen[source] ??= Date.now();
        if (el.dataset.final === 'false') seen[`${source}:interim`] ??= Date.now();
      }
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  });

  await page.getByTestId('new-meeting').click();
  // The note it records into opens; its transcript is closed until asked for, so open it at once (the
  // latency below is measured to the first *visible* segment).
  const panel = await openTranscript(page);
  await panel.getByRole('separator', { name: 'Resize panel' }).press('End');
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const started = await recordingState(page);
  expect(started).toMatchObject({ status: 'recording', input: 'file', fixture: FIXTURE });
  const meetingId = started.meetingId!;
  const t0 = started.startedAt!;

  // Both voices appear, labelled and coloured, interims first.
  await expect(
    page.locator('[data-testid=transcript-segment][data-source=mic]').first(),
  ).toBeVisible({
    timeout: scaled(15_000),
  });
  await expect(page.getByTestId('stt-status')).toHaveText('Live');
  await expect(
    page.locator('[data-testid=transcript-segment][data-source=system]').first(),
  ).toBeVisible({ timeout: scaled(15_000) });
  await expect(page.getByText('Them', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Me', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('level-mic').getByRole('meter')).toBeVisible();

  // Latency: speech onset in the audio → first visible segment of that voice (SPEC §8: < 1.5 s).
  const seen = await page.evaluate(
    () => (window as unknown as { __seen: Record<string, number> }).__seen,
  );
  const firstMic = truth.find((t) => t.source === 'mic')!.startMs;
  const firstThem = truth.find((t) => t.source === 'system')!.startMs;
  const latency = {
    mic: seen.mic! - (t0 + firstMic),
    system: seen.system! - (t0 + firstThem),
  };
  console.log(`[e2e] first-segment latency: me ${latency.mic} ms, them ${latency.system} ms`);
  expect(seen['mic:interim'], 'an interim was shown before its final').toBeDefined();
  expect(latency.mic).toBeLessThan(1500);
  expect(latency.system).toBeLessThan(1500);
  await page.waitForTimeout(1_000);
  await evidence(page, 'live', '2.5');

  // Pause: the clock stops, the bar says so; resume carries on.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'paused');
  const pausedAt = await page.getByTestId('recording-elapsed').textContent();
  await page.waitForTimeout(1_500);
  await expect(page.getByTestId('recording-elapsed')).toHaveText(pausedAt!);
  await evidence(page, 'paused', '2.5');
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');

  // While it records: scrolling up stops following the live end and offers "Jump to live" (once the
  // transcript overflows the small window).
  const live = page.getByTestId('transcript-scroll');
  await expect
    .poll(() => live.evaluate((el) => el.scrollHeight - el.clientHeight), {
      timeout: scaled(30_000),
    })
    .toBeGreaterThan(80);
  await expect(page.getByTestId('recording-bar')).not.toHaveAttribute('data-status', 'idle');
  await live.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByTestId('jump-to-live')).toBeVisible();
  await evidence(page, 'scrolled-up', '2.5');
  await page.getByTestId('jump-to-live').click();
  await expect(page.getByTestId('jump-to-live')).toBeHidden();
  await expect
    .poll(() => live.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(50);

  // The widget mirrors it, with a Stop button.
  const widgetOpened = electronApp.waitForEvent('window');
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Show meeting widget' }).click();
  const widget = await widgetOpened;
  await expect(widget.getByTestId('widget-recording')).toHaveText('Recording');
  await expect(widget.getByTestId('widget-stop')).toBeVisible();
  await expect(widget.getByTestId('stt-status')).toHaveText('Live');
  await evidence(widget, 'widget-recording', '2.5');

  // The fixture ends by itself (~33 s of audio): back to idle, files closed.
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(60_000),
  });
  await expect(widget.getByTestId('widget-recording')).toHaveText('Not recording');
  await widget.getByRole('button', { name: 'Close widget' }).click();

  // Finals match the fixture's ground truth, per voice.
  const final = await transcript(page);
  expect(final.meetingId).toBe(meetingId);
  expect(final.segments.every((s) => s.isFinal)).toBe(true);
  const recall: Record<string, number> = {};
  for (const source of ['mic', 'system'] as const) {
    const heard = normalize(
      final.segments
        .filter((s) => s.source === source)
        .map((s) => s.text)
        .join(' '),
    );
    const expected = normalize(
      truth
        .filter((t) => t.source === source)
        .map((t) => t.text)
        .join(' '),
    );
    recall[source] = wordRecall(heard, expected);
    expect(recall[source], `${source} transcript vs ground truth`).toBeGreaterThanOrEqual(0.95);
    expect(heard.length).toBeLessThanOrEqual(expected.length + 2);
  }
  // No interims left on screen.
  await expect(page.locator('[data-testid=transcript-segment][data-final=false]')).toHaveCount(0);

  // Archive: one Opus file per voice; stop returns their (complete) rows.
  const stopped = await page.evaluate(() => window.oat.invoke('recording:stop'));
  expect(stopped.ok).toBe(true);

  // Files closed, finished and playable on this Mac (3.7): the playhead owns the scroll now — scrolling up never offers
  // "Jump to live" for a recording that is over.
  const scroller = page.getByTestId('transcript-scroll');
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused', {
    timeout: scaled(15_000),
  });
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByTestId('jump-to-live')).toHaveCount(0);

  const audio = stopped.ok ? stopped.value.audio : [];
  expect(audio.map((a) => [a.source, a.status])).toEqual([
    ['mic', 'complete'],
    ['system', 'complete'],
  ]);
  for (const a of audio) expect(a.durationMs).toBeGreaterThan(30_000);
  const files = await archiveFiles(electronApp, meetingId);
  expect(files.map((f) => f.name)).toEqual(['mic.opus', 'system.opus']);
  for (const f of files) expect(f.bytes).toBeGreaterThan(5_000);
  await evidence(page, 'finished', '2.5');

  // 2.6: the finals went to the local database and through sync into Postgres, ids and text intact.
  expect(await syncNow(page)).toMatchObject({ state: 'idle', pending: 0 });
  await expect(syncStatus(page)).toHaveAttribute('data-state', 'idle');
  await expect(syncStatus(page)).toHaveAccessibleName('All changes synced');
  const expected = sortedFinals(final.segments);
  expect(expected.length).toBeGreaterThan(5);
  expect(await serverSegments(meetingId)).toEqual(expected);
  const [doc] = await sql<{ kind: string; visibility: string; title: string }[]>`
    select d.kind, d.visibility, d.title from meeting m join document d on d.id = m.document_id
    where m.id = ${meetingId} and m.ended_at is not null`;
  expect(doc).toMatchObject({ kind: 'meeting', visibility: 'private' });
  expect(doc!.title).toMatch(/^Meeting, /);
  await evidence(page, 'synced', '2.6');

  writeEvidence(
    'latency.json',
    {
      fixture: FIXTURE,
      firstSegmentLatencyMs: latency,
      wordRecall: recall,
      segments: final.segments.length,
      archive: files,
      measured:
        'wall time from speech onset in the fixture (recording start + ground-truth startMs) to the first visible segment of that voice',
      at: new Date().toISOString(),
    },
    '2.5',
  );
});

test('transcription down: the error is shown and recording + archive carry on', async () => {
  test.setTimeout(scaled(90_000));
  // Same signed-in profile; transcription pointed at a closed port (nothing listens on 9).
  const electronApp = await launch({
    OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
    OAT_STT_URL: 'ws://127.0.0.1:9/v1/listen',
  });
  await expect(page.getByTestId('signed-in-email')).toBeVisible();

  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const banner = page.getByTestId('recording-issues');
  await expect(banner).toBeVisible({ timeout: scaled(15_000) });
  await expect(banner).toContainText('Transcription is offline — still recording');
  await expect(banner).toContainText(/recording continues/i);
  await expect(page.getByTestId('stt-status')).toHaveAttribute(
    'data-health',
    /reconnecting|offline/,
  );

  // Still recording: the clock runs, audio levels move.
  const before = await recordingState(page);
  await page.waitForTimeout(3_000);
  const after = await recordingState(page);
  expect(after.status).toBe('recording');
  expect(after.elapsedMs).toBeGreaterThan(before.elapsedMs + 2_000);
  expect(after.levels.mic).not.toBeNull();
  // (The transcript panel was open when the app was last used: it still is.)
  await openTranscript(page);
  await expect(page.getByTestId('transcript-empty')).toContainText('Waiting for transcription');
  await evidence(page, 'stt-down', '2.5');

  // The widget shows the problem too; Stop there ends the recording.
  const widgetOpened = electronApp.waitForEvent('window');
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Show meeting widget' }).click();
  const widget = await widgetOpened;
  await expect(widget.getByTestId('widget-issue')).toHaveText(
    'Transcription offline — still recording',
  );
  await evidence(widget, 'widget-stt-down', '2.5');
  await widget.getByTestId('widget-stop').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(20_000),
  });
  // The banner stays after the recording (it is cleared by the next start only).
  await expect(banner).toContainText('This recording had problems');

  const files = await archiveFiles(electronApp, after.meetingId!);
  expect(files.map((f) => f.name)).toEqual(['mic.opus', 'system.opus']);
  for (const f of files) expect(f.bytes).toBeGreaterThan(1_000);
  const done = await page.evaluate(() => window.oat.invoke('recording:stop'));
  expect(
    done.ok && done.value.audio.every((a) => a.status === 'complete' && a.durationMs > 3_000),
  ).toBe(true);
});

test('sync API down: the outbox grows while recording, then drains into Postgres without duplicates', async () => {
  test.setTimeout(scaled(120_000));
  const port = await freePort();
  // Same signed-in profile (its workspace is already known locally); sync points at a dead port.
  await launch({ OAT_AUDIO_SOURCE: `file:${FIXTURE}`, OAT_SYNC_URL: `http://127.0.0.1:${port}` });
  await expect(page.getByTestId('signed-in-email')).toBeVisible();

  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const meetingId = (await recordingState(page)).meetingId!;
  // Let a few finals arrive, then stop.
  await expect
    .poll(async () => (await transcript(page)).segments.filter((s) => s.isFinal).length, {
      timeout: scaled(30_000),
    })
    .toBeGreaterThanOrEqual(4);
  const stopped = await page.evaluate(() => window.oat.invoke('recording:stop'));
  expect(stopped.ok).toBe(true);

  const finals = sortedFinals((await transcript(page)).segments);
  const offline = (await mainState(page)).sync;
  expect(offline.state).toBe('offline');
  // The document, the meeting and every final are waiting in the outbox.
  expect(offline.pending).toBeGreaterThanOrEqual(finals.length + 2);
  await expect(syncStatus(page)).toHaveAttribute('data-state', 'offline');
  await expect(syncStatus(page)).toHaveAccessibleName(/saved on this Mac/);
  await evidence(page, 'offline', '2.6');
  expect(await serverSegments(meetingId)).toEqual([]);
  expect((await sql`select 1 from meeting where id = ${meetingId}`).length).toBe(0);

  // Back online: the outbox drains and Postgres gets exactly the local finals.
  const proxy = await startProxy(port, webUrl);
  try {
    expect(await syncNow(page)).toMatchObject({ state: 'idle', pending: 0 });
    expect(await serverSegments(meetingId)).toEqual(finals);
    // Syncing again changes nothing (nothing re-sent, nothing duplicated).
    expect(await syncNow(page)).toMatchObject({ state: 'idle', pending: 0 });
    const [counts] = await sql<{ n: number; ids: number }[]>`
      select count(*)::int as n, count(distinct id)::int as ids from transcript_segment
      where meeting_id = ${meetingId}`;
    expect(counts).toEqual({ n: finals.length, ids: finals.length });
    await expect(syncStatus(page)).toHaveAccessibleName('All changes synced');
    await evidence(page, 'drained', '2.6');
    writeEvidence(
      'sync.json',
      { meetingId, finals: finals.length, pendingWhileOffline: offline.pending, at: new Date() },
      '2.6',
    );
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});
