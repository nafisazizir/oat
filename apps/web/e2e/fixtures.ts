import { expect, test as base } from '@playwright/test';

/**
 * `test` that fails on any browser console error or uncaught page error (hydration mismatches,
 * React warnings logged as errors, failed chunk loads). Opt out per test with
 * `test.use({ allowConsoleErrors: true })` when an error is the point of the test.
 */
export const test = base.extend<{ allowConsoleErrors: boolean; consoleGuard: void }>({
  allowConsoleErrors: [false, { option: true }],
  consoleGuard: [
    async ({ page, allowConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await use();
      if (!allowConsoleErrors) expect(errors, 'browser console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** The desktop sidebar's outer element carries `data-state="expanded|collapsed"`. */
export const sidebarSelector = '[data-slot="sidebar"][data-state]';
