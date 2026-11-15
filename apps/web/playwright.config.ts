import { defineConfig, devices } from '@playwright/test';

import { STORAGE_STATE } from './e2e/paths';

/**
 * E2E against `next dev` on a throwaway database (`e2e/web-server.ts`). Playwright always starts (and
 * stops) its own server, never reusing one, so parallel worktrees don't test each other's code. Port:
 * `E2E_PORT` (default 3000), e.g.
 *   E2E_PORT=3104 pnpm --filter @oat/web e2e
 * Needs the compose stack (`pnpm dev:up`: Postgres, Mailpit, mock OAuth).
 * Chromium: `pnpm --filter @oat/web exec playwright install chromium` once per machine.
 *
 * Projects: `setup` signs a user in by magic link and saves the cookies to `e2e/.auth/user.json`;
 * `chromium` runs every spec with that signed-in state (specs that need a signed-out browser reset it).
 */
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = `http://localhost:${port}`;
/**
 * Budgets scale with `E2E_TIMEOUT_SCALE` (default 1; e.g. 2 on a machine running several CI runs at
 * once). Waits are condition-based, so generous budgets cost nothing when things are fast.
 */
const scale = Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // One `next dev` serves every worker and compiles routes on first request; more workers than this mostly
  // queue behind it and stretch every wait when the machine is busy (ci-flakes). `E2E_WORKERS` overrides.
  workers: Number(process.env.E2E_WORKERS) || 4,
  // Most specs sign a fresh user up by magic link first.
  timeout: 60_000 * scale,
  // `next dev` compiling a route on first visit (e.g. /d/[id] after "New page") took > 5 s (the default)
  // under load (ci-flakes).
  expect: { timeout: 15_000 * scale },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // JSON report kept per run so intermittent failures can be diagnosed after the fact (git-ignored).
  reporter: [
    [process.env.CI ? 'github' : 'list'],
    ['json', { outputFile: 'test-results/last-run.json' }],
  ],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    // Without these an action or navigation that can't complete waits for the whole test timeout.
    actionTimeout: 20_000 * scale,
    navigationTimeout: 30_000 * scale,
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'pnpm exec tsx e2e/web-server.ts',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000 * scale,
    // Lets web-server.ts stop `next dev` and drop its database.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    // D-11: e2e never reaches real providers, whatever the local `.env` says (shell vars win over it).
    env: {
      E2E_PORT: String(port),
      AI_GATEWAY_API_KEY: '',
      DEEPGRAM_API_KEY: '',
      OAUTH_GOOGLE_ISSUER: 'http://localhost:18089/google',
      OAUTH_GOOGLE_CLIENT_ID: 'oat-dev',
      OAUTH_GOOGLE_CLIENT_SECRET: 'oat-dev-secret',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '11025',
      SMTP_USER: '',
      SMTP_PASSWORD: '',
      // /desktop/sign-in renders as in production: no copyable sign-in link (1.8 review). The desktop
      // e2e runs its own server with the dev default (on).
      OAT_DESKTOP_DEV_HANDOFF: '0',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
