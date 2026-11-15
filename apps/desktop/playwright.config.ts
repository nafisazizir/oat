import { defineConfig } from '@playwright/test';

/**
 * Desktop e2e: Playwright `_electron.launch` against the built app (`out/`, `pnpm e2e` builds first),
 * plus a Chromium page for the web half of sign-in. The web app it talks to is `next dev` on a throwaway
 * database (apps/web's `e2e/web-server.ts`), on `E2E_PORT` (scripts/ci.mjs picks a free one).
 * Needs the compose stack (`pnpm dev:up`: Postgres, Mailpit).
 *
 * macOS only for now (the desktop app is macOS-first; Linux CI has no display or keyring): elsewhere the
 * specs skip and no web server is started.
 */
const port = Number(process.env.E2E_PORT ?? 3100);
const mac = process.platform === 'darwin';
/**
 * Every budget below is multiplied by `E2E_TIMEOUT_SCALE` (default 1; e.g. 2 on a machine running several
 * CI runs at once). Waits are condition-based, so generous budgets cost nothing when things are fast: they
 * only decide how long a real failure takes to report. Specs scale their own `test.setTimeout`s with
 * `scaled()` from e2e/helpers.ts.
 */
const scale = Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1);

export default defineConfig({
  testDir: './e2e',
  // One Electron app at a time: windows, Keychain and the web server are shared.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000 * scale,
  // Electron cold start, `next dev` compiling a route on first request and the web pages hydrating all
  // slow down several-fold when the machine is busy (ci-flakes): 5 s (Playwright's default) was too tight.
  expect: { timeout: 15_000 * scale },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    // Without these an action or navigation that can't complete waits for the whole test timeout.
    actionTimeout: 20_000 * scale,
    navigationTimeout: 30_000 * scale,
  },
  webServer: mac
    ? {
        command: 'pnpm exec tsx e2e/web-server.ts',
        cwd: '../web',
        url: `http://localhost:${port}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000 * scale,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
        // D-11: never real providers, whatever the local `.env` says.
        env: {
          E2E_PORT: String(port),
          // Own build folder, never the web e2e's `.next` (see apps/web/next.config.ts).
          OAT_NEXT_DIST_DIR: '.next-desktop-e2e',
          AI_GATEWAY_API_KEY: '',
          DEEPGRAM_API_KEY: '',
          OAUTH_GOOGLE_ISSUER: 'http://localhost:18089/google',
          OAUTH_GOOGLE_CLIENT_ID: 'oat-dev',
          OAUTH_GOOGLE_CLIENT_SECRET: 'oat-dev-secret',
          SMTP_HOST: 'localhost',
          SMTP_PORT: '11025',
          SMTP_USER: '',
          SMTP_PASSWORD: '',
        },
        stdout: 'ignore',
        stderr: 'pipe',
      }
    : undefined,
});
