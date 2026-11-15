import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test as setup } from '@playwright/test';

import { signInWithMagicLink, uniqueAddress } from './auth-helpers';
import { STORAGE_STATE } from './paths';

/** Signs one user in by magic link; the `chromium` project reuses their cookies for every spec. */
setup('sign in by magic link', async ({ page, baseURL }) => {
  await page.goto('/sign-in');
  await signInWithMagicLink(page, uniqueAddress('e2e'), baseURL!);
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByTestId('workspace-switcher')).toContainText('Personal');
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
});
