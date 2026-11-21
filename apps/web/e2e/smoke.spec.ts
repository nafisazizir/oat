import { apiCreateDocument, apiCreateFolder, unique } from './docs-helpers';
import { expect, sidebarSelector, test } from './fixtures';

test.describe('app shell', () => {
  test('root redirects to a rendered home', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/home$/);
    await expect(page).toHaveTitle('Home · Oat');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(page.getByText('No meeting notes yet')).toBeVisible();
    await expect(page.getByTestId('workspace-switcher')).toContainText('Personal');
    await expect(page.getByTestId('page-tree')).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
    await expect(
      page.getByTestId('top-bar').getByRole('button', { name: 'New note' }),
    ).toBeVisible();
    await expect(
      page.getByTestId('app-sidebar').getByRole('button', { name: 'New note' }),
    ).toHaveCount(0);
    await expect(page.getByTestId('top-bar-actions')).toBeEmpty();
  });

  // Guard: during 1.4 `next dev` once rebuilt and fully reloaded every page in a loop (HMR
  // "rebuilding" → reload). Other assertions retry and can pass mid-loop, so count loads explicitly.
  test('dev server loads a page once (no HMR reload loop)', async ({ page }) => {
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto('/home');
    await page.waitForTimeout(2500);
    expect(loads).toBe(1);
  });

  test('sidebar collapses, remembers it across reloads, and ⌘B expands it', async ({ page }) => {
    await page.goto('/home');
    const sidebar = page.locator(sidebarSelector);
    await expect(sidebar).toHaveAttribute('data-state', 'expanded');

    await page.getByTestId('sidebar-trigger').click();
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
    // Collapsed to icons: labels hidden, icon buttons still there.
    await expect(page.getByTestId('open-trash')).toBeVisible();
    await expect(page.getByTestId('theme-menu')).toBeVisible();

    await page.reload();
    await expect(page.locator(sidebarSelector)).toHaveAttribute('data-state', 'collapsed');

    await page.locator('body').click();
    await page.keyboard.press('ControlOrMeta+b');
    await expect(page.locator(sidebarSelector)).toHaveAttribute('data-state', 'expanded');
  });

  test('page tree navigates notes and folders without breadcrumbs', async ({ page }) => {
    await page.goto('/home');
    const ideas = unique('Ideas');
    const reading = unique('Reading list');
    const folder = await apiCreateFolder(page, { name: ideas });
    const doc = await apiCreateDocument(page, { title: reading, folderId: folder.id });
    await page.reload();
    await page.getByTestId('page-tree').getByRole('link', { name: reading }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${doc.id}$`));
    await expect(page.getByTestId('document-title')).toHaveValue(reading);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
    await page.getByTestId('page-tree').getByRole('link', { name: ideas, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/d/${folder.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: ideas })).toBeVisible();
  });

  test('⌘K opens the command palette and navigates', async ({ page }) => {
    await page.goto('/home');
    const target = unique('Side projects');
    const doc = await apiCreateDocument(page, { title: target });
    await page.reload();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    await page.keyboard.type('settings');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    // The sidebar's Search item opens it too; pick a page.
    await page
      .getByRole('button', { name: /^Search/ })
      .first()
      .click();
    await expect(palette).toBeVisible();
    await page.keyboard.type(target);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/d/${doc.id}$`));

    // ⌘K toggles: a second press closes it.
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeHidden();
  });

  test('theme toggles between light, dark and system, without a flash on reload', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/home');
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/\bdark\b/);

    await page.getByTestId('theme-menu').click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(html).toHaveClass(/\bdark\b/);

    // The head script applies the stored theme before hydration: check the very first paint.
    await page.reload({ waitUntil: 'commit' });
    await page.waitForSelector('body');
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      true,
    );
    await page.waitForLoadState('load');

    // System follows the OS appearance, live.
    await page.getByTestId('theme-menu').click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    await expect(html).not.toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveClass(/\bdark\b/);

    // Command palette theme commands work too.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('light theme');
    await page.keyboard.press('Enter');
    await expect(html).not.toHaveClass(/\bdark\b/);
  });
});

test.describe('routes', () => {
  test('GET /api/health (includes a Postgres round-trip)', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: '0.0.0', db: 'ok' });
  });

  test('settings reads the typed env (local mocks by default)', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('integration-ai')).toHaveText('Local mock');
    await expect(page.getByTestId('integration-stt')).toHaveText('Local mock');
    await expect(page.getByTestId('integration-oauth')).toHaveText('Local mock');
  });

  test('unknown document shows not-found inside the shell', async ({ page }) => {
    await page.goto('/d/does-not-exist');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(page.locator(sidebarSelector)).toBeVisible();
  });

  test('signed-in users skip /sign-in (sign-in flows: auth.spec.ts)', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page).toHaveURL(/\/home$/);
    await page.goto('/sign-in?next=%2Fsettings');
    await expect(page).toHaveURL(/\/settings$/);
  });
});

test.describe('error boundary', () => {
  // The thrown error is logged to the console by React/Next on purpose.
  test.use({ allowConsoleErrors: true });

  test('a failing page renders error.tsx and keeps the shell', async ({ page }) => {
    await page.goto('/d/__error');
    await expect(page.getByRole('alert').filter({ hasText: 'Something went wrong' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.locator(sidebarSelector)).toBeVisible();
  });

  test('an error above every error.tsx renders global-error.tsx', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('oat-theme', 'dark'));
    await page.goto('/dev-probes/global-error');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/); // keeps the user's theme
    await expect(page.getByRole('alert').filter({ hasText: 'Oat couldn’t load' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go home' })).toHaveAttribute('href', '/home');
  });
});
