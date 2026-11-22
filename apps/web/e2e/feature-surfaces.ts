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
    if (name === 'assistant-empty') {
      const session = await page.getByTestId('chat-session').boundingBox();
      const greeting = await page.getByTestId('chat-empty').boundingBox();
      const suggestions = await page.getByTestId('chat-suggestions').boundingBox();
      expect(session && greeting && suggestions).toBeTruthy();
      expect(
        Math.abs(
          (greeting!.y + suggestions!.y + suggestions!.height) / 2 -
            (session!.y + session!.height / 2),
        ),
      ).toBeLessThan(16);
    }
    if (name === 'assistant-answer') {
      const chip = page.getByTestId('citation-chip').first();
      await expect(chip).toHaveAttribute('title', /.+/);
      const style = await chip.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.getBoundingClientRect().height,
          border: style.borderTopStyle,
          spacing: parseFloat(style.marginInlineStart),
        };
      });
      expect(style.height).toBeGreaterThanOrEqual(24);
      expect(style.border).toBe('solid');
      expect(style.spacing).toBeGreaterThanOrEqual(4);
      await expect(page.getByTestId('answer-sources').first()).toBeVisible();
      const session = await page.getByTestId('chat-session').boundingBox();
      const input = await page.getByTestId('chat-input').boundingBox();
      expect(session!.y + session!.height - (input!.y + input!.height)).toBeLessThan(64);
    }
    if (name === 'tasks') {
      const owner = page.getByTestId('task-owner').first();
      const avatar = await owner.locator('[data-slot="avatar"]').boundingBox();
      expect(avatar?.height).toBe(20);
      expect(avatar?.width).toBe(20);
      expect(
        await owner.evaluate((element) => parseFloat(getComputedStyle(element).columnGap)),
      ).toBeGreaterThanOrEqual(4);
      const due = await page.getByTestId('task-due').first().boundingBox();
      const badge = await owner.boundingBox();
      expect(badge?.height).toBe(due?.height);
    }
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
