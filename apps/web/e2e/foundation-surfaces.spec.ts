import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { expect, test } from './fixtures';
import { seedSweepContent } from './sweep-helpers';

const outDir =
  process.env.E2E_SWEEP_DIR ??
  fileURLToPath(new URL('../../../docs/tasks/evidence/ui-final-pass/', import.meta.url));

test.skip(!process.env.E2E_SCREENSHOTS, 'set E2E_SCREENSHOTS=1');
test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 1000 } });
test.setTimeout(180_000);

for (const theme of ['light', 'dark'] as const) {
  test(`bridge-free surfaces (${theme})`, async ({ page, baseURL }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    await page.goto('/sign-in');
    await signInWithMagicLink(page, uniqueAddress(`bridge-${theme}`), baseURL!);
    const content = await seedSweepContent(page);
    mkdirSync(outDir, { recursive: true });

    for (const [name, route] of [
      ['home', '/home'],
      ['document', `/d/${content.page.id}`],
      ['meeting', `/d/${content.meeting.id}`],
      ['settings', '/settings'],
    ] as const) {
      await page.goto(route);
      if (name === 'document') {
        await expect(page.getByTestId('document-title')).toHaveValue('Product roadmap');
        await expect(
          page.getByTestId('note-editor').getByText('Themes', { exact: true }),
        ).toBeVisible();
      } else if (name === 'meeting') {
        await expect(page.getByTestId('meeting-header').filter({ visible: true })).toBeVisible();
        await expect(page.getByTestId('transcript-panel')).toBeVisible();
      } else {
        await expect(
          page.getByRole('heading', { level: 1, name: name === 'home' ? 'Home' : 'Settings' }),
        ).toBeVisible();
      }
      if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      else await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({
        path: join(outDir, `bridge-${name}-${theme}.png`),
        fullPage: true,
        style: 'nextjs-portal { display: none !important; }',
      });
    }
  });
}
