import type { Locator } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { apiCreateDocument } from './docs-helpers';
import { expect, test } from './fixtures';

// Each test signs its own user up instead of using the shared signed-in one: every page load opens the
// `/api/sync/events` stream, which is limited to 30 connects a minute *per user*. These two tests alone
// load 12 pages within seconds, on top of the other workers' specs running as the shared user, and the
// 429s that followed failed the console guard (e2e-calm-shell-specs).
test.use({ storageState: SIGNED_OUT });

async function sansTitle(title: Locator) {
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS('font-family', /Inter Variable/);
  await expect(title).toHaveCSS('font-weight', '450');
}

for (const theme of ['light', 'dark'] as const) {
  test(`headings and body stay Inter while mono uses Geist (${theme})`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    await page.goto('/sign-in');
    await signInWithMagicLink(page, uniqueAddress(`e2e-typography-${theme}`), baseURL!);
    await page.goto('/home');
    const homeNote = await apiCreateDocument(page, {
      title: `Home typography ${theme}`,
      kind: 'page',
    });
    await page.goto('/home');
    await sansTitle(page.getByRole('heading', { level: 1, name: 'Home', exact: true }));
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
