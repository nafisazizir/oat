import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createMailpit, extractFirstLink, uniqueAddress, waitFor } from '@oat/testkit';
import type { Browser, Page } from '@playwright/test';

import { openMagicLink, SIGNED_OUT } from './auth-helpers';
import { expect, hydrationAware, test } from './fixtures';

/**
 * Team workspaces (5.1/5.2) with two real users: the owner creates a workspace, invites by email
 * (Mailpit), the invitee signs up by magic link from the invite page and accepts, the owner changes their
 * role and removes them. Fresh users per test: switching workspaces changes the session, so the shared
 * `setup` user stays untouched. `E2E_SCREENSHOTS=1` writes docs/tasks/evidence/5.1.
 */
const mailpit = createMailpit();
const EVIDENCE = fileURLToPath(new URL('../../../docs/tasks/evidence/5.1/', import.meta.url));

test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 860 } });

async function shot(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

/** The newest email to `to` whose subject matches (an invite and a magic link can arrive close together). */
function mailTo(to: string, subject: RegExp) {
  return waitFor(
    async () => {
      const latest = await mailpit.latestFor(to);
      return latest && subject.test(latest.Subject) ? latest : undefined;
    },
    { timeout: 15_000, message: `no "${subject.source}" email to ${to}` },
  );
}

/** Magic-link sign-in from the current page's sign-in form. */
async function signIn(page: Page, email: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const link = extractFirstLink(await mailTo(email, /^Sign in to Oat$/));
  await openMagicLink(page, link!);
}

async function newUser(browser: Browser, prefix: string) {
  const context = await browser.newContext({ storageState: SIGNED_OUT });
  const page = hydrationAware(await context.newPage());
  const email = uniqueAddress(prefix);
  await page.goto('/sign-in');
  await signIn(page, email);
  await expect(page).toHaveURL(/\/home$/);
  return { context, page, email };
}

async function createTeam(page: Page, name: string) {
  await page.getByTestId('workspace-switcher').click();
  await page.getByRole('menuitem', { name: 'Create workspace' }).click();
  const dialog = page.getByTestId('create-workspace-dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('workspace-switcher')).toContainText(name);
}

const memberRow = (page: Page, email: string) =>
  page.getByTestId('member-row').filter({ visible: true }).filter({ hasText: email });

test('invite → accept → change role → remove, with two users', async ({ browser }) => {
  test.setTimeout(120_000);
  const teamName = `Acme ${Math.random().toString(36).slice(2, 6)}`;
  const owner = await newUser(browser, 'owner');
  await createTeam(owner.page, teamName);

  // General settings: icon + name; the address is read-only.
  await owner.page.goto('/settings/workspace');
  await expect(owner.page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  await expect(owner.page.getByRole('navigation', { name: 'Settings sections' })).toContainText(
    teamName,
  );
  await expect(owner.page.getByTestId('workspace-slug').filter({ visible: true })).toBeVisible();
  await owner.page.getByRole('button', { name: 'Choose workspace icon' }).click();
  await owner.page.getByRole('option', { name: '🌾' }).click();
  await owner.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(owner.page.getByText('Workspace saved')).toBeVisible();
  await expect(owner.page.getByTestId('workspace-switcher')).toContainText('🌾');
  await shot(owner.page, 'settings-general');

  // Invite by email.
  const inviteeEmail = uniqueAddress('invitee');
  await owner.page.getByRole('link', { name: 'Members' }).click();
  await expect(owner.page).toHaveURL(/\/settings\/workspace\/members$/);
  await owner.page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = owner.page.getByTestId('invite-dialog');
  await dialog.getByLabel('Email').fill(inviteeEmail);
  // Owners may invite with any role; the default is Member.
  await dialog.getByLabel('Role').click();
  await expect(owner.page.getByRole('option')).toHaveText(['Owner', 'Admin', 'Member', 'Viewer']);
  await owner.page.getByRole('option', { name: 'Member' }).click();
  await shot(owner.page, 'invite-dialog');
  await dialog.getByRole('button', { name: 'Send invite' }).click();
  await expect(dialog).toBeHidden();
  const pending = owner.page
    .getByTestId('invite-row')
    .filter({ visible: true })
    .filter({ hasText: inviteeEmail });
  await expect(pending).toContainText('Member');
  await expect(pending).toContainText('expires in 7 days');
  await shot(owner.page, 'members-pending-invite');

  // Our invitation email (Mailpit) links to /invite/<token>.
  const mail = await mailTo(inviteeEmail, /invited you to .* on Oat$/);
  expect(mail.Subject).toContain(teamName);
  const inviteLink = extractFirstLink(mail)!;
  expect(inviteLink).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
  expect(mail.Text).toContain(inviteLink);
  if (process.env.E2E_SCREENSHOTS) {
    const preview = await owner.context.newPage();
    await preview.setContent(mail.HTML);
    await shot(preview, 'invite-email');
    await preview.close();
  }

  // The invitee (no account yet) opens the link, signs up by magic link, lands back and accepts.
  const inviteeContext = await browser.newContext({ storageState: SIGNED_OUT });
  const invitee = await inviteeContext.newPage();
  const opened = await invitee.goto(inviteLink);
  // The token-bearing page never leaks its URL in a Referer and is never cached.
  expect(opened!.headers()['referrer-policy']).toBe('no-referrer');
  expect(opened!.headers()['cache-control']).toContain('no-store');
  await expect(invitee.getByRole('heading', { level: 1, name: `Join ${teamName}` })).toBeVisible();
  await expect(invitee.getByTestId('invite-card').filter({ visible: true })).toContainText(
    inviteeEmail,
  );
  await shot(invitee, 'invite-signed-out');
  await invitee.getByRole('link', { name: 'Sign in to accept' }).click();
  await expect(invitee).toHaveURL(/\/sign-in\?next=%2Finvite%2F/);
  await signIn(invitee, inviteeEmail);
  await expect(invitee).toHaveURL(new RegExp(`${new URL(inviteLink).pathname}$`));
  await expect(invitee.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
  await shot(invitee, 'invite-signed-in');
  await invitee.getByRole('button', { name: 'Accept invitation' }).click();
  await invitee.waitForURL(/\/home$/, { waitUntil: 'load' });
  await expect(invitee.getByTestId('workspace-switcher')).toContainText(teamName);
  // D-36: someone who signs up through an invitation joins that workspace and gets no other one.
  await invitee.getByTestId('workspace-switcher').click();
  await expect(invitee.getByTestId('workspace-option')).toHaveCount(1);
  await shot(invitee, 'invitee-switcher');
  await invitee.keyboard.press('Escape');

  // As a member they see the list but can't invite or change roles.
  await invitee.goto('/settings/workspace/members');
  await expect(memberRow(invitee, inviteeEmail)).toContainText('You');
  await expect(invitee.getByRole('button', { name: 'Invite people' })).toHaveCount(0);
  await expect(invitee.getByTestId('member-role-select').filter({ visible: true })).toHaveCount(0);
  await expect(invitee.getByRole('button', { name: /^Remove / })).toHaveCount(0);

  // The owner sees the new member, makes them an admin, then removes them.
  await owner.page.reload();
  await expect(owner.page.getByTestId('invite-row').filter({ visible: true })).toHaveCount(0);
  const row = memberRow(owner.page, inviteeEmail);
  await expect(row.getByTestId('member-role-select').filter({ visible: true })).toHaveText(
    'Member',
  );
  await row.getByTestId('member-role-select').filter({ visible: true }).click();
  await owner.page.getByRole('option', { name: 'Admin' }).click();
  await expect(row.getByTestId('member-role-select').filter({ visible: true })).toHaveText('Admin');
  // The row updates optimistically; the toast confirms the server saved it.
  await expect(owner.page.getByText(/is now admin$/)).toBeVisible();
  await shot(owner.page, 'members-role-changed');

  // The new admin now sees the invite button.
  await invitee.reload();
  await expect(invitee.getByRole('button', { name: 'Invite people' })).toBeVisible();

  await row.getByRole('button', { name: /^Remove / }).click();
  const remove = owner.page.getByTestId('remove-member-dialog');
  await expect(remove).toContainText(inviteeEmail);
  await shot(owner.page, 'remove-member-dialog');
  await remove.getByRole('button', { name: 'Remove' }).click();
  await expect(remove).toBeHidden();
  await expect(memberRow(owner.page, inviteeEmail)).toHaveCount(0);
  await expect(owner.page.getByTestId('member-row').filter({ visible: true })).toHaveCount(1);
  await expect(owner.page.getByText(/^Removed /)).toBeVisible();

  // Removed from their only workspace: they can't see the team any more, and are not left without a
  // workspace — one of their own is made on the next visit.
  await invitee.goto('/home');
  await expect(invitee.getByTestId('workspace-switcher')).toContainText('My workspace');
  await expect(invitee.getByTestId('workspace-switcher')).not.toContainText(teamName);
  await invitee.getByTestId('workspace-switcher').click();
  await expect(invitee.getByTestId('workspace-option')).toHaveCount(1);

  // The used invite link now says so.
  await invitee.goto(inviteLink);
  await expect(
    invitee.getByRole('heading', { name: 'This invitation was already used' }),
  ).toBeVisible();

  await inviteeContext.close();
  await owner.context.close();
});

test('wrong account, revoked invite, leave and delete', async ({ browser }) => {
  test.setTimeout(120_000);
  const teamName = `Beta ${Math.random().toString(36).slice(2, 6)}`;
  const owner = await newUser(browser, 'owner2');
  await createTeam(owner.page, teamName);

  // Invite someone, then open the link signed in as the owner: wrong account.
  const target = uniqueAddress('target');
  await owner.page.goto('/settings/workspace/members');
  await owner.page.getByRole('button', { name: 'Invite people' }).click();
  await owner.page.getByTestId('invite-dialog').getByLabel('Email').fill(target);
  await owner.page
    .getByTestId('invite-dialog')
    .getByRole('button', { name: 'Send invite' })
    .click();
  await expect(owner.page.getByTestId('invite-row').filter({ visible: true })).toHaveCount(1);
  const link = extractFirstLink(await mailTo(target, /invited you to/))!;
  const other = await owner.context.newPage();
  await other.goto(link);
  await expect(other.getByTestId('invite-wrong-account').filter({ visible: true })).toContainText(
    target,
  );
  await expect(other.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await shot(other, 'invite-wrong-account');
  // Switching account signs out (a POST from the no-referrer page) and returns to the invite.
  const stranger = await newUser(browser, 'stranger');
  await stranger.page.goto(link);
  await stranger.page.getByRole('button', { name: 'Sign in with a different account' }).click();
  await stranger.page.waitForURL(/\/sign-in\?next=%2Finvite%2F/);
  await expect(stranger.page.getByLabel('Work email')).toBeVisible();
  await stranger.context.close();

  // Revoke: the link stops working.
  await owner.page
    .getByTestId('invite-row')
    .filter({ visible: true })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(owner.page.getByTestId('invite-row').filter({ visible: true })).toHaveCount(0);
  await expect(owner.page.getByText(/ revoked$/)).toBeVisible();
  await other.reload();
  await expect(other.getByRole('heading', { name: 'This invitation was revoked' })).toBeVisible();
  await other.close();

  // The only owner can't leave (button disabled, and the switcher's leave is refused).
  await owner.page.goto('/settings/workspace');
  await expect(owner.page.getByRole('button', { name: 'Leave workspace' })).toBeDisabled();
  await owner.page.getByTestId('workspace-switcher').click();
  await owner.page.getByRole('menuitem', { name: `Leave ${teamName}` }).click();
  const leave = owner.page.getByTestId('leave-workspace-dialog');
  await leave.getByRole('button', { name: 'Leave workspace' }).click();
  await expect(leave.getByRole('alert')).toContainText('only owner');
  await leave.getByRole('button', { name: 'Cancel' }).click();

  // Delete (type the name to confirm): gone from the switcher, back in the workspace made at sign-up.
  await owner.page.getByRole('button', { name: 'Delete workspace' }).click();
  const del = owner.page.getByTestId('delete-workspace-dialog');
  const confirm = del.getByRole('button', { name: 'Delete workspace' });
  await expect(confirm).toBeDisabled();
  await del.getByLabel(/to confirm/).fill(teamName);
  await shot(owner.page, 'delete-workspace-dialog');
  await confirm.click();
  await owner.page.waitForURL(/\/home$/, { waitUntil: 'load' });
  await expect(owner.page.getByTestId('workspace-switcher')).toContainText('My workspace');
  await owner.page.getByTestId('workspace-switcher').click();
  await expect(owner.page.getByTestId('workspace-option')).toHaveCount(1);
  // The last workspace can't be left, so the menu doesn't offer it.
  await expect(owner.page.getByRole('menuitem', { name: /^Leave / })).toHaveCount(0);
  await owner.page.keyboard.press('Escape');

  // D-36: that workspace is an ordinary one — it has the same settings as any other (rename, members,
  // invitations) — but as the owner's last workspace it can't be left or deleted, and the page says why.
  await owner.page.goto('/settings/workspace');
  await expect(owner.page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  const danger = owner.page.getByTestId('danger-zone').filter({ visible: true });
  await expect(danger.getByRole('button', { name: 'Leave workspace' })).toBeDisabled();
  await expect(danger.getByTestId('delete-workspace')).toBeDisabled();
  await expect(
    danger.getByText('This is your only workspace. Create or join another one first.'),
  ).toHaveCount(2);
  await shot(owner.page, 'settings-last-workspace');

  const renamed = `Solo ${Math.random().toString(36).slice(2, 6)}`;
  await owner.page.getByLabel('Name', { exact: true }).fill(renamed);
  await owner.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(owner.page.getByText('Workspace saved')).toBeVisible();
  await expect(owner.page.getByTestId('workspace-switcher')).toContainText(renamed);

  await owner.page.getByRole('link', { name: 'Members' }).click();
  await expect(owner.page).toHaveURL(/\/settings\/workspace\/members$/);
  await expect(memberRow(owner.page, owner.email)).toContainText('You');
  await owner.page.getByRole('button', { name: 'Invite people' }).click();
  const guest = uniqueAddress('guest');
  await owner.page.getByTestId('invite-dialog').getByLabel('Email').fill(guest);
  await owner.page
    .getByTestId('invite-dialog')
    .getByRole('button', { name: 'Send invite' })
    .click();
  await expect(owner.page.getByTestId('invite-row').filter({ visible: true })).toContainText(guest);
  expect((await mailTo(guest, /invited you to/)).Subject).toContain(renamed);

  // D-36: an invited newcomer who signs up on their own (not through the link) gets no workspace yet —
  // opening Oat takes them to the join screen, which shows the invitation. Declining it leaves them with
  // nothing to choose from, so they get a workspace of their own.
  const guestContext = await browser.newContext({ storageState: SIGNED_OUT });
  const guestPage = hydrationAware(await guestContext.newPage());
  await guestPage.goto('/sign-in');
  await signIn(guestPage, guest);
  await guestPage.waitForURL(/\/join$/);
  await expect(
    guestPage.getByRole('heading', { level: 1, name: 'Join a workspace' }),
  ).toBeVisible();
  await expect(guestPage.getByTestId('join-choice')).toContainText(renamed);
  await guestPage.goto('/home');
  await guestPage.waitForURL(/\/join$/);
  await guestPage.getByRole('button', { name: `Decline the invitation to ${renamed}` }).click();
  await guestPage.waitForURL(/\/home$/);
  await expect(guestPage.getByTestId('workspace-switcher')).toContainText('My workspace');
  await guestPage.getByTestId('workspace-switcher').click();
  await expect(guestPage.getByTestId('workspace-option')).toHaveCount(1);
  await guestContext.close();

  await owner.context.close();
});
