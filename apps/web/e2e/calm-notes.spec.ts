import { apiCreateDocument } from './docs-helpers';
import { expect, test } from './fixtures';

test('home groups notes by date and meeting actions use the shell slot', async ({ page }) => {
  await page.goto('/home');
  const doc = await apiCreateDocument(page, { title: 'Calm home fixture', kind: 'meeting' });
  await page.reload();
  const list = page.getByTestId('home-notes');
  await expect(list.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await list.getByRole('link', { name: /Calm home fixture/ }).click();
  await expect(page.getByTestId('top-bar-actions').getByTestId('document-actions')).toBeVisible();
  await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
  await page.getByTestId('transcript-toggle').click();
  await expect(page.getByTestId('transcript-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
  await expect(page.getByTestId('transcript-toggle')).toBeFocused();
  await page.reload();
  await expect(page.getByTestId('document-title')).toHaveValue(doc.title);
  await expect(page.getByTestId('transcript-panel')).toHaveCount(0);
});
