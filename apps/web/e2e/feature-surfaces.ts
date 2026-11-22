import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export async function verifyFeatureSurface(page: Page, name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((theme) => {
      localStorage.setItem('oat-theme', theme);
      window.dispatchEvent(new StorageEvent('storage', { key: 'oat-theme', newValue: theme }));
    }, theme);
    await expect(page.locator('html')).toHaveClass(
      theme === 'dark' ? /dark/ : /^(?!.*\bdark\b).*$/,
    );
    await page.evaluate(() => document.fonts.ready);
    const { violations } = await new AxeBuilder({ page })
      .exclude('nextjs-portal')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations, `${name} (${theme}): AA contrast and WCAG 2.2 target size`).toEqual([]);
    const output = process.env.FEATURE_UI_SCREENSHOTS;
    if (output) {
      mkdirSync(output, { recursive: true });
      await page.screenshot({
        path: join(output, `web-${name}-${theme}.png`),
        style: 'nextjs-portal { display:none!important; }',
      });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => {
    localStorage.setItem('oat-theme', 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: 'oat-theme', newValue: 'light' }));
  });
}
