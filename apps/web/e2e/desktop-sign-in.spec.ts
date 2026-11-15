import { randomBytes } from 'node:crypto';

import { SIGNED_OUT } from './auth-helpers';
import { expect, test } from './fixtures';

/** What the desktop app puts in the URL: 43-char base64url `state` and PKCE `challenge`. */
const value = () => randomBytes(32).toString('base64url');
const desktopPath = (state = value(), challenge = value()) =>
  `/desktop/sign-in?state=${state}&challenge=${challenge}`;

test.describe('desktop sign-in page (1.8)', () => {
  test('signed out: goes through sign-in and comes back with state and challenge', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: SIGNED_OUT });
    const page = await context.newPage();
    const path = desktopPath();
    await page.goto(path);
    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
    await context.close();
  });

  test('a link without valid state/challenge is refused', async ({ page }) => {
    await page.goto('/desktop/sign-in?state=abc&challenge=def');
    await expect(page.getByRole('heading', { name: 'This link is incomplete' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to the app' })).toHaveCount(0);
  });

  test('signed in: "Continue to the app" issues a one-time oat:// link for that state', async ({
    page,
  }) => {
    const state = value();
    await page.goto(desktopPath(state));
    await expect(page.getByTestId('desktop-email')).toContainText('@');
    await expect(page.getByTestId('desktop-warning')).toHaveText(
      'Only continue if you just chose Sign in in the Oat app on this computer. Never share this link or code.',
    );
    const response = page.waitForResponse((r) => r.url().endsWith('/api/auth/desktop/code'));
    await page.getByRole('button', { name: 'Continue to the app' }).click();
    const res = await response;
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const { redirectUrl } = (await res.json()) as { redirectUrl: string };
    expect(redirectUrl).toMatch(new RegExp(`^oat://auth\\?code=[\\w-]{43}&state=${state}$`));
    await expect(page.getByTestId('desktop-opened')).toContainText('Back to the app');
    await expect(page.getByTestId('desktop-never-share')).toBeVisible();
    // Production behaviour (this server runs with OAT_DESKTOP_DEV_HANDOFF=0, which is what production
    // forces): the link can be reopened but never copied.
    await expect(page.getByRole('button', { name: 'Open Oat again' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Copy link/ })).toHaveCount(0);
  });

  test('the code endpoint refuses cross-site requests and signed-out callers', async ({
    page,
    baseURL,
    playwright,
  }) => {
    await page.goto('/home'); // signed-in cookies are in this context
    const data = { state: value(), challenge: value() };
    const url = '/api/auth/desktop/code';
    // Same origin works…
    const ok = await page.request.post(url, { data, headers: { origin: baseURL! } });
    expect(ok.status()).toBe(200);
    // …another site posting with the user's cookies does not (login/code CSRF).
    const evil = await page.request.post(url, {
      data,
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status()).toBe(403);
    // No session, no code.
    const anon = await playwright.request.newContext({
      baseURL: baseURL!,
      storageState: SIGNED_OUT,
    });
    expect((await anon.post(url, { data, headers: { origin: baseURL! } })).status()).toBe(401);
    // Exchange with an unknown code: the same 400 for every bad code.
    const bad = await anon.post('/api/auth/desktop/token', {
      data: { code: value(), verifier: value() },
    });
    expect(bad.status()).toBe(400);
    expect(bad.headers()['set-auth-token']).toBeUndefined();
    await anon.dispose();
  });
});
