import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { expect, hydrationAware, test } from './fixtures';
import { seedSweepContent } from './sweep-helpers';

/**
 * Task 9.3 design sweep: every web route in light + dark, at desktop (1440) and phone (390) widths, with
 * realistic content. Opt-in (writes tracked evidence images):
 *   E2E_PORT=3107 E2E_SCREENSHOTS=1 pnpm --filter @oat/web exec playwright test design-sweep
 * Output: `docs/tasks/evidence/9.3/after/` (`E2E_SWEEP_DIR` overrides, e.g. `…/9.3/before/`).
 */
const outDir =
  process.env.E2E_SWEEP_DIR ??
  fileURLToPath(new URL('../../../docs/tasks/evidence/9.3/after/', import.meta.url));

test.skip(!process.env.E2E_SCREENSHOTS, 'set E2E_SCREENSHOTS=1');
// Fresh user per run (content is predictable); the error/404 routes log console errors on purpose.
test.use({ storageState: SIGNED_OUT, allowConsoleErrors: true });
test.setTimeout(300_000);

const viewports = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

async function shoot(page: Page, name: string) {
  mkdirSync(outDir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400); // enter animations, streamed segments
  await page.screenshot({
    path: `${outDir}${name}.png`,
    fullPage: true,
    style: 'nextjs-portal { display: none !important; }',
  });
}

async function visit(page: Page, url: string, ready: (page: Page) => Locator) {
  await page.goto(url);
  await expect(ready(page).first()).toBeVisible();
}

const h1 = (name: string | RegExp) => (page: Page) => page.getByRole('heading', { level: 1, name });

for (const theme of ['light', 'dark'] as const) {
  for (const [size, viewport] of Object.entries(viewports)) {
    test(`sweep ${theme} ${size}`, async ({ page, browser, baseURL }) => {
      const tag = `${size}-${theme}`;
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme });
      await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);

      // ── Signed out ────────────────────────────────────────────────────────────────────────
      const anonContext = await browser.newContext({
        storageState: SIGNED_OUT,
        viewport,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const anon = hydrationAware(await anonContext.newPage());
      await visit(anon, '/sign-in', h1('Welcome to Oat'));
      await shoot(anon, `sign-in-${tag}`);
      await visit(anon, '/sign-in/confirm?token=expired', h1(/expired/));
      await shoot(anon, `sign-in-confirm-expired-${tag}`);
      await visit(anon, '/desktop/sign-in', (p) => p.locator('h1'));
      await shoot(anon, `desktop-sign-in-${tag}`);
      await visit(anon, '/invite/not-a-real-invite', (p) => p.locator('h1'));
      await shoot(anon, `invite-invalid-${tag}`);
      await visit(anon, '/share/abc123token', (p) =>
        p.getByRole('heading', { name: 'This link isn’t available' }),
      );
      await shoot(anon, `share-404-${tag}`);
      await visit(anon, '/no-such-page', h1('Page not found'));
      await shoot(anon, `root-not-found-${tag}`);

      // ── Signed in, empty workspace ──────────────────────────────────────────────────────────
      await page.goto('/sign-in');
      await signInWithMagicLink(page, uniqueAddress(`e2e-sweep-${theme}`), baseURL!);
      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByText('No meeting notes yet')).toBeVisible();
      await shoot(page, `home-empty-${tag}`);
      await visit(page, '/tasks', h1('My tasks'));
      await expect(page.locator('[aria-label="Loading tasks"]')).toHaveCount(0);
      await shoot(page, `tasks-empty-${tag}`);
      await visit(page, '/search', h1('Search'));
      await shoot(page, `search-empty-${tag}`);

      // ── Signed in, with content ─────────────────────────────────────────────────────────────
      // The sidebar (which carries the workspace id the API helpers read) is a sheet on phones.
      await page.setViewportSize(viewports.desktop);
      const content = await seedSweepContent(page);
      await page.setViewportSize(viewport);
      await visit(page, '/home', h1('Home'));
      await shoot(page, `home-${tag}`);

      await visit(page, `/d/${content.page.id}`, (p) => p.getByTestId('document-title'));
      await expect(page.getByTestId('document-title')).toHaveValue('Product roadmap');
      await shoot(page, `page-${tag}`);
      await visit(page, `/d/${content.folderId}`, h1('Projects'));
      await shoot(page, `folder-${tag}`);

      await visit(page, `/d/${content.meeting.id}`, (p) =>
        p.getByTestId('meeting-header').filter({ visible: true }),
      );
      await shoot(page, `meeting-${tag}`);
      const toggle = page.getByTestId('assistant-toggle');
      if (await toggle.isVisible()) {
        await toggle.click();
        await expect(page.getByTestId('chat-input')).toBeVisible();
        await shoot(page, `meeting-assistant-${tag}`);
        await page.keyboard.press('ControlOrMeta+j');
        await expect(toggle).toBeVisible();
      }

      await visit(page, '/search?q=pilot', h1('Search'));
      await expect(page.getByText(/Lakeside/).first()).toBeVisible();
      await shoot(page, `search-results-${tag}`);
      await visit(page, '/assistant', (p) => p.getByTestId('assistant-page'));
      await shoot(page, `assistant-${tag}`);
      await visit(page, '/templates', h1('Templates'));
      await shoot(page, `templates-${tag}`);
      await page.getByTestId('template-card').first().click();
      await expect(page.getByText('Built-in templates can’t be edited.')).toBeVisible();
      await shoot(page, `template-builtin-${tag}`);
      await visit(page, '/templates/new', (p) => p.getByRole('textbox', { name: 'Template name' }));
      await shoot(page, `template-new-${tag}`);
      await visit(page, '/settings', h1('Appearance'));
      await shoot(page, `settings-${tag}`);
      await visit(page, '/settings/profile', (p) => p.locator('h1'));
      await shoot(page, `settings-profile-${tag}`);
      await visit(page, '/settings/integrations', (p) => p.locator('h1'));
      await shoot(page, `settings-integrations-${tag}`);
      await visit(page, '/settings/workspace', (p) => p.locator('h1'));
      await shoot(page, `settings-workspace-${tag}`);
      await visit(page, '/settings/workspace/members', (p) => p.locator('h1'));
      await shoot(page, `settings-members-${tag}`);
      await visit(page, '/d/does-not-exist', (p) =>
        p.getByRole('heading', { name: 'Page not found' }),
      );
      await shoot(page, `not-found-${tag}`);
      await visit(page, '/d/__error', (p) => p.getByRole('button', { name: 'Try again' }));
      await shoot(page, `error-${tag}`);

      // Overlays.
      await visit(page, '/home', h1('Home'));
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await shoot(page, `command-palette-${tag}`);
      await page.keyboard.press('Escape');
      if (size === 'mobile') {
        await page.getByTestId('sidebar-trigger').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await shoot(page, `sidebar-${tag}`);
        await page.keyboard.press('Escape');
      }
      await visit(page, `/d/${content.page.id}`, (p) => p.getByTestId('document-title'));
      await page.getByTestId('share-button').click();
      await expect(page.getByTestId('share-dialog')).toBeVisible();
      await shoot(page, `share-dialog-${tag}`);

      // Public share page (needs the link created above).
      await visit(anon, content.shareUrl, (p) => p.getByTestId('shared-document'));
      await shoot(anon, `share-${tag}`);
      await anonContext.close();
    });
  }
}
