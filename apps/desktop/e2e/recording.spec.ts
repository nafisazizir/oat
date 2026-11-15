/**
 * Task 2.5 e2e: the built app records the `standup-short` fixture (FileSource, realtime, via
 * `OAT_AUDIO_SOURCE`) through the real pipeline — RecordingController → DeepgramProvider ×2 against the
 * Deepgram-compatible mock (token from the web app's `POST /api/stt/token`) + the Opus archive — and
 * shows the live transcript. No microphone, no real capture, no external service.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniqueAddress } from '@oat/testkit';
import { type ElectronApplication, expect, type Page, test } from '@playwright/test';

import { evidence, launchApp, signInDesktop, writeEvidence } from './helpers';

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

test.beforeAll(async ({ baseURL }) => {
  webUrl = baseURL!;
  userDataDir = mkdtempSync(join(tmpdir(), 'oat-desktop-rec-'));
  // `next dev` compiles a route on its first request: do it now, not during the latency measurement.
  await fetch(`${webUrl}/api/stt/token`, { method: 'POST', headers: { origin: webUrl } });
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

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
  test.setTimeout(150_000);
  const electronApp = await launch({ OAT_AUDIO_SOURCE: `file:${FIXTURE}` });
  // A smaller window, so the transcript scrolls and "Jump to live" can be exercised.
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setSize(900, 640),
  );
  await signInDesktop(electronApp, page, browser, uniqueAddress('rec'));

  // Empty state before the first recording.
  await expect(page.getByTestId('transcript-empty')).toContainText('No transcript yet');
  await expect(page.getByTestId('audio-input')).toContainText(`Fixture: ${FIXTURE}`);
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

  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const started = await recordingState(page);
  expect(started).toMatchObject({ status: 'recording', input: 'file', fixture: FIXTURE });
  const meetingId = started.meetingId!;
  const t0 = started.startedAt!;

  // Both voices appear, labelled and coloured, interims first.
  await expect(
    page.locator('[data-testid=transcript-segment][data-source=mic]').first(),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId('stt-status')).toHaveText('Live');
  await expect(
    page.locator('[data-testid=transcript-segment][data-source=system]').first(),
  ).toBeVisible({ timeout: 15_000 });
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

  // The widget mirrors it, with a Stop button.
  const widgetOpened = electronApp.waitForEvent('window');
  await page.getByRole('button', { name: 'Show meeting widget' }).click();
  const widget = await widgetOpened;
  await expect(widget.getByTestId('widget-recording')).toHaveText('Recording');
  await expect(widget.getByTestId('widget-stop')).toBeVisible();
  await expect(widget.getByTestId('stt-status')).toHaveText('Live');
  await evidence(widget, 'widget-recording', '2.5');

  // The fixture ends by itself (~33 s of audio): back to idle, files closed.
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: 60_000,
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

  // Scrolling up stops following the live end and offers "Jump to live".
  const scroller = page.getByTestId('transcript-scroll');
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect(page.getByTestId('jump-to-live')).toBeVisible();
  await evidence(page, 'scrolled-up', '2.5');
  await page.getByTestId('jump-to-live').click();
  await expect(page.getByTestId('jump-to-live')).toBeHidden();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(50);

  // Archive: one Opus file per voice; stop returns their (complete) rows.
  const stopped = await page.evaluate(() => window.oat.invoke('recording:stop'));
  expect(stopped.ok).toBe(true);
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
  test.setTimeout(90_000);
  // Same signed-in profile; transcription pointed at a closed port (nothing listens on 9).
  const electronApp = await launch({
    OAT_AUDIO_SOURCE: `file:${FIXTURE}`,
    OAT_STT_URL: 'ws://127.0.0.1:9/v1/listen',
  });
  await expect(page.getByTestId('signed-in-email')).toBeVisible();

  await page.getByRole('button', { name: 'Start recording' }).click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'recording');
  const banner = page.getByTestId('recording-issues');
  await expect(banner).toBeVisible({ timeout: 10_000 });
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
  await expect(page.getByTestId('transcript-empty')).toContainText('Waiting for transcription');
  await evidence(page, 'stt-down', '2.5');

  // The widget shows the problem too; Stop there ends the recording.
  const widgetOpened = electronApp.waitForEvent('window');
  await page.getByRole('button', { name: 'Show meeting widget' }).click();
  const widget = await widgetOpened;
  await expect(widget.getByTestId('widget-issue')).toHaveText(
    'Transcription offline — still recording',
  );
  await evidence(widget, 'widget-stt-down', '2.5');
  await widget.getByTestId('widget-stop').click();
  await expect(page.getByTestId('recording-bar')).toHaveAttribute('data-status', 'idle', {
    timeout: 20_000,
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
