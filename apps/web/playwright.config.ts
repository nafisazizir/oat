import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against `next dev`. Playwright always starts (and stops) its own server, never reusing one, so
 * parallel worktrees don't test each other's code. Port: `E2E_PORT` (default 3000), e.g.
 *   E2E_PORT=3104 pnpm --filter @oat/web e2e
 * Chromium: `pnpm --filter @oat/web exec playwright install chromium` once per machine.
 */
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    // D-11: e2e never reaches real providers, whatever the local `.env` says (shell vars win over it).
    env: {
      AI_GATEWAY_API_KEY: '',
      DEEPGRAM_API_KEY: '',
      OAUTH_GOOGLE_ISSUER: 'http://localhost:18089/google',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
