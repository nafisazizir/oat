import type { Page } from '@playwright/test';

import { expect } from './fixtures';

export async function waitForIntegrations(page: Page) {
  const settings = page.getByTestId('settings-content');
  await expect(settings.getByRole('switch', { name: 'Auto-enhance after meetings' })).toBeVisible();
  await expect(settings.getByTestId('google-calendar-status')).toBeVisible();
  await expect(settings.getByTestId('notion-status')).toBeVisible();
}
