import AxeBuilder from '@axe-core/playwright';

import { expect, sidebarSelector, test } from './fixtures';

test.use({ viewport: { width: 1440, height: 900 } });

for (const theme of ['light', 'dark'] as const) {
  test(`calm shell controls work expanded and collapsed (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    await page.goto('/home');
    const sidebar = page.getByTestId('app-sidebar');
    const header = page.getByTestId('top-bar');
    await expect(header).toHaveCSS('border-bottom-width', '0px');
    await expect(header.getByRole('button', { name: 'New note' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Search' })).toHaveCount(0);
    await expect(header.getByTestId('theme-menu')).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');

    await sidebar.getByRole('link', { name: 'Templates', exact: true }).click();
    await expect(page).toHaveURL(/\/templates$/);
    await sidebar.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.getByTestId('open-trash').click();
    await expect(page.getByTestId('trash-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('workspace-switcher').click();
    // "Workspace" with one workspace, "Workspaces" (the list) with more (D-36).
    await expect(page.getByRole('menu')).toContainText('Workspace');
    await expect(page.getByRole('menu')).toContainText('Account');
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('sidebar-trigger').click();
    await expect(page.locator(sidebarSelector)).toHaveAttribute('data-state', 'collapsed');
    await expect(sidebar).toHaveCSS('width', '48px');
    const controls = [
      sidebar.getByRole('link', { name: 'Templates', exact: true }),
      page.getByTestId('open-trash'),
      sidebar.getByRole('link', { name: 'Settings', exact: true }),
      page.getByTestId('theme-menu'),
    ];
    const boxes = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
      boxes.push(box);
      await control.focus();
      await expect(control).toBeFocused();
    }
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.x).toBe(boxes[0]!.x);
      expect(boxes[i]!.y).toBeGreaterThan(boxes[i - 1]!.y);
    }
    await page.evaluate(() => document.fonts.ready);
    const { violations } = await new AxeBuilder({ page })
      .include('[data-testid="app-sidebar"]')
      .include('[data-testid="top-bar"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations).toEqual([]);
  });
}
