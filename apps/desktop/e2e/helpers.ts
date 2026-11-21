import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createMailpit, extractFirstLink } from '@oat/testkit';
import {
  _electron as electron,
  type Browser,
  type ElectronApplication,
  expect,
  type Page,
} from '@playwright/test';

/** The desktop package: Electron loads `out/main/index.js` from its package.json. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
/** Evidence for task 1.8 (screenshots only with `E2E_SCREENSHOTS=1`: they are tracked files). */
export const EVIDENCE = fileURLToPath(
  new URL('../../../docs/tasks/evidence/1.8/', import.meta.url),
);

const mailpit = createMailpit();

/** `ms` × `E2E_TIMEOUT_SCALE` (default 1), like the budgets in playwright.config.ts. */
export function scaled(ms: number): number {
  return ms * Math.max(1, Number(process.env.E2E_TIMEOUT_SCALE) || 1);
}

/**
 * The sign-in URL the app handed to the "browser". The app shows "signing in" before `openExternal` runs
 * (it awaits the PKCE challenge in between), so the URL is polled for, never read once (ci-flakes).
 */
export async function waitForSignInUrl(app: ElectronApplication): Promise<string> {
  let url: string | undefined;
  await expect
    .poll(async () => (url = (await openedUrls(app)).findLast((u) => u.includes('/desktop/'))), {
      message: 'app opened a /desktop/sign-in URL',
    })
    .toBeTruthy();
  return url!;
}

/**
 * Launches the built app with its own userData folder, pointed at the test web server. `OAT_E2E=1`:
 * windows don't take focus and `oat://` is never registered with the OS. `shell.openExternal` is
 * replaced in the main process so the system browser never opens; the URLs are recorded instead.
 */
export async function launchApp(
  userDataDir: string,
  webUrl: string,
  extraEnv: Record<string, string> = {},
) {
  const app = await electron.launch({
    args: [APP_DIR],
    env: {
      ...(process.env as Record<string, string>),
      OAT_E2E: '1',
      OAT_USER_DATA_DIR: userDataDir,
      OAT_WEB_URL: webUrl,
      // 7.5: a stopped meeting ends at once in the suites that don't test the post-stop grace period
      // (auto-stop.spec.ts sets its own).
      OAT_END_GRACE_MS: '0',
      ...extraEnv,
    },
  });
  await app.evaluate(({ shell }) => {
    const g = globalThis as { __oatOpened?: string[] };
    g.__oatOpened = [];
    shell.openExternal = async (url: string) => void g.__oatOpened!.push(url);
  });
  const page = await app.firstWindow();
  await expect(page.getByTestId('shell')).toBeVisible();
  return { app, page };
}

/** URLs the app asked the OS to open in the browser. */
export function openedUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as { __oatOpened?: string[] }).__oatOpened ?? []);
}

/** What macOS does when the browser opens an `oat://` link: `open-url` on the app. */
export async function deliverDeepLink(app: ElectronApplication, url: string) {
  await app.evaluate(({ app: electronApp }, link) => {
    electronApp.emit('open-url', { preventDefault() {} }, link);
  }, url);
}

/** The session file as written (base64) and as decrypted with safeStorage in the main process. */
export function readStoredSession(app: ElectronApplication) {
  return app.evaluate(({ app: electronApp, safeStorage }) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const file = path.join(electronApp.getPath('userData'), 'session.bin');
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file);
    return { raw: raw.toString('latin1'), plain: safeStorage.decryptString(raw) };
  });
}

/** Signs in on the web sign-in page by magic link (Mailpit) and confirms the link. */
export async function signInOnWeb(page: Page, email: string) {
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const message = await mailpit.waitForLatest(email, { timeout: scaled(15_000) });
  const link = extractFirstLink(message);
  expect(link, 'magic link').toBeTruthy();
  await page.goto(link!);
  await page.getByRole('button', { name: 'Continue to Oat' }).click();
}

/** `docs/tasks/evidence/<task>/` (default 1.8, the shell's own evidence). */
const evidenceDir = (task: string) =>
  task === '1.8'
    ? EVIDENCE
    : fileURLToPath(new URL(`../../../docs/tasks/evidence/${task}/`, import.meta.url));

export async function evidence(page: Page, name: string, task = '1.8') {
  if (!process.env.E2E_SCREENSHOTS) return;
  const dir = evidenceDir(task);
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  // Hide the Next.js dev indicator on web pages.
  await page.screenshot({
    path: `${dir}${name}.png`,
    style: 'nextjs-portal { display: none !important; }',
  });
}

export function writeEvidence(name: string, data: unknown, task = '1.8') {
  if (!process.env.E2E_SCREENSHOTS) return;
  const dir = evidenceDir(task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}`, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Signs the app in the way a user does (1.8): "Sign in with your browser" → web magic-link sign-in in
 * Chromium → "Continue to the app" → the `oat://auth` link delivered to the app.
 */
export async function signInDesktop(
  app: ElectronApplication,
  page: Page,
  browser: Browser,
  email: string,
) {
  await page.getByRole('button', { name: 'Sign in with your browser' }).click();
  await expect(page.getByTestId('signing-in')).toBeVisible();
  const signInUrl = await waitForSignInUrl(app);
  const context = await browser.newContext();
  const web = await context.newPage();
  await web.goto(signInUrl);
  await signInOnWeb(web, email);
  const codeResponse = web.waitForResponse(
    (r) => r.url().endsWith('/api/auth/desktop/code') && r.request().method() === 'POST',
  );
  await web.getByRole('button', { name: 'Continue to the app' }).click();
  const { redirectUrl } = (await (await codeResponse).json()) as { redirectUrl: string };
  await context.close();
  await deliverDeepLink(app, redirectUrl);
  // The app, or first-run setup (9.2) when a suite turns it on (`OAT_ONBOARDING=auto`).
  await expect(
    page.getByTestId('signed-in-email').or(page.getByTestId('onboarding-account')),
  ).toHaveText(email);
}

/**
 * The calm shell (ui-calm-shell, ui-calm-note-surfaces) keeps a note's secondary surfaces behind one
 * control each. These reach them the way a user does; none of them changes what a spec asserts.
 */

/** No note open: Home (the active workspace's notes, "Coming up" when the calendar has events). */
export const home = (page: Page) => page.getByTestId('desktop-home');

/**
 * The open note's transcript panel, opened with its toggle in the bottom bar when it is closed (closed by
 * default; the choice is remembered per user). The player (3.7) and the transcript notices (2.7) live in it.
 */
export async function openTranscript(page: Page) {
  const toggle = page.getByTestId('transcript-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByTestId('transcript-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * The open note's attendees (desktop and web): the chips, "Add attendee" and the remove buttons are in a
 * popover behind the "N attendees" chip. Opens it when it is closed; `closeAttendees` puts it away again.
 */
export async function openAttendees(page: Page) {
  const details = page.getByTestId('participant-details');
  if (!(await details.isVisible())) await page.getByTestId('attendees-toggle').click();
  await expect(details).toBeVisible();
  return details;
}

export async function closeAttendees(page: Page) {
  const details = page.getByTestId('participant-details');
  if (await details.isVisible()) await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
}

/**
 * The sidebar's sync status (2.6): an icon whose accessible name (and tooltip) is the status line — "All
 * changes synced", "Offline — 3 changes saved on this Mac", …
 */
export const syncStatus = (page: Page) => page.getByTestId('sync-status');
