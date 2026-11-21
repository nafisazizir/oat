import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

test.use({ viewport: { width: 1440, height: 900 } });

for (const theme of ['light', 'dark'] as const) {
  test(`grouped account settings retain section links and quiet rows (${theme})`, async ({
    page,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    await page.goto('/settings');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(nav.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    for (const [label, title, path] of [
      ['Profile', 'Profile', '/settings/profile'],
      ['Preferences', 'Appearance', '/settings'],
      ['Integrations', 'Integrations', '/settings/integrations'],
      ['General', 'Personal workspace', '/settings/workspace'],
    ]) {
      await nav.getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      const box = (await page.getByTestId('settings-content').boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(640);
      await page.evaluate(() => document.fonts.ready);
      const { violations } = await new AxeBuilder({ page })
        .include('[aria-label="Settings sections"]')
        .include('[data-testid="settings-content"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(violations).toEqual([]);
    }
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: 'Profile', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
  });
}
