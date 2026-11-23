import AxeBuilder from '@axe-core/playwright';

import { runCommand } from './docs-helpers';
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
    await expect(sidebar.getByRole('button', { name: 'New note' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'New note' })).toHaveCount(0);
    await expect(header.getByRole('button', { name: 'Search' })).toHaveCount(0);
    await expect(header.getByTestId('theme-menu')).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');

    await runCommand(page, 'Templates');
    await expect(page).toHaveURL(/\/templates$/);
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await runCommand(page, 'Trash');
    await expect(page.getByTestId('trash-dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByRole('menu')).toContainText('Create workspace');
    // Tasks, Templates and Trash are in the palette, not the menu.
    await expect(page.getByRole('menuitem', { name: 'Templates', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Trash/ })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /^Settings/ })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem').last()).toHaveText('Sign out');
    // Live sync says nothing while it works; the menu only reports it reconnecting.
    await expect(page.getByRole('menu').getByText('Reconnecting live sync…')).toBeHidden();
    await page.evaluate(() => delete document.documentElement.dataset.syncLive);
    await expect(page.getByRole('menu').getByText('Reconnecting live sync…')).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.dataset.syncLive = '';
    });
    await expect(page.getByRole('menu').getByText('Reconnecting live sync…')).toBeHidden();
    await page.keyboard.press('Escape');
    await page.getByTestId('sidebar-header-trigger').click();
    await expect(page.locator(sidebarSelector)).toHaveAttribute('data-state', 'collapsed');
    await expect(sidebar).toHaveCSS('width', '48px');
    const controls = [
      sidebar.getByRole('button', { name: 'New note' }),
      page.getByTestId('workspace-switcher'),
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
    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.evaluate(() => document.fonts.ready);
    const { violations } = await new AxeBuilder({ page })
      .include('[data-testid="app-sidebar"]')
      .include('[data-testid="top-bar"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations).toEqual([]);
  });
}
