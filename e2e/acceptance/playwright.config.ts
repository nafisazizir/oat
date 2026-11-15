import { defineConfig } from '@playwright/test';

/**
 * The v1 acceptance journey (9.4, SPEC §9): one user signs up on the web, records a fixture meeting in the
 * built desktop app (FileSource, never real capture), the post-meeting pipeline enhances it and sends it to
 * the Notion mock, it is shared by link, a teammate is invited and reads it, the assistant answers with
 * citations, search finds it, and playback seeks. `pnpm --filter @oat/acceptance acceptance` (also the
 * `acceptance` step of `pnpm run ci`) builds the desktop app first.
 *
 * Same server as the desktop e2e: apps/web's `e2e/web-server.ts` (`next dev` on a throwaway database, an
 * in-process mocks server for Notion / Google Calendar / LLM, the index worker and this checkout's agents
 * server) on `E2E_PORT`. Live transcription goes to the compose stack's STT mock (`MOCKS_URL`). Needs the
 * compose stack (`pnpm dev:up`). macOS only (Electron + Keychain); elsewhere the journey skips.
 */
const port = Number(process.env.E2E_PORT ?? 3110);
const mac = process.platform === 'darwin';
/** Every budget is multiplied by `E2E_TIMEOUT_SCALE` (default 1), like the other e2e configs. */
const scale = Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1);

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 420_000 * scale,
  expect: { timeout: 15_000 * scale },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [
    [process.env.CI ? 'github' : 'list'],
    ['json', { outputFile: 'test-results/last-run.json' }],
  ],
  use: {
    baseURL: `http://localhost:${port}`,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    actionTimeout: 20_000 * scale,
    navigationTimeout: 30_000 * scale,
  },
  webServer: mac
    ? {
        command: 'pnpm exec tsx e2e/web-server.ts',
        cwd: '../../apps/web',
        url: `http://localhost:${port}/api/health`,
        reuseExistingServer: false,
        timeout: 180_000 * scale,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
        // D-11: never real providers, whatever the local `.env` says.
        env: {
          E2E_PORT: String(port),
          // Own build folder, never the web or desktop e2e's (see apps/web/next.config.ts).
          OAT_NEXT_DIST_DIR: '.next-acceptance',
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
