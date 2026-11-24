import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { expect, hydrationAware, test } from './fixtures';
import { waitForIntegrations } from './settings-helpers';
import { seedSweepContent } from './sweep-helpers';

/**
 * Task 9.3: axe-core scan of the main web routes, light and dark (contrast differs), with realistic content.
 * Fails on any `serious` or `critical` violation (WCAG 2.x A/AA rules + axe best practices).
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 900 } });
test.setTimeout(240_000);

type Finding = {
  route: string;
  id: string;
  impact: string;
  help: string;
  targets: { target: string; summary?: string }[];
};

/**
 * Known findings, each ticketed in docs/tasks/9.3-design-pass.md (punch list) with its reason. Keep this
 * list short and specific: a rule id plus the exact elements, never a whole rule or route.
 */
// (9.3b: the editor task checkbox, the one known finding of 9.3, now has a 24 px target.)
const KNOWN: { id: string; target: RegExp; why: string }[] = [];

async function scan(page: Page, route: string): Promise<Finding[]> {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    // The Next.js dev-mode indicator isn't part of the product.
    .exclude('nextjs-portal')
    .analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      route,
      id: v.id,
      impact: v.impact!,
      help: v.help,
      targets: v.nodes
        .map((n) => ({ target: n.target.join(' '), summary: n.failureSummary }))
        .filter(({ target }) => !KNOWN.some((k) => k.id === v.id && k.target.test(target)))
        .slice(0, 5),
    }))
    .filter((finding) => finding.targets.length > 0);
}

type Route = [string, (page: Page) => Promise<void>];

async function scanRoutes(page: Page, routes: Route[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const [route, ready] of routes) {
    await test.step(route, async () => {
      await page.goto(route);
      await ready(page);
      findings.push(...(await scan(page, route)));
    });
  }
  return findings;
}

for (const theme of ['light', 'dark'] as const) {
  test(`note and search routes have no serious/critical axe violations (${theme})`, async ({
    page,
    browser,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    const anonContext = await browser.newContext({
      storageState: SIGNED_OUT,
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    await anonContext.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    const anon = hydrationAware(await anonContext.newPage());

    await page.goto('/sign-in');
    await signInWithMagicLink(page, uniqueAddress(`e2e-a11y-${theme}`), baseURL!);
    await expect(page).toHaveURL(/\/home$/);
    const content = await seedSweepContent(page);

    await expect
      .poll(async () => {
        const response = await page.request.get('/api/search?q=pilot');
        expect(response.ok()).toBe(true);
        const body = await response.json();
        return body.notes?.items.some((hit: { snippetHtml: string }) =>
          hit.snippetHtml?.includes('<mark>'),
        );
      })
      .toBe(true);

    const findings = await scanRoutes(page, [
      ['/home', (p) => expect(p.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()],
      [`/d/${content.page.id}`, (p) => expect(p.getByTestId('document-title')).toBeVisible()],
      [
        `/d/${content.meeting.id}`,
        (p) => expect(p.getByTestId('meeting-header').filter({ visible: true })).toBeVisible(),
      ],
      ['/search?q=pilot', (p) => expect(p.locator('.line-clamp-2 > mark').first()).toBeVisible()],
    ]);
    findings.push(
      ...(await scanRoutes(anon, [
        [content.shareUrl, (p) => expect(p.getByTestId('shared-document')).toBeVisible()],
        ['/share/abc123token', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      ])),
    );
    await anonContext.close();
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  test(`sign-in and workspace routes have no serious/critical axe violations (${theme})`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    const findings = await scanRoutes(page, [
      [
        '/sign-in',
        (p) => expect(p.getByRole('heading', { level: 1, name: 'Welcome to Oat' })).toBeVisible(),
      ],
    ]);
    await signInWithMagicLink(page, uniqueAddress(`e2e-a11y-workspace-${theme}`), baseURL!);
    await expect(page).toHaveURL(/\/home$/);
    findings.push(
      ...(await scanRoutes(page, [
        ['/assistant', (p) => expect(p.getByTestId('chat-input')).toBeVisible()],
        ['/tasks', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
        ['/templates', (p) => expect(p.getByTestId('template-card').first()).toBeVisible()],
        [
          '/templates/new',
          (p) => expect(p.getByRole('textbox', { name: 'Template name' })).toBeVisible(),
        ],
        ['/settings', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
        ['/settings/profile', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
        [
          '/settings/integrations',
          async (p) => {
            await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
            await waitForIntegrations(p);
          },
        ],
        [
          '/settings/workspace/members',
          (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
        ],
      ])),
    );

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
}
