import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument } from './docs-helpers';
import { expect, test } from './fixtures';

const audio = fileURLToPath(new URL('../../../fixtures/audio/standup-short.wav', import.meta.url));
test.use({
  storageState: SIGNED_OUT,
  viewport: { width: 1440, height: 1000 },
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${audio}`,
    ],
  },
});

test('browser mic recording streams to mock STT and persists through cookie-authenticated sync', async ({
  page,
  baseURL,
}) => {
  const providerResults: { start: number; duration: number; is_final: boolean; text: string }[] =
    [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', (event) => {
      try {
        const message = JSON.parse(String(event.payload));
        if (message.type === 'Results')
          providerResults.push({
            start: message.start,
            duration: message.duration,
            is_final: message.is_final,
            text: message.channel.alternatives[0].transcript,
          });
      } catch {
        /* Binary PCM is not a provider result. */
      }
    }),
  );
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('web-recording'), baseURL!);
  const doc = await apiCreateDocument(page, { title: 'Browser standup', kind: 'meeting' });
  await page.goto(`/d/${doc.id}`);
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const pushed = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync/push') && response.ok(),
  );
  await page.getByRole('button', { name: 'Mic only', exact: true }).click();
  await expect(page.getByTestId('web-recording')).toHaveAttribute('data-status', 'recording');
  await expect(page.getByTestId('document-actions').getByTestId('web-recording')).toBeVisible();
  const response = await pushed;
  const headers = await response.request().allHeaders();
  expect(headers['origin']).toBe(baseURL);
  expect(Boolean(headers['cookie'])).toBe(true);
  expect(headers['authorization']).toBeUndefined();
  await expect(page.getByTestId('transcript-segment').first()).toBeVisible({ timeout: 30000 });
  await expect
    .poll(async () => {
      const clock = (await page.getByTestId('web-recording').innerText()).match(/(\d+):(\d{2})/);
      return clock ? Number(clock[1]) * 60 + Number(clock[2]) : 0;
    })
    .toBeGreaterThanOrEqual(4);
  await expect(page.getByTestId('recording-sync')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByTestId('web-recording')).toHaveAttribute('data-status', 'paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByTestId('web-recording')).toHaveAttribute('data-status', 'recording');
  if (process.env.E2E_RECORDING_SCREENSHOT) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: process.env.E2E_RECORDING_SCREENSHOT,
      style: 'nextjs-portal { display: none !important; }',
    });
  }
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open recording note' })).toBeVisible();
  await expect(page.getByTestId('web-recording')).toHaveAttribute('data-status', 'recording');
  await page.getByRole('link', { name: 'Open recording note' }).click();
  await expect(page).toHaveURL(new RegExp(`/d/${doc.id}$`));
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(page.getByTestId('web-recording')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('playback')).toBeVisible();
  const persisted = await page.getByTestId('transcript-segment').count();
  const words = await page.getByTestId('transcript-segment').allTextContents();
  expect(persisted).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByTestId('transcript-segment')).toHaveCount(persisted);
  await expect(page.getByTestId('transcript-segment')).toHaveText(words);
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');
  await page.getByTestId('playback-toggle').click();
  await expect
    .poll(() =>
      page.getByTestId('playback-audio').evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThan(0.25);
  await page.getByTestId('playback-toggle').click();
  const meeting = await (
    await page.request.get(`/api/documents/${doc.id}/meeting?transcript=1`)
  ).json();
  const target = meeting.transcript.at(-1);
  await page.locator(`[data-segment-id="${target.id}"]`).getByRole('button').click();
  await expect
    .poll(async () =>
      Math.abs(
        Number(
          await page
            .getByTestId('playback')
            .locator('[data-current-ms]')
            .getAttribute('data-current-ms'),
        ) - target.startMs,
      ),
    )
    .toBeLessThan(150);
  const metadata = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('oat-audio')).getDirectoryHandle(id);
    return JSON.parse(await (await (await dir.getFileHandle('metadata.json')).getFile()).text());
  }, meeting.meetingId);
  expect(metadata.finalized).toBe(true);
  expect(metadata.parts).toHaveLength(2);
  await page.getByTestId('playback-toggle').click();
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'playing');
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused', {
    timeout: 10000,
  });
  await page.getByTestId('playback-toggle').click();
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'playing');
  await expect
    .poll(async () =>
      Number(
        await page
          .getByTestId('playback')
          .locator('[data-current-ms]')
          .getAttribute('data-current-ms'),
      ),
    )
    .toBeLessThan(2000);
  await page.getByTestId('playback-toggle').click();
  if (process.env.E2E_PLAYBACK_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.E2E_PLAYBACK_SCREENSHOTS}/web-play-light.png`,
      style: 'nextjs-portal { display: none !important; }',
    });
    await page.evaluate(() => {
      localStorage.setItem('oat-theme', 'dark');
    });
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');
    await page.screenshot({
      path: `${process.env.E2E_PLAYBACK_SCREENSHOTS}/web-play-dark.png`,
      style:
        'nextjs-portal { display: none !important; } *, *::before, *::after { transition: none !important; }',
    });
  }
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('button', { name: 'Delete audio from this browser', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete audio', exact: true })
    .click();
  await expect(page.getByTestId('playback')).toHaveCount(0);
  await expect(page.getByTestId('audio-hint')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('playback')).toHaveCount(0);
  await expect(page.getByTestId('transcript-segment')).toHaveCount(persisted);
  if (process.env.E2E_STT_RESULTS)
    await writeFile(process.env.E2E_STT_RESULTS, JSON.stringify(providerResults, null, 2));
});
