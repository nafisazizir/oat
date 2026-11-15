import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { openPlayground } from './helpers.ts';

// Evidence screenshots, only when SCREENSHOTS_DIR is set (`pnpm --filter @oat/editor screenshots`).
const outDir = process.env.SCREENSHOTS_DIR;

test.describe('screenshots', () => {
  test.skip(!outDir, 'set SCREENSHOTS_DIR to write evidence screenshots');
  test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

  for (const theme of ['light', 'dark'] as const) {
    test(`editor (${theme})`, async ({ page }) => {
      const dir = resolve(outDir!);
      mkdirSync(dir, { recursive: true });
      await page.emulateMedia({ colorScheme: theme });

      // Full sample note: my text vs AI text, every block type.
      const editor = await openPlayground(page, { doc: 'sample', theme });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(dir, `editor-${theme}.png`), fullPage: true });

      // Bubble menu over a selection.
      await editor.locator('h2').first().click();
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+Home');
      await expect(page.getByRole('toolbar', { name: 'Text formatting' })).toBeVisible();
      await page.waitForTimeout(300); // let the popup paint its rows
      await page.screenshot({
        path: resolve(dir, `bubble-menu-${theme}.png`),
        clip: { x: 0, y: 0, width: 1280, height: 420 },
      });

      // Slash menu and mention menu in an empty note.
      await openPlayground(page, { doc: 'empty', theme });
      await page.keyboard.type('/');
      await expect(page.getByRole('listbox', { name: 'Insert block' })).toBeVisible();
      await page.waitForTimeout(300); // let the popup paint its rows
      await page.screenshot({ path: resolve(dir, `slash-menu-${theme}.png`) });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Backspace');
      await page.keyboard.type('Sync with @');
      await expect(page.getByRole('listbox', { name: 'Mention a person' })).toBeVisible();
      await page.waitForTimeout(300); // let the popup paint its rows
      await page.screenshot({
        path: resolve(dir, `mention-menu-${theme}.png`),
        clip: { x: 0, y: 0, width: 1280, height: 520 },
      });
    });
  }
});
