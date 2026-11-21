import {
  evidence,
  readMagicLinkEmail,
  SIGNED_OUT,
  signInWithGoogle,
  signInWithMagicLink,
  uniqueAddress,
} from './auth-helpers';
import { expect, test } from './fixtures';

/**
 * Sign-in flows against the compose stack (D-11): magic links read from Mailpit, Google through the mock
 * OIDC issuer. Every test starts signed out and uses its own fresh user.
 */
test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

test.describe('signed out', () => {
  test('protected routes redirect to /sign-in and remember where you were going', async ({
    page,
  }) => {
    await page.goto('/home');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome to Oat' })).toBeVisible();

    await page.goto('/d/reading-list');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fd%2Freading-list$/);
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings$/);
  });

  test('a forged session cookie still ends at sign-in (the layout validates it)', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      { name: 'better-auth.session_token', value: 'forged.value', url: baseURL! },
    ]);
    await page.goto('/home');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe('hardening', () => {
  test('the magic-link POST endpoint refuses cross-origin posts (login CSRF)', async ({
    request,
  }) => {
    const res = await request.post('/api/sign-in/magic-link', {
      form: { token: 'whatever', next: '/home' },
      headers: { origin: 'https://evil.test' },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
  });

  test('`next` can’t send a signed-in user off-site', async ({ page, baseURL }) => {
    await page.goto('/sign-in');
    await signInWithMagicLink(page, uniqueAddress('e2e-next'), baseURL!);
    await expect(page).toHaveURL(/\/home$/);
    for (const payload of ['/.//evil.com', '/a/..//evil.com', '/%2e//evil.com', '//evil.com']) {
      await page.goto(`/sign-in?next=${encodeURIComponent(payload)}`);
      await expect(page).toHaveURL(`${baseURL}/home`);
    }
  });
});

test.describe('magic link', () => {
  test('signs up, lands on the requested page with the personal workspace', async ({
    page,
    baseURL,
  }) => {
    const email = uniqueAddress('e2e-magic');
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings$/);
    await evidence(page, 'sign-in');

    await page.getByLabel('Work email').fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await evidence(page, 'check-your-email');

    const { link, html, text } = await readMagicLinkEmail(email, baseURL!);
    expect(text).toContain(link);
    if (process.env.E2E_SCREENSHOTS) {
      await page.setContent(html);
      await evidence(page, 'magic-link-email');
    }
    // Opening the link only shows the confirm page; scanners that GET it (twice here) consume nothing.
    expect((await page.request.get(link)).status()).toBe(200);
    // Better Auth's own GET verify endpoint is closed (login CSRF), even with this real, unused token.
    const token = new URL(link).searchParams.get('token')!;
    const directVerify = await page.request.get(
      `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=%2Fhome`,
      { maxRedirects: 0 },
    );
    expect(directVerify.status()).toBe(404);
    expect(directVerify.headers()['set-cookie']).toBeUndefined();
    await page.goto(link);
    await expect(page.getByRole('heading', { level: 1, name: 'Finish signing in' })).toBeVisible();
    await expect(page.getByTestId('confirm-email')).toHaveText(email);
    await expect(page).toHaveURL(/\/sign-in\/confirm\?/);
    await evidence(page, 'confirm-sign-in');
    await page.getByRole('button', { name: 'Continue to Oat' }).click();
    await page.waitForURL(/\/settings$/, { waitUntil: 'load' });
    await page.goto('/home');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toContainText('Personal');
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByRole('menu')).toContainText(email);
    await page.keyboard.press('Escape');
    await evidence(page, 'home-after-magic-link');

    // The link is single-use: opening it again (signed out) says so, with no button.
    await page.context().clearCookies();
    await page.goto(link);
    await expect(
      page.getByRole('heading', { level: 1, name: 'This link has expired' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to Oat' })).toHaveCount(0);
    await evidence(page, 'confirm-link-used');
    // A used token posted anyway (e.g. a page left open in two tabs) lands on the sign-in error copy.
    const reused = await page.request.post('/api/sign-in/magic-link', {
      form: { token, next: '/home' },
      headers: { origin: baseURL! },
      maxRedirects: 0,
    });
    expect(reused.status()).toBe(303);
    expect(reused.headers()['set-cookie']).toBeUndefined();
    await page.goto(reused.headers().location!);
    await expect(page).toHaveURL(/\/sign-in\?error=/);
    await expect(page.getByRole('status')).toContainText('expired or was already used');
    await evidence(page, 'sign-in-link-used');
  });

  test('signing in again keeps one personal workspace', async ({ page, baseURL }) => {
    const email = uniqueAddress('e2e-again');
    for (let i = 0; i < 2; i++) {
      await page.context().clearCookies();
      await page.goto('/sign-in');
      await signInWithMagicLink(page, email, baseURL!);
      await expect(page).toHaveURL(/\/home$/);
    }
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByTestId('workspace-option')).toHaveCount(1);
    await expect(page.getByTestId('workspace-option')).toContainText('Personal');
  });
});

test.describe('Google (mock issuer)', () => {
  test('signs in through the provider page and lands on /home', async ({ page }) => {
    const email = uniqueAddress('e2e-google');
    await page.goto('/sign-in');
    await signInWithGoogle(page, email, 'Grace Hopper');
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId('workspace-switcher')).toContainText('Personal');
    await page.getByTestId('workspace-switcher').click();
    await expect(page.getByRole('menu')).toContainText('Grace Hopper');
    await expect(page.getByRole('menu')).toContainText(email);
    await page.keyboard.press('Escape');
    await evidence(page, 'home-after-google');
  });
});

test.describe('signed in', () => {
  test('creates a team workspace, switches between workspaces, signs out', async ({
    page,
    baseURL,
  }) => {
    await page.goto('/sign-in');
    await signInWithMagicLink(page, uniqueAddress('e2e-team'), baseURL!);
    await expect(page).toHaveURL(/\/home$/);
    const switcher = page.getByTestId('workspace-switcher');

    await switcher.click();
    await page.getByRole('menuitem', { name: 'Create workspace' }).click();
    const dialog = page.getByTestId('create-workspace-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill('Acme Design');
    await evidence(page, 'create-workspace');
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(dialog).toBeHidden();
    await expect(switcher).toContainText('Acme Design');
    await expect(switcher).toContainText('1 member');

    await switcher.click();
    await expect(page.getByTestId('workspace-option')).toHaveCount(2);
    await evidence(page, 'workspace-switcher');
    await page.getByTestId('workspace-option').filter({ hasText: 'Personal' }).click();
    await expect(switcher).toContainText('Personal');
    // The switcher shows the pick right away; wait for the server to store it.
    await expect(switcher).not.toHaveAttribute('aria-busy');
    // The choice is stored on the session, so it survives a reload.
    await page.reload();
    await expect(switcher).toContainText('Personal');

    await page.getByTestId('workspace-switcher').click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto('/home');
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});
