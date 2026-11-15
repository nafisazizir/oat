import { expect, type Page, test as base } from '@playwright/test';

/**
 * Waits until React has hydrated the current page (`<html data-hydrated>`, set by the root `Providers`).
 * Until then menus, dialogs and fetch-on-click buttons are dead: a click lands, nothing happens, and the
 * test times out waiting for what it should have opened. On a busy machine `next dev` takes seconds to
 * hydrate, which made e2e flaky under load (ci-flakes). Pages that aren't our Next app (the mock OAuth
 * issuer, API responses) are left alone.
 */
export async function waitForHydration(page: Page): Promise<void> {
  const isNextPage = await page
    .evaluate(() => document.contentType === 'text/html' && '__next_f' in window)
    .catch(() => false); // navigated away / closed meanwhile: nothing to wait for
  if (!isNextPage) return;
  await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
  // A streamed segment React already rendered on the client can still sit in the DOM for a moment as a
  // hidden copy (`<div hidden id="S:n">`): its duplicate test ids would trip strict locators (3.4).
  await page
    .waitForFunction(() => !document.querySelector('div[hidden][id^="S:"]'))
    .catch(() => {}); // navigated away / closed meanwhile
}

/**
 * Makes `goto`, `reload`, `goBack`, `goForward` and `waitForURL` resolve only once the page they land
 * on has hydrated (see `waitForHydration`). The `page` fixture already is; use this for pages opened from
 * extra browser contexts.
 */
export function hydrationAware(page: Page): Page {
  for (const name of ['goto', 'reload', 'goBack', 'goForward', 'waitForURL'] as const) {
    const original = page[name].bind(page) as (...args: unknown[]) => Promise<unknown>;
    (page as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const result = await original(...args);
      await waitForHydration(page);
      return result;
    };
  }
  return page;
}

/**
 * `test` that fails on any browser console error or uncaught page error (hydration mismatches,
 * React warnings logged as errors, failed chunk loads). Opt out per test with
 * `test.use({ allowConsoleErrors: true })` when an error is the point of the test. Its `page` waits for
 * hydration after navigations (`hydrationAware`).
 */
export const test = base.extend<{ allowConsoleErrors: boolean; consoleGuard: void }>({
  allowConsoleErrors: [false, { option: true }],
  page: async ({ page }, use) => {
    await use(hydrationAware(page));
  },
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
