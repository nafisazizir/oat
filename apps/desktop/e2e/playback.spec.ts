/**
 * Task 3.7 e2e: listening back to a meeting on the desktop. The `standup-short` fixture is recorded twice
 * into one note (FileSource, never real capture; "Continue recording" makes part 2, D-24), so the archive
 * holds two parts per source and the transcript spans both. Then, with the `<audio>` element muted:
 *
 * - the player shows both parts; clicking a line in part 2 (and one in part 1) puts the playhead at its
 *   `startMs` (± 100 ms) and highlights it; playing (2×) moves the highlight to later lines;
 * - Me / Them / Both switch the stream and keep the position; ←/→ on the scrubber move 5 s;
 * - main's CPU while playing is measured (`playback.json`);
 * - the recording's rows moved to another account → "Audio is on another device"; audio deleted →
 *   "Audio deleted" (and the `oat-audio://` URL stops serving).
 * Screenshots (light + dark) with `E2E_SCREENSHOTS=1`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import {
  evidence,
  launchApp,
  openTranscript,
  stopRecording,
  scaled,
  signInDesktop,
  writeEvidence,
} from './helpers';

test.skip(process.platform !== 'darwin', 'desktop e2e runs on macOS');

const FIXTURE = 'standup-short';

let userDataDir: string;
let app: ElectronApplication | undefined;
let page: Page;

test.beforeAll(async ({ baseURL }) => {
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-playback-'));
  // `next dev` compiles a route on its first request: do it now, not while recording.
  await fetch(`${baseURL}/api/stt/token`, { method: 'POST', headers: { origin: baseURL! } });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

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

interface Segment {
  id: string;
  startMs: number;
  endMs: number;
  source: string;
}
interface Info {
  status: string;
  url: string | null;
  durationMs: number;
  parts: { part: number; startMs: number; endMs: number }[];
}

/** The player's element: position (ms), paused, source URL. */
const audio = (p: Page) =>
  p.getByTestId('playback-audio').evaluate((el) => {
    const a = el as HTMLAudioElement;
    return { ms: a.currentTime * 1000, paused: a.paused, src: a.src, seeking: a.seeking };
  });

const activeId = (p: Page) =>
  p
    .locator('[data-testid=transcript-segment][data-active]')
    .first()
    .getAttribute('data-segment-id', { timeout: 1000 })
    .catch(() => null);

async function finals(p: Page): Promise<number> {
  const t = await invoke<{ segments: { isFinal: boolean }[] }>(p, 'transcript:get');
  return t.segments.filter((s) => s.isFinal).length;
}

async function recordUntil(p: Page, button: string, total: number) {
  await p.getByRole('button', { name: button }).click();
  await expect(p.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  await expect.poll(() => finals(p), { timeout: scaled(45_000) }).toBeGreaterThanOrEqual(total);
  await stopRecording(p);
  await expect(p.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });
}

/** Desktop screenshots in both schemes (the renderer follows `prefers-color-scheme`). */
async function shots(p: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await p.emulateMedia({ colorScheme: scheme });
    if (scheme === 'dark') await expect(p.locator('html')).toHaveClass(/dark/);
    else await expect(p.locator('html')).not.toHaveClass(/dark/);
    await evidence(p, `${name}-${scheme}`, '3.7');
  }
  await p.emulateMedia({ colorScheme: 'light' });
}

/** Clicks a transcript line and checks the playhead lands on its start (± 100 ms) and it is highlighted. */
async function clickToSeek(p: Page, segment: Segment) {
  const line = p.locator(`[data-segment-id="${segment.id}"]`);
  await line.scrollIntoViewIfNeeded();
  await line.locator('p').click();
  await expect
    .poll(async () => {
      const a = await audio(p);
      return !a.seeking && Math.abs(a.ms - segment.startMs) <= 100;
    })
    .toBe(true);
  await expect(line).toHaveAttribute('data-active', 'true');
  return (await audio(p)).ms;
}

/** Status of a request to main's `oat-audio://` protocol (through the default session, like the player). */
const fetchStatus = (url: string) =>
  app!.evaluate(async ({ net }, u) => (await net.fetch(u, { method: 'HEAD' })).status, url);

test('listen back: click-to-seek across two parts, playhead highlight, sources, states', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(scaled(240_000));
  ({ app, page } = await launchApp(userDataDir, baseURL!, {
    OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
  }));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
  await signInDesktop(app, page, browser, uniqueAddress('playback'));
  const userId = (await invoke<{ state: { auth: { user: { id: string } } } }>(page, 'state:get'))
    .state.auth.user.id;

  // Two recording sessions into one note: part 1, then "Continue recording" → part 2.
  await page.getByTestId('new-meeting').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const { meetingId } = await invoke<{ meetingId: string }>(page, 'recording:get');
  const documentId = (await page
    .getByTestId('meeting-list-item')
    .first()
    .getAttribute('data-document-id'))!;
  await expect.poll(() => finals(page), { timeout: scaled(45_000) }).toBeGreaterThanOrEqual(3);
  await stopRecording(page);
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: scaled(30_000),
  });
  // Playable once the files are closed (`storage:changed` reloads the player). The player sits on top of
  // the transcript, in its panel: closed until asked for, and it stays open from here on.
  await expect(page.getByTestId('playback')).toHaveCount(0);
  await openTranscript(page);
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused', {
    timeout: scaled(15_000),
  });
  const firstPartFinals = await finals(page);
  await recordUntil(page, 'Continue recording', firstPartFinals + 3);
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused', {
    timeout: scaled(15_000),
  });

  const info = await invoke<Info>(page, 'playback:open', { meetingId });
  expect(info.status).toBe('available');
  expect(info.parts.map((p) => p.part)).toEqual([1, 2]);
  expect(await fetchStatus(`${info.url}mix.wav`)).toBe(200);
  await expect(page.getByTestId('playback-part')).toHaveCount(2);
  const part2Start = info.parts[1]!.startMs;
  const { segments } = await invoke<{ segments: Segment[] }>(page, 'meeting:transcript', {
    documentId,
  });
  const inPart2 = segments.filter((s) => s.startMs > part2Start + 200);
  const inPart1 = segments.filter((s) => s.endMs < part2Start);
  expect(inPart1.length).toBeGreaterThanOrEqual(2);
  expect(inPart2.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');
  await page
    .getByTestId('playback-audio')
    .evaluate((el) => ((el as HTMLAudioElement).muted = true));

  // Click a line in part 2, then one in part 1: the playhead lands on each line's start.
  const seekResults = [];
  const target2 = inPart2[0]!;
  seekResults.push({ part: 2, startMs: target2.startMs, at: await clickToSeek(page, target2) });
  const target1 = inPart1[1]!;
  seekResults.push({ part: 1, startMs: target1.startMs, at: await clickToSeek(page, target1) });
  expect((await audio(page)).paused).toBe(true); // a click seeks; it doesn't start playback

  // Play at 2×: the highlight moves on to later lines while main decodes on the fly.
  await page.getByTestId('playback-speed').click(); // 1.25×
  await page.getByTestId('playback-speed').click(); // 1.5×
  await page.getByTestId('playback-speed').click(); // 2×
  await expect(page.getByTestId('playback-speed')).toHaveText('2×');
  // Every process's CPU (Electron: % of one core since the previous getAppMetrics call).
  await app.evaluate(({ app: a }) => a.getAppMetrics());
  const before = await app.evaluate(() => process.cpuUsage());
  const wallStart = Date.now();
  await page.getByTestId('playback-toggle').click();
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'playing');
  const later = inPart1[2] ?? inPart2[0]!;
  await expect.poll(() => activeId(page), { timeout: scaled(20_000) }).toBe(later.id);
  await shots(page, 'playback-playing');
  // Keep playing across the boundary into part 2.
  await expect
    .poll(async () => (await audio(page)).ms, { timeout: scaled(30_000) })
    .toBeGreaterThan(part2Start + 1000);
  const cpu = await app.evaluate((_e, prev) => process.cpuUsage(prev), before);
  const wallMs = Date.now() - wallStart;
  const metrics = await app.evaluate(({ app: a }) =>
    a.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })),
  );
  expect(await activeId(page)).not.toBeNull();
  await page.getByTestId('playback-toggle').click();
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');

  // Me / Them / Both: another stream, same position.
  const at = (await audio(page)).ms;
  await page.getByRole('radio', { name: 'Them' }).click();
  await expect.poll(async () => (await audio(page)).src).toMatch(/\/system\.wav\?v=\d+$/);
  await expect.poll(async () => Math.abs((await audio(page)).ms - at)).toBeLessThan(150);
  await page.getByRole('radio', { name: 'Me' }).click();
  await expect.poll(async () => (await audio(page)).src).toMatch(/\/mic\.wav\?v=\d+$/);
  await page.getByRole('radio', { name: 'Both' }).click();
  await expect.poll(async () => (await audio(page)).src).toMatch(/\/mix\.wav\?v=\d+$/);

  // Keyboard: the scrubber moves 5 s per arrow; Home goes to the start.
  await page.getByTestId('playback-scrubber').focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => (await audio(page)).ms).toBeLessThan(50);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.abs((await audio(page)).ms - 5000)).toBeLessThan(50);
  await shots(page, 'playback-paused');

  writeEvidence(
    'playback.json',
    {
      parts: info.parts,
      durationMs: info.durationMs,
      seeks: seekResults.map((s) => ({ ...s, errorMs: Math.round(s.at - s.startMs) })),
      mainCpuWhilePlaying2x: {
        userMs: Math.round(cpu.user / 1000),
        systemMs: Math.round(cpu.system / 1000),
        wallMs,
        percentOfOneCore: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10,
      },
      appMetrics: metrics,
    },
    '3.7',
  );

  // The audio belongs to another account on this Mac (D-30) → "on another device" (no URL works).
  const index = new DatabaseSync(join(userDataDir, 'audio-index.sqlite'));
  try {
    index
      .prepare('UPDATE audio_recording SET user_id = ? WHERE meeting_id = ?')
      .run('someone-else', meetingId);
  } finally {
    index.close();
  }
  await invoke(page, 'storage:set-policy', { policy: { kind: 'forever' } }); // announces storage:changed
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'other-device');
  await expect(page.getByTestId('playback-notice-title')).toHaveText('Audio is on another device');
  expect(await fetchStatus(`${info.url}mix.wav`)).toBe(410); // not this account’s audio any more
  await shots(page, 'playback-other-device');
  const back = new DatabaseSync(join(userDataDir, 'audio-index.sqlite'));
  try {
    back
      .prepare('UPDATE audio_recording SET user_id = ? WHERE meeting_id = ?')
      .run(userId, meetingId);
  } finally {
    back.close();
  }
  await invoke(page, 'storage:set-policy', { policy: { kind: 'forever' } });
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');

  // Deleted from Settings → Storage (3.8): the player says so; the transcript stays.
  const deleted = await invoke<{ deleted: boolean }>(page, 'storage:delete-audio', { meetingId });
  expect(deleted.deleted).toBe(true);
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'deleted');
  await expect(page.getByTestId('playback-notice-title')).toHaveText('Audio deleted');
  await expect(page.getByTestId('transcript-segment').first()).toBeVisible();
  await expect(page.locator('[data-testid=transcript-segment][data-active]')).toHaveCount(0);
  expect(await fetchStatus(`${info.url}mix.wav`)).toBe(410); // gone: the open player can’t fetch it either
  await shots(page, 'playback-deleted');
});
