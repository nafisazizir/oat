import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument, apiUpdateDocument } from './docs-helpers';
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

test('microphone denial and Retry stay visible while deep in a note', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const root = document.documentElement;
      root.dataset.micAttempts = String(Number(root.dataset.micAttempts ?? 0) + 1);
      throw new DOMException('Microphone access denied', 'NotAllowedError');
    };
  });
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('denied-mic'), baseURL!);
  const doc = await apiCreateDocument(page, { title: 'Long meeting', kind: 'meeting' });
  const saved = await apiUpdateDocument(page, doc.id, {
    baseVersion: doc.version,
    contentJson: {
      type: 'doc',
      content: Array.from({ length: 120 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Long note line ${i}` }],
      })),
    },
  });
  expect(saved.ok()).toBe(true);
  await page.goto(`/d/${doc.id}`);
  await page.getByText('Long note line 119', { exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByTestId('document-title')).not.toBeInViewport();
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  await page.getByRole('button', { name: 'Mic only', exact: true }).click();
  const feedback = page.getByRole('alert').filter({ hasText: 'Recording needs attention' });
  await expect(feedback).toContainText('Microphone access denied');
  await expect(feedback).toBeInViewport();
  const retry = feedback.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeInViewport();
  await retry.click();
  await expect(page.locator('html')).toHaveAttribute('data-mic-attempts', '2');
  await expect(retry).toBeInViewport();
  await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
});

test('browser mic recording streams to mock STT and persists through cookie-authenticated sync', async ({
  page,
  baseURL,
}) => {
  let syncConnections = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/sync/events') syncConnections++;
  });
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
  await expect(page.locator('html')).toHaveAttribute('data-sync-live', '');
  const connectionsBeforeStart = syncConnections;
  await page.getByRole('button', { name: 'Record', exact: true }).click();
  const pushed = page.waitForResponse(
    (response) => response.url().endsWith('/api/sync/push') && response.ok(),
  );
  await page.getByRole('button', { name: 'Mic only', exact: true }).click();
  await expect(page.getByTestId('web-recording')).toHaveAttribute('data-status', 'recording');
  await expect(page.getByTestId('note-bottom-bar').getByTestId('web-recording')).toBeVisible();
  const response = await pushed;
  const headers = await response.request().allHeaders();
  expect(headers['origin']).toBe(baseURL);
  expect(Boolean(headers['cookie'])).toBe(true);
  expect(headers['authorization']).toBeUndefined();
  const heldBefore = await page.evaluate(async () =>
    (await navigator.locks.query()).held?.map((lock) => lock.name),
  );
  expect(heldBefore?.filter((name) => name?.startsWith('oat-recording:'))).toHaveLength(2);
  expect(syncConnections).toBe(connectionsBeforeStart);
  const otherTab = await page.context().newPage();
  await otherTab.goto(`/d/${doc.id}`);
  await otherTab.getByRole('button', { name: 'Record', exact: true }).click();
  await otherTab.getByRole('button', { name: 'Mic only', exact: true }).click();
  await expect(
    otherTab.getByRole('alert').filter({ hasText: 'Recording needs attention' }),
  ).toContainText('This note is already being recorded in another tab');
  await otherTab.close();
  await page.bringToFront();
  await expect(page.locator('html')).toHaveAttribute('data-sync-live', '');
  const connectionsAfterTabSwitch = syncConnections;
  await expect(page.getByTestId('web-recording')).toHaveAttribute('data-status', 'recording');
  await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
  await page.getByTestId('transcript-toggle').click();
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
  await page.getByRole('link', { name: 'Oat', exact: true }).click();
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
  expect(syncConnections).toBe(connectionsAfterTabSwitch);
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
  for (const close of ['escape', 'pill', 'button']) {
    if (close === 'escape') await page.keyboard.press('Escape');
    else if (close === 'pill') await page.getByTestId('transcript-toggle').click();
    else await page.getByTestId('panel-close').click();
    await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
    await expect
      .poll(() =>
        page.getByTestId('playback-audio').evaluate((audio: HTMLAudioElement) => audio.paused),
      )
      .toBe(true);
    await page.getByTestId('transcript-toggle').click();
    await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');
    if (close !== 'button') {
      await page.getByTestId('playback-toggle').click();
      await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'playing');
    }
  }
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
  const userId = (await (await page.request.get('/api/auth/get-session')).json()).user.id as string;
  const metadata = await page.evaluate(
    async ({ id, userId }) => {
      const root = await navigator.storage.getDirectory();
      const account = await (await root.getDirectoryHandle('oat-audio')).getDirectoryHandle(userId);
      const dir = await account.getDirectoryHandle(id);
      return JSON.parse(await (await (await dir.getFileHandle('metadata.json')).getFile()).text());
    },
    { id: meeting.meetingId, userId },
  );
  expect(metadata.finalized).toBe(true);
  expect(metadata.parts).toHaveLength(2);
  await expect(page.getByRole('radiogroup', { name: 'Listen to' })).toHaveCount(0);
  await page.getByTestId('playback-toggle').click();
  await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'playing');
  await expect
    .poll(
      async () => ({
        ended: await page
          .getByTestId('playback-audio')
          .evaluate((audio: HTMLAudioElement) => audio.ended),
        ms: Number(
          await page
            .getByTestId('playback')
            .locator('[data-current-ms]')
            .getAttribute('data-current-ms'),
        ),
      }),
      { timeout: 10000 },
    )
    .toEqual({ ended: true, ms: Math.round(metadata.parts.at(-1).endMs / 100) * 100 });
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
    await expect(page.getByTestId('pipeline-status')).toContainText('Post-meeting: done');
    await page.reload();
    await expect(page.getByTestId('playback')).toHaveAttribute('data-state', 'paused');
    if (!(await page.getByTestId('enhance-button').textContent())?.includes('Regenerate')) {
      await page.getByTestId('enhance-button').click();
      await expect(page.getByText('Notes enhanced', { exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('enhance-button')).toContainText('Regenerate');
    await page.getByTestId('document-more').click();
    await expect(page.getByTestId('history-button')).toBeVisible();
    await expect(page.getByTestId('notion-send')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('history-button')).not.toBeVisible();
    const actions = page.getByTestId('document-actions');
    const boxes = await Promise.all([
      actions.getByTestId('enhance-button').boundingBox(),
      actions.getByRole('button', { name: 'Share', exact: true }).boundingBox(),
      actions.getByTestId('document-more').boundingBox(),
    ]);
    expect(boxes.every((box) => box && Math.abs(box.y - boxes[0]!.y) < 3)).toBe(true);
    await page.screenshot({
      path: `${process.env.E2E_PLAYBACK_SCREENSHOTS}/web-play-light.png`,
      animations: 'disabled',
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
