import type { Locator } from '@playwright/test';

import { apiCreateDocument } from './docs-helpers';
import { expect, test } from './fixtures';

async function sansTitle(title: Locator) {
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS('font-family', /Inter Variable/);
  await expect(title).toHaveCSS('font-weight', '450');
}

for (const theme of ['light', 'dark'] as const) {
  test(`headings and body stay Inter while mono uses Geist (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    await page.goto('/home');
    const homeNote = await apiCreateDocument(page, {
      title: `Home typography ${theme}`,
      kind: 'page',
    });
    await page.goto('/home');
    await expect(page.getByRole('heading', { level: 1, name: 'Home', exact: true })).toHaveClass(
      'sr-only',
    );
    const homeTitle = page
      .getByTestId('home-note-row')
      .filter({ hasText: homeNote.title })
      .locator('span');
    await expect(homeTitle).toBeVisible();
    await expect(homeTitle).toHaveCSS('font-family', /Inter Variable/);
    await expect(homeTitle).toHaveCSS('font-weight', '400');

    for (const kind of ['page', 'meeting'] as const) {
      const doc = await apiCreateDocument(page, { title: `Typography ${kind}`, kind });
      await page.goto(`/d/${doc.id}`);
      const title = page.getByTestId('document-title');
      await sansTitle(title);
      await title.fill('');
      await expect(title).toHaveValue('');
      await sansTitle(title);
      const editor = page.getByTestId('note-editor').locator('[contenteditable=true]');
      await expect(editor).toHaveCSS('font-family', /Inter Variable/);
      await editor.fill('A clear thought.');
      await expect(editor).toContainText('A clear thought.');
    }

    await page.goto('/settings');
    await sansTitle(page.getByRole('heading', { level: 1, name: 'Appearance', exact: true }));
    const mono = page.getByRole('code').filter({ hasText: '.env' });
    await expect(mono).toHaveCSS('font-family', /Geist Mono Variable/);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('400 14px "Geist Mono Variable"'))).toBe(
      true,
    );

    await page.goto('/d/does-not-exist');
    await sansTitle(page.getByRole('heading', { level: 1, name: 'Page not found', exact: true }));
  });
}
