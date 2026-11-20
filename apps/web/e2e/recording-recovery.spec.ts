import { expect, test } from './fixtures';

test('failed saved-transcript recovery shows a non-blocking warning and retries without losing data', async ({
  page,
}) => {
  await page.goto('/');
  const { user } = await (await page.request.get('/api/auth/get-session')).json();
  const key = `oat-recording-pending:${encodeURIComponent(user.id)}:recovery-test`;
  await page.evaluate(
    ({ key }) => {
      localStorage.setItem(
        key,
        JSON.stringify([
          { op: 'delete', table: 'transcript_segment', id: 'old-segment', version: 1 },
        ]),
      );
    },
    { key },
  );
  let offline = true;
  await page.route('**/api/sync/push', async (route) => {
    const { entries } = route.request().postDataJSON();
    await route.fulfill({
      json: {
        results: entries.map(({ version }: { version: number }) =>
          offline
            ? { version, status: 'rejected', code: 'unavailable', message: 'Offline' }
            : { version, status: 'ok' },
        ),
      },
    });
  });
  await page.reload();
  const warning = page.getByTestId('recording-recovery');
  await expect(warning).toContainText('Saved transcript could not be synced');
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).not.toBeNull();
  offline = false;
  await warning.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(warning).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBeNull();
});
