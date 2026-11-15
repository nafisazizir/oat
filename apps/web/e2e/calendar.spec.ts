import { mkdirSync } from 'node:fs';

import { type Page } from '@playwright/test';

import { SIGNED_OUT, signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { expect, test } from './fixtures';
import { EVIDENCE_7_4 } from './paths';

/**
 * 7.4: connect Google Calendar (mock OIDC issuer for consent, the in-process gcal mock from
 * `e2e/web-server.ts` for the API) → Home lists the fixture week's next meetings → disconnect. The mock's
 * `next-week` anchor puts the fixture week (Sun-night release window, then Mon 16 – Fri 20 Nov shapes) on the
 * first Monday after now, so the list is the same whenever this runs.
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

/** Screenshot for docs/tasks/evidence/7.4 — only when `E2E_SCREENSHOTS` is set (tracked files). */
async function evidence(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOTS) return;
  mkdirSync(EVIDENCE_7_4, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${EVIDENCE_7_4}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

test('connect Google Calendar → upcoming meetings on Home → disconnect', async ({
  page,
  baseURL,
  playwright,
}) => {
  const email = uniqueAddress('e2e-gcal');
  await page.goto('/sign-in');
  await signInWithMagicLink(page, email, baseURL!);
  await expect(page).toHaveURL(/\/home$/);

  // Not connected: Home invites to connect.
  // Role queries skip the hidden copy React keeps while it swaps in a streamed Suspense boundary.
  const upcoming = page.getByRole('region', { name: 'Upcoming' });
  const notice = upcoming.getByTestId('upcoming-connect');
  await expect(notice).toContainText('Connect your calendar');
  await evidence(page, 'home-not-connected');
  await notice.getByRole('link', { name: 'Connect Google Calendar' }).click();
  await expect(page).toHaveURL(/\/settings\/integrations$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  await expect(page.getByTestId('google-calendar-status')).toHaveText('Not connected');
  await evidence(page, 'integrations-not-connected');

  // Consent at the (mock) Google issuer: calendar.readonly, offline, separate callback.
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await page.waitForURL(/localhost:18089\/google\/authorize/);
  const authorize = new URL(page.url());
  expect(authorize.searchParams.get('scope')).toContain(
    'https://www.googleapis.com/auth/calendar.readonly',
  );
  expect(authorize.searchParams.get('access_type')).toBe('offline');
  expect(authorize.searchParams.get('redirect_uri')).toBe(
    `${baseURL}/api/auth/callback/google-calendar`,
  );
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL(/\/settings\/integrations\?connected=google-calendar$/, {
    waitUntil: 'load',
  });
  await expect(page.getByTestId('google-calendar-status')).toHaveText('Connected');
  await expect(page.getByTestId('google-calendar-account')).toHaveText(email);
  await expect(
    page.getByRole('status').filter({ hasText: 'Google Calendar is connected' }),
  ).toBeVisible();
  await evidence(page, 'integrations-connected');

  // Home: the next five events of the fixture week, normalised from the Google API mock.
  await page.goto('/home');
  const rows = upcoming.getByTestId('upcoming-meeting');
  await expect(upcoming.getByTestId('upcoming-meeting-title')).toHaveText([
    'Release window',
    'Daily standup',
    'Product review: onboarding flow',
    'Lunch',
    'Daily standup',
  ]);
  const standup = rows.nth(1);
  await expect(standup).toContainText('Work · 4 people · Google Meet');
  await expect(standup.getByRole('link', { name: /^Join Daily standup/ })).toHaveAttribute(
    'href',
    'https://meet.google.com/abc-defg-hij',
  );
  await expect(rows.nth(2).getByRole('link', { name: /^Join/ })).toHaveAttribute(
    'href',
    'https://us02web.zoom.us/j/81234567890?pwd=Q2FsZW5kYXI',
  );
  await expect(rows.nth(3).getByRole('link', { name: /^Join/ })).toHaveCount(0); // Lunch: no link
  await expect(standup.locator('time')).toContainText(/\d/); // formatted on the client
  await evidence(page, 'home-upcoming');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.first()).toBeVisible();
  // Phone width: rows wrap instead of scrolling sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await evidence(page, 'home-upcoming-phone');
  await page.setViewportSize({ width: 1280, height: 800 });
  await standup.getByRole('button', { name: 'Start notes' }).click();
  await expect(page.getByText('Notes from calendar events are coming soon')).toBeVisible();

  // The same data over the API (session cookie), as the desktop app will read it.
  const api = await page.request.get('/api/calendar/upcoming?limit=3');
  expect(api.status()).toBe(200);
  expect(api.headers()['cache-control']).toContain('no-store');
  const body = (await api.json()) as {
    connected: boolean;
    sources: { kind: string; state: string; email: string }[];
    events: { title: string; source: string; conferenceProvider: string | null; id: string }[];
  };
  expect(body.connected).toBe(true);
  expect(body.sources).toEqual([{ kind: 'google', state: 'ok', email }]);
  expect(body.events.map((e) => e.title)).toEqual([
    'Release window',
    'Daily standup',
    'Product review: onboarding flow',
  ]);
  expect(body.events[1]).toMatchObject({ source: 'google', conferenceProvider: 'google_meet' });
  expect(body.events[1]!.id).toMatch(/^google:cal-work\/standup_\d{8}T173000Z$/);
  expect((await page.request.get('/api/calendar/upcoming?limit=0')).status()).toBe(400);
  expect((await page.request.get('/api/calendar/upcoming?days=22')).status()).toBe(400);
  expect((await page.request.get('/api/calendar/upcoming?days=21')).status()).toBe(200);

  const anonymous = await playwright.request.newContext({ baseURL });
  expect((await anonymous.get('/api/calendar/upcoming')).status()).toBe(401);
  await anonymous.dispose();

  // Disconnect → back to the invitation.
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('google-calendar-status')).toHaveText('Not connected');
  await page.goto('/home');
  await expect(upcoming.getByTestId('upcoming-connect')).toBeVisible();
  const after = (await (await page.request.get('/api/calendar/upcoming')).json()) as {
    connected: boolean;
  };
  expect(after.connected).toBe(false);
});

test('a Google account with another email is refused with a clear message', async ({
  page,
  baseURL,
}) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e-gcal-me'), baseURL!);
  await page.goto('/settings/integrations');
  await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await page.waitForURL(/localhost:18089\/google\/authorize/);
  await page.getByLabel('Email', { exact: true }).fill(uniqueAddress('e2e-gcal-other'));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/settings\/integrations\?error=email_does_not_match$/, {
    waitUntil: 'load',
  });
  await expect(
    page.getByRole('alert').filter({ hasText: 'uses a different email address' }),
  ).toBeVisible();
  await expect(page.getByTestId('google-calendar-status')).toHaveText('Not connected');
  await evidence(page, 'integrations-email-mismatch');
});
