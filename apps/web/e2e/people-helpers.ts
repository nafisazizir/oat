import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { createMailpit, extractFirstLink, waitFor } from '@oat/testkit';
import type { Browser, BrowserContext, Page } from '@playwright/test';

import { openMagicLink, SIGNED_OUT } from './auth-helpers';
import { expect, hydrationAware } from './fixtures';

/**
 * Real people for multi-user specs (join.spec, private-shared.spec): users signed up by magic link on a
 * company domain of their own per test (so no other spec's users ever match), an owner with a named
 * workspace, the Joining settings, axe scans and evidence screenshots
 * (`E2E_SCREENSHOTS=1` writes docs/tasks/evidence/unified-workspaces).
 */
const mailpit = createMailpit();
const EVIDENCE = fileURLToPath(
  new URL('../../../docs/tasks/evidence/unified-workspaces/', import.meta.url),
);

export type Theme = 'light' | 'dark';

export const rand = () => randomBytes(4).toString('hex');
/** A company domain nobody else uses. */
export const newDomain = () => `co-${rand()}.test`;

export async function shot(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

/**
 * Every axe violation (any impact), as short lines. `within`: scan only that part of the page — the join
 * settings and the requests list are sections of existing settings pages inside the app shell, whose own
 * findings belong to the main a11y sweep (`a11y.spec.ts`); the join screen is scanned whole.
 */
export async function violations(page: Page, label: string, within?: string): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  // Toasts are transient, and a colour mid-transition isn't a colour anyone reads: scan the settled page.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  const builder = new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    // The Next.js dev-mode indicator isn't part of the product.
    .exclude('nextjs-portal');
  const result = await (within ? builder.include(within) : builder).analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map((n) => `${label}: ${v.id} (${v.impact}) ${n.target.join(' ')}`),
  );
}

/** The newest email to `to` whose subject matches. */
export function mailTo(to: string, subject: RegExp) {
  return waitFor(
    async () => {
      const latest = await mailpit.latestFor(to);
      return latest && subject.test(latest.Subject) ? latest : undefined;
    },
    { timeout: 15_000, message: `no "${subject.source}" email to ${to}` },
  );
}

export type Person = { context: BrowserContext; page: Page; email: string };

/** A new user on `domain`, signed in by magic link; wherever that lands them (`/home` or `/join`). */
export async function signUp(
  browser: Browser,
  prefix: string,
  domain: string,
  theme: Theme = 'light',
): Promise<Person> {
  const context = await browser.newContext({
    storageState: SIGNED_OUT,
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript((value) => localStorage.setItem('oat-theme', value), theme);
  const page = hydrationAware(await context.newPage());
  const email = `${prefix}-${rand()}@${domain}`;
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = extractFirstLink(await mailTo(email, /^Sign in to Oat$/));
  await openMagicLink(page, link!);
  await page.waitForURL(/\/(home|join)$/);
  return { context, page, email };
}

/** An owner with a named workspace, on its own domain. */
export async function company(browser: Browser, theme: Theme = 'light') {
  const domain = newDomain();
  const name = `Acme ${rand()}`;
  const owner = await signUp(browser, 'owner', domain, theme);
  await expect(owner.page).toHaveURL(/\/home$/);
  await owner.page.getByTestId('workspace-switcher').click();
  await owner.page.getByRole('menuitem', { name: 'Create workspace' }).click();
  const dialog = owner.page.getByTestId('create-workspace-dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(dialog).toBeHidden();
  await expect(owner.page.getByTestId('workspace-switcher')).toContainText(name);
  return { owner, domain, name };
}

/** Owner: Settings → Workspace → Joining. Allows the owner's own domain and (optionally) sets the policy. */
export async function openJoining(
  owner: Person,
  domain: string,
  policy?: { testId: 'request' | 'auto_join'; label: string },
) {
  const { page } = owner;
  await page.goto('/settings/workspace');
  const settings = page.getByTestId('join-settings').filter({ visible: true });
  await expect(settings.getByRole('heading', { name: 'Joining' })).toBeVisible();
  // A new workspace is invite-only, with no domain.
  await expect(settings.getByRole('radio', { name: /^Invite only/ })).toBeChecked();
  await expect(settings.getByTestId('join-domain')).toHaveCount(0);
  // The only domain on offer is the owner's own; there is nothing to type.
  await expect(settings.getByRole('textbox')).toHaveCount(0);
  await settings.getByRole('button', { name: `Allow ${domain}` }).click();
  await expect(settings.getByTestId('join-domain')).toHaveText([new RegExp(domain)]);
  await expect(settings.getByRole('button', { name: `Allow ${domain}` })).toHaveCount(0);
  if (policy) {
    await settings.getByTestId(`join-policy-${policy.testId}`).click();
    await expect(page.getByText('Join setting saved')).toBeVisible();
    await expect(
      settings.getByRole('radio', { name: new RegExp(`^${policy.label}`) }),
    ).toBeChecked();
  }
  return settings;
}
