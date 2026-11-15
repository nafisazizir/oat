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

export default defineConfig({
  testDir: './e2e',
  // One Electron app at a time: windows, Keychain and the web server are shared.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  webServer: mac
    ? {
        command: 'pnpm exec tsx e2e/web-server.ts',
        cwd: '../web',
        url: `http://localhost:${port}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
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
