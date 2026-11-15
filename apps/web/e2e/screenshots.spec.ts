import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { SIGNED_OUT } from './auth-helpers';
import { apiCreateDocument } from './docs-helpers';
import { expect, test } from './fixtures';

/**
 * Evidence screenshots (light + dark) for docs/tasks/evidence/1.4. Opt-in so `pnpm e2e` doesn't
 * rewrite tracked images on every run:
 *   E2E_PORT=3104 pnpm --filter @oat/web e2e:screenshots
 */
const outDir =
  process.env.E2E_SCREENSHOTS_DIR ??
  fileURLToPath(new URL('../../../docs/tasks/evidence/1.4/', import.meta.url));

test.skip(!process.env.E2E_SCREENSHOTS, 'set E2E_SCREENSHOTS=1 (pnpm e2e:screenshots)');
test.use({ viewport: { width: 1440, height: 900 } });

async function shoot(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300); // let enter animations settle
  await page.screenshot({
    path: `${outDir}${name}.png`,
    // Hide the Next.js dev-mode indicator.
    style: 'nextjs-portal { display: none !important; }',
  });
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeAll(() => mkdirSync(outDir, { recursive: true }));
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    });

    test('app pages', async ({ page }) => {
      await page.goto('/home');
      await expect(page.getByText('No meeting notes yet')).toBeVisible();
      await shoot(page, `home-${theme}`);

      const doc = await apiCreateDocument(page, { title: 'Reading list' });
      await page.goto(`/d/${doc.id}`);
      await expect(page.getByTestId('document-title')).toHaveValue('Reading list');
      await shoot(page, `document-${theme}`);

      await page.goto('/settings');
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
      await shoot(page, `settings-${theme}`);

      await page.goto('/home');
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await shoot(page, `command-palette-${theme}`);
      await page.keyboard.press('Escape');

      await page.getByTestId('workspace-switcher').click();
      await expect(page.getByRole('menu')).toBeVisible();
      await shoot(page, `workspace-switcher-${theme}`);
      await page.keyboard.press('Escape');

      await page.getByTestId('sidebar-trigger').click();
      await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toBeVisible();
      await shoot(page, `sidebar-collapsed-${theme}`);
    });

    test.describe('signed out', () => {
      // The share 404 is recovered on the client by Next.js, and React (dev) warns about the root
      // layout's theme script while doing so (see docs/tasks/5.3-sharing.md, Design notes).
      test.use({ storageState: SIGNED_OUT, allowConsoleErrors: true });

      test('public pages', async ({ page }) => {
        await page.goto('/sign-in');
        await expect(page.getByText('Welcome to Oat')).toBeVisible();
        await shoot(page, `sign-in-${theme}`);

        await page.goto('/share/abc123token');
        await expect(
          page.getByRole('heading', { name: 'This link isn’t available' }),
        ).toBeVisible();
        await shoot(page, `share-${theme}`);
      });
    });

    test.describe('states', () => {
      test.use({ allowConsoleErrors: true });

      test('error and not-found', async ({ page }) => {
        await page.goto('/d/__error');
        await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
        await shoot(page, `error-${theme}`);

        await page.goto('/d/does-not-exist');
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
        await shoot(page, `not-found-${theme}`);

        await page.goto('/dev-probes/global-error');
        await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
        await shoot(page, `global-error-${theme}`);
      });
    });

    test('mobile', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/home');
      await expect(page.getByText('No meeting notes yet')).toBeVisible();
      await shoot(page, `mobile-home-${theme}`);
      await page.getByTestId('sidebar-trigger').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shoot(page, `mobile-sidebar-${theme}`);
    });
  });
}
