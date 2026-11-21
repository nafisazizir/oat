import { SIGNED_OUT, uniqueAddress } from './auth-helpers';
import { expect, test } from './fixtures';

test.use({ storageState: SIGNED_OUT, viewport: { width: 1440, height: 900 } });
for (const colorScheme of ['light', 'dark'] as const) {
  test(`calm passwordless auth has one title and an unboxed narrow column (${colorScheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    expect((await page.getByRole('main').boundingBox())!.width).toBeLessThanOrEqual(360);
    await expect(page.locator('[data-slot="card"]')).toHaveCount(0);
    await page.getByLabel('Work email').fill(uniqueAddress('calm-auth'));
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');
    await expect(page.getByRole('heading')).toHaveCount(1);
    await page.getByRole('button', { name: 'Use a different email' }).click();
    await expect(page.getByLabel('Work email')).toBeVisible();
    await page.goto('/sign-in/confirm');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link is incomplete');
    await expect(page.getByRole('link', { name: 'Back to sign in' })).toBeVisible();
    await expect(page.locator('[data-slot="card"]')).toHaveCount(0);
  });
}
