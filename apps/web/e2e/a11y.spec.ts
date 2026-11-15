import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { expect, hydrationAware, test } from './fixtures';
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
const KNOWN: { id: string; target: RegExp; why: string }[] = [
  {
    id: 'target-size',
    target: /^input\[aria-label="Mark as (not )?done"\]$/,
    why: 'editor task checkbox (16px) nested in the note textbox: @oat/editor, out of 9.3 web scope → 9.3b',
  },
];

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

for (const theme of ['light', 'dark'] as const) {
  test(`main routes have no serious/critical axe violations (${theme})`, async ({
    page,
    browser,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
    const findings: Finding[] = [];

    const anonContext = await browser.newContext({
      storageState: SIGNED_OUT,
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    const anon = hydrationAware(await anonContext.newPage());
    await anon.goto('/sign-in');
    await expect(anon.getByRole('heading', { level: 1, name: 'Welcome to Oat' })).toBeVisible();
    findings.push(...(await scan(anon, '/sign-in')));

    await page.goto('/sign-in');
    await signInWithMagicLink(page, uniqueAddress(`e2e-a11y-${theme}`), baseURL!);
    await expect(page).toHaveURL(/\/home$/);
    const content = await seedSweepContent(page);

    const routes: [string, (p: Page) => Promise<void>][] = [
      ['/home', (p) => expect(p.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()],
      [`/d/${content.page.id}`, (p) => expect(p.getByTestId('document-title')).toBeVisible()],
      [
        `/d/${content.meeting.id}`,
        (p) => expect(p.getByTestId('meeting-header').filter({ visible: true })).toBeVisible(),
      ],
      ['/search?q=pilot', (p) => expect(p.getByText(/Lakeside/).first()).toBeVisible()],
      ['/assistant', (p) => expect(p.getByTestId('chat-input')).toBeVisible()],
      ['/tasks', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      ['/templates', (p) => expect(p.getByTestId('template-card').first()).toBeVisible()],
      [
        '/templates/new',
        (p) => expect(p.getByRole('textbox', { name: 'Template name' })).toBeVisible(),
      ],
      ['/settings', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      ['/settings/profile', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      ['/settings/integrations', (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible()],
      [
        '/settings/workspace/members',
        (p) => expect(p.getByRole('heading', { level: 1 })).toBeVisible(),
      ],
    ];
    for (const [route, ready] of routes) {
      await page.goto(route);
      await ready(page);
      findings.push(...(await scan(page, route)));
    }

    await anon.goto(content.shareUrl);
    await expect(anon.getByTestId('shared-document')).toBeVisible();
    findings.push(...(await scan(anon, '/share/[token]')));
    await anon.goto('/share/abc123token');
    await expect(anon.getByRole('heading', { level: 1 })).toBeVisible();
    findings.push(...(await scan(anon, '/share/[unknown]')));
    await anonContext.close();

    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });
}
