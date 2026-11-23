import { extractFirstLink } from '@oat/testkit';
import type { Page } from '@playwright/test';

import { openMagicLink, SIGNED_OUT } from './auth-helpers';
import { expect, hydrationAware, test } from './fixtures';
import {
  company,
  mailTo,
  newDomain,
  openJoining,
  rand,
  shot,
  signUp,
  violations,
} from './people-helpers';

/**
 * Joining a workspace by email domain (D-36, task unified-workspaces step B), with real users on a company
 * domain of their own per test (so no other spec's users ever match): what a newcomer sees under each of
 * the three join policies, the owner's side (policy + domain in settings, requests on the members page),
 * and the emails (Mailpit). The request flow runs in light and dark with an axe scan of the three new
 * screens; `E2E_SCREENSHOTS=1` writes docs/tasks/evidence/unified-workspaces.
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

const choice = (page: Page, workspace: string) =>
  page.getByTestId('join-choice').filter({ hasText: workspace });

const memberRow = (page: Page, email: string) =>
  page.getByTestId('member-row').filter({ visible: true }).filter({ hasText: email });

const requestRow = (page: Page, email: string) =>
  page.getByTestId('join-request-row').filter({ visible: true }).filter({ hasText: email });

test('invite_only: a matching stranger is never shown the workspace; an invitation shows on the join screen', async ({
  browser,
}) => {
  const { owner, domain, name } = await company(browser);
  // The domain is allowed, but the policy stays "Invite only".
  await openJoining(owner, domain);

  // Same domain, not invited: no join screen, straight into a workspace of their own.
  const stranger = await signUp(browser, 'stranger', domain);
  await expect(stranger.page).toHaveURL(/\/home$/);
  await expect(stranger.page.getByTestId('workspace-switcher')).toContainText('My workspace');
  await stranger.page.goto('/join');
  await expect(stranger.page).toHaveURL(/\/home$/);
  // One workspace, their own: nothing to switch to (step C), and the menu doesn't name the other one.
  await expect(stranger.page.getByTestId('workspace-switcher')).toHaveAttribute(
    'data-switchable',
    'false',
  );
  await stranger.page.getByTestId('workspace-switcher').click();
  await expect(stranger.page.getByRole('menu')).toBeVisible();
  await expect(stranger.page.getByTestId('workspace-option')).toHaveCount(1);
  await expect(stranger.page.getByRole('menu')).not.toContainText(name);
  await stranger.context.close();

  // Invited: the invitation is on the join screen (no trip through the email link needed).
  const invitee = `invitee-${rand()}@${domain}`;
  await owner.page.goto('/settings/workspace/members');
  await owner.page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = owner.page.getByTestId('invite-dialog');
  await dialog.getByLabel('Email').fill(invitee);
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(dialog).toBeHidden();
  await mailTo(invitee, /invited you to/);

  const context = await browser.newContext({ storageState: SIGNED_OUT });
  const page = hydrationAware(await context.newPage());
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(invitee);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await openMagicLink(page, extractFirstLink(await mailTo(invitee, /^Sign in to Oat$/))!);
  await page.waitForURL(/\/join$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Join a workspace' })).toBeVisible();
  await expect(choice(page, name)).toHaveAttribute('data-kind', 'invite');
  await expect(choice(page, name)).toContainText('invited you as a member');
  await page.getByRole('button', { name: `Accept the invitation to ${name}` }).click();
  await page.waitForURL(/\/home$/);
  await expect(page.getByTestId('workspace-switcher')).toContainText(name);
  await context.close();
  await owner.context.close();
});

for (const theme of ['light', 'dark'] as const) {
  test(`request: ask to join, an owner approves with a role or declines; axe clean (${theme})`, async ({
    browser,
  }) => {
    const found: string[] = [];
    const { owner, domain, name } = await company(browser, theme);
    const settings = await openJoining(owner, domain, {
      testId: 'request',
      label: 'Request access',
    });
    await expect(settings).toBeVisible();
    found.push(...(await violations(owner.page, 'join settings', '[data-testid="join-settings"]')));
    await settings.scrollIntoViewIfNeeded();
    await shot(owner.page, `join-settings-${theme}`);

    // A newcomer on the domain: one calm screen with the workspace and "Request access".
    const asker = await signUp(browser, 'asker', domain, theme);
    await expect(asker.page).toHaveURL(/\/join$/);
    await expect(asker.page.getByRole('heading', { level: 1 })).toHaveText('Join a workspace');
    await expect(asker.page.getByRole('heading')).toHaveCount(1);
    expect((await asker.page.getByRole('main').boundingBox())!.width).toBeLessThanOrEqual(360);
    await expect(asker.page.locator('[data-slot="card"]')).toHaveCount(0);
    await expect(asker.page.getByTestId('join-choice')).toHaveCount(1);
    await expect(choice(asker.page, name)).toHaveAttribute('data-kind', 'request');
    await expect(asker.page.getByRole('button', { name: 'Create my own workspace' })).toBeVisible();
    // Until they choose, the app sends them back here.
    await asker.page.goto('/home');
    await asker.page.waitForURL(/\/join$/);
    found.push(...(await violations(asker.page, 'join screen')));
    await shot(asker.page, `join-screen-match-${theme}`);

    await asker.page.getByRole('button', { name: `Request access to ${name}` }).click();
    await expect(choice(asker.page, name)).toHaveAttribute('data-kind', 'requested');
    await expect(choice(asker.page, name)).toContainText('Requested');
    await expect(asker.page.getByRole('status')).toContainText(`Request sent to ${name}`);
    await expect(asker.page.getByRole('button', { name: /Request access/ })).toHaveCount(0);
    found.push(...(await violations(asker.page, 'join screen (requested)')));
    await shot(asker.page, `join-screen-requested-${theme}`);
    // Asking is not joining.
    await asker.page.goto('/home');
    await asker.page.waitForURL(/\/join$/);

    // The owner is emailed, and finds the request on the members page.
    const requestMail = await mailTo(owner.email, /asked to join .* on Oat$/);
    expect(requestMail.Subject).toContain(name);
    expect(extractFirstLink(requestMail)).toMatch(/\/settings\/workspace\/members$/);
    if (process.env.E2E_SCREENSHOTS) {
      const preview = await owner.context.newPage();
      await preview.setContent(requestMail.HTML);
      await shot(preview, `join-request-email-${theme}`);
      await preview.close();
    }

    // A second newcomer asks too; this one will be declined.
    const other = await signUp(browser, 'other', domain, theme);
    await other.page.getByRole('button', { name: `Request access to ${name}` }).click();
    await expect(choice(other.page, name)).toContainText('Requested');

    await owner.page.goto('/settings/workspace/members');
    await expect(owner.page.getByRole('heading', { name: 'Requests to join' })).toBeVisible();
    await expect(owner.page.getByTestId('join-request-row').filter({ visible: true })).toHaveCount(
      2,
    );
    found.push(...(await violations(owner.page, 'requests list', '[data-testid="join-requests"]')));
    await shot(owner.page, `join-requests-${theme}`);

    // Approve the first as a viewer.
    const row = requestRow(owner.page, asker.email);
    await row.getByTestId('join-request-role').click();
    await expect(owner.page.getByRole('option')).toHaveText(['Owner', 'Admin', 'Member', 'Viewer']);
    await owner.page.getByRole('option', { name: 'Viewer' }).click();
    await row.getByRole('button', { name: /^Approve/ }).click();
    await expect(requestRow(owner.page, asker.email)).toHaveCount(0);
    await expect(memberRow(owner.page, asker.email)).toBeVisible();
    await expect(memberRow(owner.page, asker.email).getByTestId('member-role-select')).toHaveText(
      'Viewer',
    );
    const approved = await mailTo(asker.email, /^You’re in: /);
    expect(approved.Subject).toContain(name);
    expect(approved.Text).toContain('You’re now a viewer.');
    await asker.page.goto('/home');
    await asker.page.waitForURL(/\/home$/);
    await expect(asker.page.getByTestId('workspace-switcher')).toContainText(name);
    // Now that they have a workspace, the join screen is behind them.
    await asker.page.goto('/join');
    await asker.page.waitForURL(/\/home$/);

    // Decline the second: no membership; they are told, and get a workspace of their own.
    await requestRow(owner.page, other.email)
      .getByRole('button', { name: /^Decline/ })
      .click();
    await expect(owner.page.getByTestId('join-request-row')).toHaveCount(0);
    await expect(owner.page.getByRole('heading', { name: 'Requests to join' })).toHaveCount(0);
    await expect(memberRow(owner.page, other.email)).toHaveCount(0);
    const declined = await mailTo(other.email, /was declined$/);
    expect(declined.Subject).toContain(name);
    await other.page.goto('/home');
    await other.page.waitForURL(/\/home$/);
    await expect(other.page.getByTestId('workspace-switcher')).toContainText('My workspace');
    await expect(other.page.getByTestId('workspace-switcher')).toHaveAttribute(
      'data-switchable',
      'false',
    );
    await other.page.getByTestId('workspace-switcher').click();
    await expect(other.page.getByRole('menu')).toBeVisible();
    await expect(other.page.getByTestId('workspace-option')).toHaveCount(1);
    await shot(other.page, `join-no-match-home-${theme}`);

    expect(found, 'axe violations on the join screens').toEqual([]);
    for (const person of [owner, asker, other]) await person.context.close();
  });
}

test('auto_join: a matching newcomer joins as member in one click, or creates their own workspace', async ({
  browser,
}) => {
  const { owner, domain, name } = await company(browser);
  await openJoining(owner, domain, { testId: 'auto_join', label: 'Join automatically' });

  const joiner = await signUp(browser, 'joiner', domain);
  await expect(joiner.page).toHaveURL(/\/join$/);
  await expect(choice(joiner.page, name)).toHaveAttribute('data-kind', 'join');
  await expect(choice(joiner.page, name)).toContainText('open to your domain');
  await shot(joiner.page, 'join-screen-auto-join-light');
  await joiner.page.getByRole('button', { name: `Join ${name}` }).click();
  await joiner.page.waitForURL(/\/home$/);
  await expect(joiner.page.getByTestId('workspace-switcher')).toContainText(name);
  // Only that workspace: nothing was created for them on the side (so there is nothing to switch to).
  await expect(joiner.page.getByTestId('workspace-switcher')).toHaveAttribute(
    'data-switchable',
    'false',
  );

  await owner.page.goto('/settings/workspace/members');
  await expect(memberRow(owner.page, joiner.email)).toBeVisible();
  await expect(memberRow(owner.page, joiner.email).getByTestId('member-role-select')).toHaveText(
    'Member',
  );
  // Nobody had to approve anything.
  await expect(owner.page.getByRole('heading', { name: 'Requests to join' })).toHaveCount(0);

  // Another newcomer prefers a workspace of their own.
  const loner = await signUp(browser, 'loner', domain);
  await expect(loner.page).toHaveURL(/\/join$/);
  await loner.page.getByRole('button', { name: 'Create my own workspace' }).click();
  await loner.page.waitForURL(/\/home$/);
  await expect(loner.page.getByTestId('workspace-switcher')).toContainText('My workspace');
  await owner.page.reload();
  await expect(memberRow(owner.page, loner.email)).toHaveCount(0);

  // Someone on another domain never sees the workspace.
  const outsider = await signUp(browser, 'outsider', newDomain());
  await expect(outsider.page).toHaveURL(/\/home$/);
  await expect(outsider.page.getByTestId('workspace-switcher')).toContainText('My workspace');

  // Members don't see the join settings; only owners and admins do.
  await joiner.page.goto('/settings/workspace');
  await expect(joiner.page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  await expect(joiner.page.getByTestId('join-settings')).toHaveCount(0);

  for (const person of [owner, joiner, loner, outsider]) await person.context.close();
});
