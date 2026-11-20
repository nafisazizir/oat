import { fileURLToPath } from 'node:url';

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
  await expect(page.getByTestId('recording-sync')).toHaveText('Transcript saved', {
    timeout: 30000,
  });
  const persisted = await page.getByTestId('transcript-segment').count();
  const words = await page.getByTestId('transcript-segment').allTextContents();
  expect(persisted).toBeGreaterThan(0);
  await page.reload();
  await expect(page.getByTestId('transcript-segment')).toHaveCount(persisted);
  await expect(page.getByTestId('transcript-segment')).toHaveText(words);
  await expect(page.getByRole('button', { name: 'Record', exact: true })).toHaveCount(0);
});
