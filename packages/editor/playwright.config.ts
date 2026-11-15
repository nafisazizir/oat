import { defineConfig, devices } from '@playwright/test';

import { PLAYGROUND_PORT } from './playground/port.ts';

const baseURL = `http://localhost:${PLAYGROUND_PORT}`;

// `pnpm --filter @oat/editor e2e` — drives the playground in Chromium.
// `pnpm --filter @oat/editor screenshots` additionally writes light/dark evidence screenshots.
// Needs Chromium once: `pnpm --filter @oat/editor exec playwright install chromium`.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm playground',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
